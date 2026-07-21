'use strict';

const assert = require('assert');

const chunkedModulePath = require.resolve('../src/shared/chunkedModule');
const { runCommonJsChunks } = require(chunkedModulePath);
const dailySharePath = require.resolve('../src/features/daily-share');
const coreFacadePath = require.resolve('../core/dailyShareEngine');

module.exports = (() => {
  const originalChunkedModule = require.cache[chunkedModulePath];
  delete require.cache[dailySharePath];
  delete require.cache[coreFacadePath];
  require.cache[chunkedModulePath] = {
    id: chunkedModulePath,
    filename: chunkedModulePath,
    loaded: true,
    exports: {
      runCommonJsChunks(baseDir, ownerModule, chunkFiles, options) {
        if (chunkFiles.some((file) => file.startsWith('dailyShareEngine.'))) {
          throw new Error('daily-share must not execute chunk loader');
        }
        return runCommonJsChunks(baseDir, ownerModule, chunkFiles, options);
      }
    }
  };

  try {
    const dailyShare = require('../src/features/daily-share');
    const coreFacade = require('../core/dailyShareEngine');
    assert.strictEqual(typeof dailyShare.createDailyShareEngine, 'function');
    assert.strictEqual(typeof dailyShare.getDailyShareEngine, 'function');
    assert.strictEqual(coreFacade.createDailyShareEngine, dailyShare.createDailyShareEngine);
    assert.strictEqual(coreFacade.getDailyShareEngine, dailyShare.getDailyShareEngine);
  } finally {
    delete require.cache[dailySharePath];
    delete require.cache[coreFacadePath];
    if (originalChunkedModule) require.cache[chunkedModulePath] = originalChunkedModule;
    else delete require.cache[chunkedModulePath];
  }

  console.log('dailyShareModuleBoundary.test.js passed');
})();
