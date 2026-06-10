const DEFAULT_IMAGE_EXTENSION = '.png';

function normalizeBase64ImageData(value = '') {
  return String(value || '').replace(/\s+/g, '').trim();
}

function detectImageExtension(buffer = Buffer.alloc(0), fallback = DEFAULT_IMAGE_EXTENSION, mimeType = '') {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';

  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return fallback;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (
    buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) return '.webp';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif';
  return fallback;
}

function detectImageKind(buffer = Buffer.alloc(0), mimeType = '') {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (Buffer.isBuffer(buffer) && buffer.length >= 12) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (
      buffer[0] === 0x52
      && buffer[1] === 0x49
      && buffer[2] === 0x46
      && buffer[3] === 0x46
      && buffer[8] === 0x57
      && buffer[9] === 0x45
      && buffer[10] === 0x42
      && buffer[11] === 0x50
    ) return 'webp';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  } else if (Buffer.isBuffer(buffer) && buffer.length >= 3) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
  }

  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpeg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'unknown';
}

function validatePngBuffer(buffer = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return 'png shorter than minimal valid structure';
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return 'png signature mismatch';

  let offset = 8;
  let sawIHDR = false;
  let sawIEND = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return 'png chunk header truncated';
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const chunkEnd = offset + 12 + chunkLength;
    if (!/^[A-Za-z]{4}$/.test(chunkType)) return 'png chunk type invalid';
    if (chunkEnd > buffer.length) return `png chunk ${chunkType} truncated`;

    if (chunkType === 'IHDR') {
      sawIHDR = true;
      if (chunkLength !== 13) return 'png IHDR length invalid';
    }
    if (chunkType === 'IEND') {
      sawIEND = true;
      if (chunkLength !== 0) return 'png IEND length invalid';
      if (chunkEnd !== buffer.length) return 'png has trailing bytes after IEND';
      break;
    }

    offset = chunkEnd;
  }

  if (!sawIHDR) return 'png missing IHDR';
  if (!sawIEND) return 'png missing IEND';
  return '';
}

function validateJpegBuffer(buffer = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'jpeg shorter than minimal valid structure';
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) return 'jpeg start marker missing';
  if (!(buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9)) return 'jpeg end marker missing';
  return '';
}

function validateGifBuffer(buffer = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) return 'gif shorter than minimal valid structure';
  const header = buffer.subarray(0, 6).toString('ascii');
  if (!(header === 'GIF87a' || header === 'GIF89a')) return 'gif signature mismatch';
  if (buffer[buffer.length - 1] !== 0x3b) return 'gif trailer missing';
  return '';
}

function validateWebpBuffer(buffer = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'webp shorter than minimal valid structure';
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return 'webp RIFF signature missing';
  if (buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return 'webp signature mismatch';

  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (declaredSize > buffer.length) return 'webp container truncated';
  return '';
}

function validateImageBuffer(buffer = Buffer.alloc(0), mimeType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('image buffer empty');
  }

  const kind = detectImageKind(buffer, mimeType);
  let reason = '';
  if (kind === 'png') reason = validatePngBuffer(buffer);
  else if (kind === 'jpeg') reason = validateJpegBuffer(buffer);
  else if (kind === 'gif') reason = validateGifBuffer(buffer);
  else if (kind === 'webp') reason = validateWebpBuffer(buffer);
  else reason = 'unrecognized image signature';

  if (reason) {
    const error = new Error(`image buffer invalid or truncated format=${kind} reason=${reason}`);
    error.imageFormat = kind;
    throw error;
  }

  return { kind };
}

module.exports = {
  DEFAULT_IMAGE_EXTENSION,
  detectImageExtension,
  detectImageKind,
  normalizeBase64ImageData,
  validateGifBuffer,
  validateImageBuffer,
  validateJpegBuffer,
  validatePngBuffer,
  validateWebpBuffer
};
