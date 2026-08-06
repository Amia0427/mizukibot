const fs = require('fs');
const path = require('path');
const { COVER_BASE_URL } = require('./source-client');

const MAX_COVER_BYTES = 8 * 1024 * 1024;

function createPjskCoverCache(options = {}) {
  const dir = path.resolve(String(options.dir || '').trim());
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!dir || typeof fetchImpl !== 'function') throw new Error('PJSK cover cache dependencies are required');
  fs.mkdirSync(dir, { recursive: true });

  async function get(song = {}) {
    const asset = String(song.assetbundleName || '').trim();
    if (!/^[a-z0-9_]+$/i.test(asset)) return null;
    const file = path.join(dir, `${asset}.png`);
    if (fs.existsSync(file)) return file;
    const url = `${COVER_BASE_URL}/${asset}.png`;
    const response = await fetchImpl(url, { headers: { 'User-Agent': 'MizukiBot-pjsk-cover' } });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_COVER_BYTES) return null;
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, buffer);
    await fs.promises.rename(temporary, file);
    return file;
  }

  return { dir, get };
}

module.exports = { MAX_COVER_BYTES, createPjskCoverCache };
