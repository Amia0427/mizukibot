const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createMemeStoreFileHelpers(deps = {}) {
  const {
    config,
    nowTs
  } = deps;

  function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  function atomicWriteJson(targetFile, data) {
    const tempFile = `${targetFile}.${process.pid}.tmp`;
    const text = JSON.stringify(data, null, 2);
    try {
      fs.writeFileSync(tempFile, text, 'utf8');
      fs.renameSync(tempFile, targetFile);
    } catch (error) {
      try {
        fs.writeFileSync(targetFile, text, 'utf8');
      } finally {
        try {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        } catch (_) {}
      }
      if (error?.code !== 'EPERM') throw error;
    }
  }

  function safeReadJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      console.error('[meme-manager] failed to read store json:', {
        filePath,
        error: error?.message || String(error)
      });
      return fallback;
    }
  }

  function getCategoryDir(categoryName) {
    return path.join(config.MEME_MANAGER_ASSET_DIR, categoryName);
  }

  function getCategoryAssetPath(categoryName, fileName) {
    return path.join(getCategoryDir(categoryName), String(fileName || '').trim());
  }

  function inferMimeFromExt(fileName = '') {
    const ext = path.extname(String(fileName || '').trim()).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
  }

  function buildAssetId() {
    return `m_${nowTs()}_${crypto.randomBytes(3).toString('hex')}`;
  }

  function buildFileName(assetId, ext) {
    return `${assetId}${ext.toLowerCase()}`;
  }

  return {
    ensureDir,
    atomicWriteJson,
    safeReadJson,
    getCategoryDir,
    getCategoryAssetPath,
    inferMimeFromExt,
    buildAssetId,
    buildFileName
  };
}

module.exports = {
  createMemeStoreFileHelpers
};
