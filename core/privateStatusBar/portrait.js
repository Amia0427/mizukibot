const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMAGE_MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp']
]);

function parsePortraitImages(value) {
  const source = typeof value === 'string' ? JSON.parse(value) : value;
  const entries = Array.isArray(source)
    ? source.map((item) => [item?.min_affection, item?.url])
    : Object.entries(source || {});
  return entries
    .map(([threshold, url]) => ({ threshold: Number(threshold), url: String(url || '').trim() }))
    .filter((item) => Number.isFinite(item.threshold) && item.threshold >= 0 && item.threshold <= 100 && item.url)
    .sort((left, right) => left.threshold - right.threshold);
}

async function resolvePortraitImageSource(value, readFile = fs.promises.readFile) {
  const source = String(value || '').trim();
  if (!source || /^(?:https?):\/\//i.test(source)) return source;
  const filePath = path.resolve(source);
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES.get(extension);
  if (!mimeType) throw new Error('private status bar portrait format is unsupported');
  const buffer = await readFile(filePath);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('private status bar portrait is empty');
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function optimizePortraitImageSource(source, options = {}) {
  const value = String(source || '').trim();
  if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(value)) return value;
  const encoded = value.slice(value.indexOf(',') + 1).replace(/\s+/g, '');
  const buffer = Buffer.from(encoded, 'base64');
  const width = Math.max(160, Number(options.width) || 560);
  const height = Math.max(160, Number(options.height) || 560);
  const output = await (options.sharpFactory || sharp)(buffer)
    .rotate()
    .resize(width, height, { fit: 'cover' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${output.toString('base64')}`;
}

function selectPortraitImage(value, affection) {
  const images = parsePortraitImages(value);
  const score = Number(affection) || 0;
  return images.reduce(
    (selected, image) => (image.threshold <= score ? image.url : selected),
    images[0]?.url || ''
  );
}

module.exports = {
  parsePortraitImages,
  optimizePortraitImageSource,
  resolvePortraitImageSource,
  selectPortraitImage
};
