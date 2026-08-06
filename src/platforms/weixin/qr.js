const QRCode = require('qrcode');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_QR_IMAGE_BYTES = 2 * 1024 * 1024;

function decodeImageData(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:data:image\/png;base64,|base64:\/\/)([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_QR_IMAGE_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Weixin QR image must be a PNG no larger than 2 MiB');
  }
  return buffer;
}

async function renderWeixinQrPng(value) {
  const directImage = decodeImageData(value);
  if (directImage) return directImage;
  const content = String(value || '').trim();
  if (!content) throw new TypeError('Weixin QR content is required');
  return QRCode.toBuffer(content, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 360
  });
}

module.exports = {
  renderWeixinQrPng
};
