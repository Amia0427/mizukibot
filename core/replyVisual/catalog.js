const fs = require('fs');
const path = require('path');

const SUPPORTED_EMOTIONS = new Set([
  'neutral',
  'happy',
  'affectionate',
  'playful',
  'shy',
  'sad',
  'angry',
  'surprised',
  'tired',
  'comforting'
]);

function resolveConfiguredPath(value, projectRoot = process.cwd()) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function readEmotionManifest(filePath, fsImpl = fs) {
  if (!filePath || !fsImpl.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function createLive2dCatalog(options = {}) {
  const runtimeConfig = options.config || {};
  const fsImpl = options.fsImpl || fs;
  const projectRoot = options.projectRoot || process.cwd();
  const manifestPath = resolveConfiguredPath(
    options.manifestPath || runtimeConfig.LIVE2D_EMOTION_MANIFEST,
    projectRoot
  );
  const modelDir = resolveConfiguredPath(runtimeConfig.LIVE2D_MODEL_DIR, projectRoot);
  const manifest = options.manifest || readEmotionManifest(manifestPath, fsImpl);

  function get(emotion = '') {
    const normalizedEmotion = String(emotion || '').trim().toLowerCase();
    if (!SUPPORTED_EMOTIONS.has(normalizedEmotion)) {
      return { ok: false, reason: 'unsupported_emotion' };
    }
    const entry = manifest[normalizedEmotion];
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'missing_mapping' };
    const fallbackPath = resolveConfiguredPath(entry.fallback, projectRoot);
    return {
      ok: Boolean(entry.animation || (fallbackPath && fsImpl.existsSync(fallbackPath))),
      reason: entry.animation || fallbackPath ? '' : 'missing_resource',
      emotion: normalizedEmotion,
      animation: String(entry.animation || '').trim(),
      fallbackPath: fallbackPath && fsImpl.existsSync(fallbackPath) ? fallbackPath : '',
      modelDir
    };
  }

  return { get, manifestPath, modelDir };
}

module.exports = {
  SUPPORTED_EMOTIONS,
  createLive2dCatalog,
  readEmotionManifest,
  resolveConfiguredPath
};
