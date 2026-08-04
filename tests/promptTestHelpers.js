const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempPromptsDir(rootDir = path.join(__dirname, '..')) {
  const source = path.join(rootDir, 'prompts');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-prompts-'));
  const target = path.join(tempRoot, 'prompts');
  fs.cpSync(source, target, { recursive: true });
  for (const entry of fs.readdirSync(target, { recursive: true })) {
    const filePath = path.join(target, entry);
    if (fs.statSync(filePath).isFile()) fs.chmodSync(filePath, 0o666);
  }
  return {
    promptsDir: target,
    cleanup() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };
}

module.exports = {
  createTempPromptsDir
};
