const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  createWeixinMediaLoader,
  createWeixinMediaUploader,
  cleanupWeixinMediaCache,
  decryptAesEcb,
  encryptAesEcb,
  extractTextFile,
  sanitizeFileName
} = require('../src/platforms/weixin/media');

function binaryResponse(buffer, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    statusText: options.statusText || 'OK',
    headers: new Headers(options.headers || {}),
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    async text() {
      return buffer.toString('utf8');
    }
  };
}

(async () => {
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.from('private image bytes');
  const ciphertext = encryptAesEcb(plaintext, key);
  assert.deepStrictEqual(decryptAesEcb(ciphertext, key), plaintext);

  const urls = [];
  const loader = createWeixinMediaLoader({
    cdnBaseUrl: 'https://cdn.example',
    fetch: async (url) => {
      urls.push(url);
      return binaryResponse(ciphertext);
    }
  });
  const image = await loader({
    type: 2,
    image_item: {
      media: {
        encrypt_query_param: 'a/b?c',
        aes_key: key.toString('base64')
      }
    }
  });

  assert.strictEqual(urls[0], 'https://cdn.example/download?encrypted_query_param=a%2Fb%3Fc');
  assert.strictEqual(image.kind, 'image');
  assert.deepStrictEqual(image.buffer, plaintext);
  assert.strictEqual(image.sha256, crypto.createHash('sha256').update(plaintext).digest('hex'));

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-media-'));
  try {
    const cachedLoader = createWeixinMediaLoader({
      cacheDir,
      fetch: async () => binaryResponse(ciphertext)
    });
    const cached = await cachedLoader({
      type: 2,
      image_item: { media: { full_url: 'https://cdn.example/image', aes_key: key.toString('base64') } }
    });
    assert.strictEqual(Buffer.isBuffer(cached.buffer), false);
    assert.strictEqual(fs.readFileSync(cached.path).toString('utf8'), plaintext.toString('utf8'));
    fs.utimesSync(cached.path, new Date(0), new Date(0));
    assert.deepStrictEqual(await cleanupWeixinMediaCache({
      cacheDir,
      maxAgeMs: 60_000,
      now: () => 120_000
    }), { removed: 1 });
    assert.strictEqual(fs.existsSync(cached.path), false);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  const hexEncodedKey = Buffer.from(key.toString('hex'), 'ascii').toString('base64');
  const fileLoader = createWeixinMediaLoader({
    cdnBaseUrl: 'https://cdn.example',
    fetch: async () => binaryResponse(ciphertext)
  });
  const file = await fileLoader({
    type: 4,
    file_item: {
      file_name: '../notes.txt',
      len: String(plaintext.length),
      media: { full_url: 'https://safe-cdn.example/file', aes_key: hexEncodedKey }
    }
  });
  assert.strictEqual(file.kind, 'file');
  assert.strictEqual(file.name, 'notes.txt');
  assert.strictEqual(file.text, 'private image bytes');
  assert.strictEqual(file.binary, false);
  assert.strictEqual(file.mimeType, 'text/plain');

  assert.deepStrictEqual(extractTextFile(Buffer.from(`x${'a'.repeat(MAX_TEXT_CHARS)}`), 'large.log'), {
    binary: false,
    text: `x${'a'.repeat(MAX_TEXT_CHARS - 1)}`,
    truncated: true
  });
  assert.deepStrictEqual(extractTextFile(Buffer.from([0x61, 0x00, 0x62]), 'bad.txt'), {
    binary: true,
    text: '',
    truncated: false
  });
  assert.strictEqual(sanitizeFileName('..\\..\\secret.json'), 'secret.json');

  let oversizedFetches = 0;
  const rejectingLoader = createWeixinMediaLoader({
    fetch: async () => {
      oversizedFetches += 1;
      return binaryResponse(Buffer.alloc(0));
    }
  });
  await assert.rejects(
    rejectingLoader({
      type: 4,
      file_item: {
        file_name: 'large.bin',
        len: String(MAX_FILE_BYTES + 1),
        media: { full_url: 'https://cdn.example/large', aes_key: key.toString('base64') }
      }
    }),
    /20 MiB/
  );
  assert.strictEqual(oversizedFetches, 0, 'declared oversized files must be rejected before download');

  const uploadCalls = [];
  const uploadFile = path.resolve('D:\\waifu\\data\\weixin-media\\reply.txt');
  const missingUploadRoot = path.resolve('D:\\waifu\\data\\create-agent\\output');
  const uploader = createWeixinMediaUploader({
    allowedRoots: [missingUploadRoot, path.resolve('D:\\waifu\\data\\weixin-media')],
    cdnBaseUrl: 'https://cdn.example',
    fetch: async (url, init) => {
      uploadCalls.push(['fetch', url, init]);
      return binaryResponse(Buffer.alloc(0), { headers: { 'x-encrypted-param': 'download-token' } });
    },
    ilinkClient: {
      async getUploadUrl(input) {
        uploadCalls.push(['getUploadUrl', input]);
        return { upload_param: 'upload-token' };
      }
    },
    randomBytes: () => Buffer.alloc(16, 7),
    readFile: async () => Buffer.from('outbound text'),
    realpath: async (value) => {
      if (path.resolve(value) === missingUploadRoot) {
        const error = new Error('missing output root');
        error.code = 'ENOENT';
        throw error;
      }
      return path.resolve(value);
    }
  });
  const uploaded = await uploader({ filePath: uploadFile, kind: 'file', toUserId: 'wx-user' });
  assert.strictEqual(uploadCalls[0][0], 'getUploadUrl');
  assert.strictEqual(uploadCalls[0][1].media_type, 3);
  assert.strictEqual(uploadCalls[0][1].to_user_id, 'wx-user');
  assert.strictEqual(uploadCalls[1][1], 'https://cdn.example/upload?encrypted_query_param=upload-token&filekey=07070707070707070707070707070707');
  assert.strictEqual(uploadCalls[1][2].method, 'POST');
  assert.strictEqual(uploadCalls[1][2].body.length % 16, 0);
  assert.strictEqual(uploaded.downloadEncryptedQueryParam, 'download-token');
  assert.strictEqual(uploaded.messageItem.type, 4);
  assert.strictEqual(uploaded.messageItem.file_item.file_name, 'reply.txt');
  assert.strictEqual(uploaded.messageItem.file_item.len, String(Buffer.byteLength('outbound text')));

  let unsafeReads = 0;
  const restrictedUploader = createWeixinMediaUploader({
    allowedRoots: [path.resolve('D:\\waifu\\data\\weixin-media')],
    fetch: async () => binaryResponse(Buffer.alloc(0)),
    ilinkClient: { getUploadUrl: async () => ({}) },
    readFile: async () => {
      unsafeReads += 1;
      return Buffer.alloc(0);
    },
    realpath: async (value) => path.resolve(value)
  });
  await assert.rejects(
    restrictedUploader({
      filePath: path.resolve('D:\\waifu\\prompts\\SYSTEM.txt'),
      kind: 'file',
      toUserId: 'wx-user'
    }),
    /allowed outbound directories/
  );
  assert.strictEqual(unsafeReads, 0);

  console.log('weixinMedia.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
