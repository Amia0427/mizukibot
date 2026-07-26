const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const checkScript = path.join(projectRoot, 'scripts', 'check-prompts.js');

function copyTrackedPrompts(targetDir) {
  const trackedFiles = execFileSync(
    'git',
    ['-C', projectRoot, 'ls-files', '-z', '--', 'prompts'],
    { encoding: 'utf8' }
  ).split('\0').filter(Boolean);

  for (const repositoryPath of trackedFiles) {
    const relativePath = repositoryPath.replace(/^prompts[\\/]/, '');
    const targetPath = path.join(targetDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, repositoryPath), targetPath);
  }
}

function runPromptCheck(promptsDir, assetMode) {
  const dataDir = path.join(path.dirname(promptsDir), `data-${assetMode}`);
  const result = spawnSync(process.execPath, [checkScript], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_PROMPT_EXTRA_ROOTS: '',
      DATA_DIR: dataDir,
      PROMPTS_DIR: promptsDir,
      PROMPT_CHECK_ASSET_MODE: assetMode
    }
  });
  return {
    code: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`
  };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-check-prompts-'));
const promptsDir = path.join(tempRoot, 'prompts');

try {
  copyTrackedPrompts(promptsDir);

  const cleanCheckout = runPromptCheck(promptsDir, 'git');
  assert.strictEqual(cleanCheckout.code, 0, cleanCheckout.output);
  assert.ok(!cleanCheckout.output.includes('[WARN]'), cleanCheckout.output);
  assert.ok(cleanCheckout.output.includes('prompt asset allowlist exact: approved=46'));
  assert.ok(cleanCheckout.output.includes('prompt conflict allowlist exact: approved=4'));
  assert.ok(cleanCheckout.output.includes('[OK] no agent prompt files found'));
  assert.ok(cleanCheckout.output.includes('private manifest asset intentionally absent from public checkout: admin.txt'));
  assert.ok(cleanCheckout.output.includes('private manifest asset intentionally absent from public checkout: persona/01_identity.txt'));

  fs.mkdirSync(path.join(promptsDir, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(promptsDir, 'admin.txt'), 'private admin prompt', 'utf8');
  fs.writeFileSync(path.join(promptsDir, 'persona', '01_identity.txt'), 'private persona prompt', 'utf8');

  const packageInstall = runPromptCheck(promptsDir, 'package');
  assert.strictEqual(packageInstall.code, 0, packageInstall.output);
  assert.ok(!packageInstall.output.includes('[WARN]'), packageInstall.output);
  assert.ok(packageInstall.output.includes('prompt assets enumerated: mode=package'));
  assert.ok(packageInstall.output.includes('manifest asset present: admin.txt'));
  assert.ok(packageInstall.output.includes('manifest asset present: persona/01_identity.txt'));
  assert.ok(packageInstall.output.includes('private manifest asset intentionally absent from public checkout: persona/02_style.txt'));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('checkPromptsIntegration.test.js passed');
