const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const { TextDecoder } = require('util');

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 32_000;
const TEXT_EXTENSIONS = new Set(['.csv', '.json', '.log', '.md', '.txt']);
const MIME_TYPES = Object.freeze({
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp'
});

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseAesKey(value) {
  const decoded = Buffer.from(String(value || ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error('Weixin media AES key must contain 16 bytes');
}

function sanitizeFileName(value) {
  const normalized = String(value || 'file.bin').replace(/\\/g, '/');
  const name = path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name || 'file.bin';
}

function mimeFromFilename(fileName) {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function extractTextFile(buffer, fileName) {
  if (!TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase()) || buffer.includes(0)) {
    return { binary: true, text: '', truncated: false };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    return { binary: true, text: '', truncated: false };
  }
  return {
    binary: false,
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS
  };
}

function buildDownloadUrl(media, cdnBaseUrl) {
  if (media.full_url) return media.full_url;
  if (!media.encrypt_query_param || !cdnBaseUrl) {
    throw new Error('Weixin media download URL is missing');
  }
  const base = String(cdnBaseUrl).replace(/\/$/, '');
  return `${base}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
}

function declaredFileSize(item) {
  const value = Number(item.file_item?.len || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function resolveMediaItem(item) {
  if (item.type === 2 && item.image_item?.media) {
    const aesKey = item.image_item.aeskey
      ? Buffer.from(item.image_item.aeskey, 'hex')
      : parseAesKey(item.image_item.media.aes_key);
    return { kind: 'image', media: item.image_item.media, aesKey, name: '' };
  }
  if (item.type === 4 && item.file_item?.media) {
    return {
      kind: 'file',
      media: item.file_item.media,
      aesKey: parseAesKey(item.file_item.media.aes_key),
      name: sanitizeFileName(item.file_item.file_name)
    };
  }
  return null;
}

function createWeixinMediaLoader(options) {
  const fetchImpl = options.fetch;
  const maxBytes = options.maxBytes || MAX_FILE_BYTES;
  const cdnBaseUrl = options.cdnBaseUrl || '';
  const cacheDir = String(options.cacheDir || '').trim();

  return async function loadMedia(item) {
    const size = declaredFileSize(item);
    if (size > maxBytes) throw new Error('Weixin file exceeds the 20 MiB limit');

    const resolved = resolveMediaItem(item);
    if (!resolved) return null;
    const response = await fetchImpl(buildDownloadUrl(resolved.media, cdnBaseUrl));
    if (!response.ok) {
      throw new Error(`Weixin CDN download failed: ${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers?.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error('Weixin file exceeds the 20 MiB limit');
    const ciphertext = Buffer.from(await response.arrayBuffer());
    if (ciphertext.length > maxBytes + 16) throw new Error('Weixin file exceeds the 20 MiB limit');

    const buffer = decryptAesEcb(ciphertext, resolved.aesKey);
    if (buffer.length > maxBytes) throw new Error('Weixin file exceeds the 20 MiB limit');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const attachment = {
      kind: resolved.kind,
      name: resolved.name,
      mimeType: resolved.kind === 'file' ? mimeFromFilename(resolved.name) : 'application/octet-stream',
      size: buffer.length,
      sha256
    };
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
      const extension = resolved.kind === 'file'
        ? path.extname(resolved.name).toLowerCase()
        : '.img';
      const filePath = path.join(cacheDir, `${sha256}${extension}`);
      try {
        await fs.writeFile(filePath, buffer, { flag: 'wx' });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      attachment.url = filePath;
      attachment.path = filePath;
    } else {
      attachment.buffer = buffer;
    }
    if (resolved.kind === 'file') Object.assign(attachment, extractTextFile(buffer, resolved.name));
    return attachment;
  };
}

async function cleanupWeixinMediaCache(options = {}) {
  const cacheDir = String(options.cacheDir || '').trim();
  if (!cacheDir) return { removed: 0 };
  const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs || 24 * 60 * 60_000) || 24 * 60 * 60_000);
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  let entries;
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(cacheDir, entry.name);
    const stat = await fs.stat(filePath);
    if (now - stat.mtimeMs <= maxAgeMs) continue;
    await fs.unlink(filePath);
    removed += 1;
  }
  return { removed };
}

function isWithinRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function buildUploadUrl(response, cdnBaseUrl, filekey) {
  if (response.upload_full_url?.trim()) return response.upload_full_url.trim();
  if (!response.upload_param || !cdnBaseUrl) throw new Error('Weixin CDN upload URL is missing');
  const base = String(cdnBaseUrl).replace(/\/$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
}

function buildOutboundMessageItem(kind, name, uploaded) {
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aesKeyHex, 'ascii').toString('base64'),
    encrypt_type: 1
  };
  if (kind === 'image') {
    return {
      type: 2,
      image_item: {
        media,
        mid_size: uploaded.ciphertextSize
      }
    };
  }
  if (kind === 'voice') {
    const voice = uploaded.voice || {};
    return {
      type: 3,
      voice_item: {
        media,
        encode_type: Number(voice.encodeType || 6),
        playtime: Math.max(0, Number(voice.playTimeMs || 0) || 0),
        bits_per_sample: Number(voice.bitsPerSample || 16),
        sample_rate: Number(voice.sampleRate || 16000),
        size: uploaded.rawSize
      }
    };
  }
  return {
    type: 4,
    file_item: {
      media,
      file_name: name,
      len: String(uploaded.rawSize)
    }
  };
}

