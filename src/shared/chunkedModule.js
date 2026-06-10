const fs = require('fs');
const path = require('path');
function runCommonJsChunks(baseDir, targetModule, chunkFiles, options = {}) {
  const localRequire = typeof options.require === 'function' ? options.require : require;
  const source = chunkFiles
    .map((chunkFile) => {
      const chunkPath = path.join(baseDir, chunkFile);
      return `\n// <chunk:${chunkFile}>\n${fs.readFileSync(chunkPath, 'utf8')}\n// </chunk:${chunkFile}>\n`;
    })
    .join('\n');

  const run = new Function('require', 'module', 'exports', '__dirname', '__filename', source);
  run(localRequire, targetModule, targetModule.exports, baseDir, options.filename || path.join(baseDir, 'index.js'));

  return targetModule.exports;
}

module.exports = { runCommonJsChunks };
