'use strict';

const assert = require('assert');
const fs = require('fs');

function snapshotProperties(target, names) {
  return new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(target, name)]));
}

function restoreProperties(target, snapshot) {
  for (const [name, descriptor] of snapshot) {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else delete target[name];
  }
}

function snapshotCacheEntry(modulePath) {
  return {
    exists: Object.prototype.hasOwnProperty.call(require.cache, modulePath),
    value: require.cache[modulePath]
  };
}

function restoreCacheEntry(modulePath, snapshot) {
  if (snapshot.exists) require.cache[modulePath] = snapshot.value;
  else delete require.cache[modulePath];
}

function testRuntimeStoreLiveBinding() {
  const config = require('../config');
  const runtimeState = require('../src/features/meme/runtime-state');
  const selectorRuntime = require('../src/features/meme/selector-runtime');
  const configSnapshot = snapshotProperties(config, ['MEME_MANAGER_RUNTIME_FILE']);
  const fsSnapshot = snapshotProperties(fs, ['existsSync', 'readFileSync']);
  const runtimeFile = 'virtual-meme-runtime.json';

  try {
    config.MEME_MANAGER_RUNTIME_FILE = runtimeFile;
    fs.existsSync = (filePath) => (
      filePath === runtimeFile ? true : fsSnapshot.get('existsSync').value.call(fs, filePath)
    );
    fs.readFileSync = (filePath, ...args) => {
      if (filePath === runtimeFile) {
        return JSON.stringify({
          groups: {},
          assets: {
            'live-probe': { sentCount: 7, lastSentAt: 123 }
          }
        });
      }
      return fsSnapshot.get('readFileSync').value.call(fs, filePath, ...args);
    };

    const previousStore = runtimeState.runtimeStoreCache;
    runtimeState.loadRuntimeStore();

    assert.notStrictEqual(runtimeState.runtimeStoreCache, previousStore);
    assert.deepStrictEqual(selectorRuntime.getAssetGlobalUsage('live-probe'), {
      sentCount: 7,
      lastSentAt: 123
    });
  } finally {
    restoreProperties(fs, fsSnapshot);
    restoreProperties(config, configSnapshot);
  }
}

async function testModelTransportMonkeyPatch() {
  const config = require('../config');
  const httpClient = require('../api/httpClient');
  const memeStore = require('../utils/memeStore');
  const selectorRuntime = require('../src/features/meme/selector-runtime');
  const assetAnalysisRuntime = require('../src/features/meme/asset-analysis-runtime');
  const configSnapshot = snapshotProperties(config, [
    'AI_ROUTER_BASE_URL',
    'AI_ROUTER_MODEL',
    'IMAGE_API_BASE_URL',
    'IMAGE_MODEL',
    'MEME_MANAGER_ASSET_ANALYSIS_ENABLED'
  ]);
  const httpSnapshot = snapshotProperties(httpClient, ['postWithRetry']);
  const fsSnapshot = snapshotProperties(fs, ['existsSync', 'readFileSync']);
  const storeSnapshot = snapshotProperties(memeStore, [
    'getAsset',
    'getAssetAbsolutePath',
    'normalizeAssetAnalysisPayload'
  ]);
  let selectorCalls = 0;
  let analysisCalls = 0;

  try {
    config.AI_ROUTER_BASE_URL = 'https://example.test/v1';
    config.AI_ROUTER_MODEL = 'selector-probe';
    httpClient.postWithRetry = async () => {
      selectorCalls += 1;
      return {
        data: {
          choices: [{
            message: {
              content: '{"send":false,"mood":"none","intensity":"low","confidence":1,"reason":"probe"}'
            }
          }]
        }
      };
    };

    const selectionResult = await selectorRuntime.runSelector({
      surface: 'direct',
      routePolicyKey: 'chat/default',
      topRouteType: 'chat',
      userText: 'probe',
      replyText: 'probe',
      quoteText: '',
      recentTurns: [],
      replyMeta: {},
      passiveContext: {},
      categories: []
    });
    assert.strictEqual(selectorCalls, 1);
    assert.strictEqual(selectionResult.parsed.send, false);

    config.MEME_MANAGER_ASSET_ANALYSIS_ENABLED = true;
    config.IMAGE_API_BASE_URL = 'https://example.test/v1';
    config.IMAGE_MODEL = 'asset-probe';
    memeStore.getAsset = () => ({ id: 'asset-1', mime: 'image/png' });
    memeStore.getAssetAbsolutePath = () => 'virtual-asset.png';
    memeStore.normalizeAssetAnalysisPayload = (value) => value;
    fs.existsSync = (filePath) => (
      filePath === 'virtual-asset.png' ? true : fsSnapshot.get('existsSync').value.call(fs, filePath)
    );
    fs.readFileSync = (filePath, ...args) => (
      filePath === 'virtual-asset.png'
        ? Buffer.from('image')
        : fsSnapshot.get('readFileSync').value.call(fs, filePath, ...args)
    );
    httpClient.postWithRetry = async () => {
      analysisCalls += 1;
      return {
        data: {
          choices: [{ message: { content: '{"summary":"ok"}' } }]
        }
      };
    };

    const analysisResult = await assetAnalysisRuntime.analyzeMemeAsset({
      categoryName: 'test',
      assetId: 'asset-1'
    });
    assert.strictEqual(analysisCalls, 1);
    assert.strictEqual(analysisResult.model, 'asset-probe');
    assert.strictEqual(analysisResult.parsed.summary, 'ok');
  } finally {
    restoreProperties(memeStore, storeSnapshot);
    restoreProperties(fs, fsSnapshot);
    restoreProperties(httpClient, httpSnapshot);
    restoreProperties(config, configSnapshot);
  }
}