function createWeixinMediaUploader(options) {
  const fetchImpl = options.fetch;
  const readFile = options.readFile || fs.readFile;
  const realpath = options.realpath || fs.realpath;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const allowedRoots = options.allowedRoots || [];
  const maxBytes = options.maxBytes || MAX_FILE_BYTES;

  return async function uploadMedia(input) {
    const filePath = await realpath(input.filePath);
    const roots = (await Promise.all(allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    }))).filter(Boolean);
    if (!roots.some((root) => isWithinRoot(filePath, root))) {
      throw new Error('Weixin media path is outside allowed outbound directories');
    }

    const plaintext = await readFile(filePath);
    if (plaintext.length > maxBytes) throw new Error('Weixin file exceeds the 20 MiB limit');

    const kind = ['image', 'voice'].includes(input.kind) ? input.kind : 'file';
    const mediaType = kind === 'image' ? 1 : kind === 'voice' ? 4 : 3;
    const filekey = randomBytes(16).toString('hex');
    const aesKey = randomBytes(16);
    const ciphertext = encryptAesEcb(plaintext, aesKey);
    const uploadResponse = await options.ilinkClient.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: input.toUserId,
      rawsize: plaintext.length,
      rawfilemd5: crypto.createHash('md5').update(plaintext).digest('hex'),
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: aesKey.toString('hex')
    });
    const response = await fetchImpl(buildUploadUrl(uploadResponse, options.cdnBaseUrl, filekey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext)
    });
    if (!response.ok) {
      throw new Error(`Weixin CDN upload failed: ${response.status} ${response.statusText}`);
    }
    const downloadEncryptedQueryParam = response.headers.get('x-encrypted-param');
    if (!downloadEncryptedQueryParam) throw new Error('Weixin CDN upload response is missing x-encrypted-param');

    const name = sanitizeFileName(input.fileName || path.basename(filePath));
    const uploaded = {
      filekey,
      aesKeyHex: aesKey.toString('hex'),
      rawSize: plaintext.length,
      ciphertextSize: ciphertext.length,
      downloadEncryptedQueryParam,
      voice: input.voice
    };
    return {
      ...uploaded,
      kind,
      name,
      mimeType: normalizeMimeType(input.mimeType) || mimeFromFilename(name),
      messageItem: buildOutboundMessageItem(kind, name, uploaded)
    };
  };
}

function createFfmpegNativeVoiceEncoder(options = {}) {
  const ffmpegPath = String(options.ffmpegPath || 'ffmpeg').trim() || 'ffmpeg';
  const run = options.execFile || execFileAsync;

  return async function encodeNativeVoice(input = {}) {
    const inputPath = String(input.inputPath || '').trim();
    const outputPath = String(input.outputPath || '').trim();
    if (!inputPath || !outputPath) throw new Error('native voice encoder paths are required');
    await run(ffmpegPath, [
      '-y',
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'libsilk',
      outputPath
    ], { windowsHide: true });
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size === 0) throw new Error('ffmpeg produced no native voice audio');
    return {
      filePath: outputPath,
      fileName: sanitizeFileName(input.fileName || 'voice.silk'),
      mimeType: 'audio/silk',
      encodeType: 6,
      sampleRate: 16000,
      bitsPerSample: 16,
      playTimeMs: Number(input.playTimeMs || 0) || 0
    };
  };
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

async function cleanupWeixinVoiceSpool(options = {}) {
  const spoolDir = String(options.spoolDir || '').trim();
  if (!spoolDir) return { removed: 0 };
  const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs || 24 * 60 * 60_000) || 24 * 60 * 60_000);
  const now = Number(typeof options.now === 'function' ? options.now() : Date.now());
  let entries;
  try {
    entries = await fs.readdir(spoolDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(spoolDir, entry.name);
    const stat = await fs.stat(filePath);
    if (now - stat.mtimeMs <= maxAgeMs) continue;
    await fs.unlink(filePath);
    removed += 1;
  }
  return { removed };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  cleanupWeixinMediaCache,
  createWeixinMediaLoader,
  createWeixinMediaUploader,
  cleanupWeixinVoiceSpool,
  createFfmpegNativeVoiceEncoder,
  decryptAesEcb,
  encryptAesEcb,
  extractTextFile,
  mimeFromFilename,
  parseAesKey,
  sanitizeFileName
};