async function testAxiosMonkeyPatch() {
  const axios = require('axios');
  const memeStore = require('../utils/memeStore');
  const networkSafetyPath = require.resolve('../utils/networkSafety');
  const assetAnalysisPath = require.resolve('../src/features/meme/asset-analysis-runtime');
  const adminRuntimePath = require.resolve('../src/features/meme/admin-runtime');
  const networkSafetySnapshot = snapshotCacheEntry(networkSafetyPath);
  const assetAnalysisSnapshot = snapshotCacheEntry(assetAnalysisPath);
  const adminRuntimeSnapshot = snapshotCacheEntry(adminRuntimePath);
  const axiosSnapshot = snapshotProperties(axios, ['get']);
  const storeSnapshot = snapshotProperties(memeStore, [
    'importAsset',
    'inferMimeFromExt',
    'updateAssetAnalysis'
  ]);
  let axiosCalls = 0;

  try {
    require.cache[networkSafetyPath] = {
      id: networkSafetyPath,
      filename: networkSafetyPath,
      loaded: true,
      exports: { assertSafeHttpUrl: async () => {} }
    };
    require.cache[assetAnalysisPath] = {
      id: assetAnalysisPath,
      filename: assetAnalysisPath,
      loaded: true,
      exports: {
        analyzeMemeAsset: async () => ({ model: 'asset-probe', parsed: {} }),
        resolveAssetAnalysis: () => ({ resolved: {} })
      }
    };
    delete require.cache[adminRuntimePath];
    const adminRuntime = require(adminRuntimePath);

    axios.get = async () => {
      axiosCalls += 1;
      return {
        data: Buffer.from('image'),
        headers: { 'content-type': 'image/png' }
      };
    };
    memeStore.importAsset = () => ({ id: 'asset-1', size: 5 });
    memeStore.inferMimeFromExt = () => 'image/png';
    memeStore.updateAssetAnalysis = () => {};

    adminRuntime.startUploadSession({
      groupId: 'group-1',
      userId: 'user-1',
      categoryName: 'test'
    });
    const result = await adminRuntime.consumePendingUploadFromMessage({
      post_type: 'message',
      message_type: 'group',
      group_id: 'group-1',
      user_id: 'user-1',
      raw_message: '[CQ:image,file=x,url=https://example.test/image.png]'
    });

    assert.strictEqual(axiosCalls, 1);
    assert.strictEqual(result.consumed, true);
    assert.match(result.replyText, /已导入 test: asset-1/);
  } finally {
    restoreProperties(memeStore, storeSnapshot);
    restoreProperties(axios, axiosSnapshot);
    restoreCacheEntry(adminRuntimePath, adminRuntimeSnapshot);
    restoreCacheEntry(assetAnalysisPath, assetAnalysisSnapshot);
    restoreCacheEntry(networkSafetyPath, networkSafetySnapshot);
  }
}

(async () => {
  testRuntimeStoreLiveBinding();
  await testModelTransportMonkeyPatch();
  await testAxiosMonkeyPatch();
  console.log('memeManagerMonkeyPatch.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
