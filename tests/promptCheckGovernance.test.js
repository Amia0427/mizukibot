const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectPromptAssetPaths,
  evaluatePromptGovernance,
  isGovernedPromptAssetPath,
  loadPromptCheckAllowlist
} = require('../scripts/prompt-check-governance');

function buildInput(overrides = {}) {
  return {
    allowlist: {
      version: 1,
      private_manifest_assets: [],
      generated_asset_groups: [],
      supplemental_asset_groups: [],
      conflict_tag_reuse: []
    },
    promptAssetPaths: ['SYSTEM.txt'],
    referencedPaths: ['SYSTEM.txt'],
    manifestSections: [],
    today: '2026-07-12',
    ...overrides
  };
}

const unreferenced = evaluatePromptGovernance(buildInput({
  promptAssetPaths: ['SYSTEM.txt', 'runtime/new-unregistered-prompt.txt']
}));
assert.ok(
  unreferenced.errors.some((message) => message.includes('runtime/new-unregistered-prompt.txt')),
  'a new unreferenced prompt must fail unless it is explicitly allowlisted'
);

const expired = evaluatePromptGovernance(buildInput({
  promptAssetPaths: ['SYSTEM.txt', 'runtime/legacy-prompt.txt'],
  allowlist: {
    version: 1,
    private_manifest_assets: [],
    generated_asset_groups: [],
    supplemental_asset_groups: [{
      id: 'legacy_runtime_prompt',
      paths: ['runtime/legacy-prompt.txt'],
      reason: 'Used by a runtime-specific prompt loader.',
      review_by: '2026-07-11'
    }],
    conflict_tag_reuse: []
  }
}));
assert.ok(
  expired.errors.some((message) => message.includes('expired') && message.includes('runtime/legacy-prompt.txt')),
  'an expired supplemental-asset allowlist entry must fail'
);

const conflictDrift = evaluatePromptGovernance(buildInput({
  manifestSections: [
    { id: 'first', conflict_tags: ['shared_mode'] },
    { id: 'second', conflict_tags: ['shared_mode'] },
    { id: 'new_third', conflict_tags: ['shared_mode'] }
  ],
  allowlist: {
    version: 1,
    private_manifest_assets: [],
    generated_asset_groups: [],
    supplemental_asset_groups: [],
    conflict_tag_reuse: [{
      tag: 'shared_mode',
      section_ids: ['first', 'second'],
      reason: 'The two established modes are mutually exclusive.',
      review_by: '2027-01-31'
    }]
  }
}));
assert.ok(
  conflictDrift.errors.some((message) => message.includes('shared_mode') && message.includes('does not match')),
  'adding a section to an allowlisted conflict tag must fail until reviewed'
);

const approved = evaluatePromptGovernance(buildInput({
  promptAssetPaths: ['SYSTEM.txt', 'runtime/legacy-prompt.txt'],
  manifestSections: [
    { id: 'first', conflict_tags: ['shared_mode'] },
    { id: 'second', conflict_tags: ['shared_mode'] }
  ],
  allowlist: {
    version: 1,
    private_manifest_assets: [],
    generated_asset_groups: [],
    supplemental_asset_groups: [{
      id: 'legacy_runtime_prompt',
      paths: ['runtime/legacy-prompt.txt'],
      reason: 'Used by a runtime-specific prompt loader.',
      review_by: '2027-01-31'
    }],
    conflict_tag_reuse: [{
      tag: 'shared_mode',
      section_ids: ['first', 'second'],
      reason: 'The two established modes are mutually exclusive.',
      review_by: '2027-01-31'
    }]
  }
}));
assert.deepStrictEqual(approved.errors, []);

const projectRoot = path.join(__dirname, '..');
const currentAllowlist = loadPromptCheckAllowlist();
const currentManifest = require('../prompts/prompt-manifest.json');
const currentSections = currentManifest.system_prompt.sections;
const promptAssets = collectPromptAssetPaths({ projectRoot, allowlist: currentAllowlist });
const trackedWorldbookPaths = promptAssets.paths.filter((assetPath) => assetPath.startsWith('persona_worldbook/'));
const referencedPaths = new Set(currentSections.map((section) => section.path));
const supplementalRuntimePaths = promptAssets.paths.filter(
  (assetPath) => assetPath.startsWith('runtime/') && !referencedPaths.has(assetPath)
);
assert.strictEqual(trackedWorldbookPaths.length, 39, 'the allowlist must track the current authoritative worldbook set');
assert.strictEqual(supplementalRuntimePaths.length, 7, 'the allowlist must track the current authoritative runtime-template set');
assert.ok(!promptAssets.paths.includes('admin.txt'), 'ignored local admin prompt must not enter manifest drift checks');
assert.ok(!promptAssets.paths.includes('persona.zip'), 'ignored local prompt archives must not enter manifest drift checks');
assert.ok(!promptAssets.paths.some((assetPath) => assetPath.startsWith('persona/')), 'private persona prompts must not enter manifest drift checks');
assert.strictEqual(isGovernedPromptAssetPath('persona.zip'), true, 'archives are governed when they are actually tracked or packaged');
assert.strictEqual(isGovernedPromptAssetPath('runtime/new-archive.zip'), true, 'new archives must not bypass governance');

const currentGovernance = evaluatePromptGovernance({
  allowlist: currentAllowlist,
  promptAssetPaths: promptAssets.paths,
  repositoryAssetPaths: promptAssets.allPaths,
  referencedPaths: currentSections.map((section) => section.path),
  manifestSections: currentSections,
  today: '2026-07-12'
});
assert.deepStrictEqual(currentGovernance.errors, [], 'the versioned allowlist must exactly match tracked repository assets');
assert.strictEqual(currentGovernance.approvedAssetCount, 46);
assert.strictEqual(currentGovernance.approvedConflictTagCount, 4);

const packageAssets = collectPromptAssetPaths({
  mode: 'package',
  projectRoot,
  promptsDir: path.join(projectRoot, 'prompts')
});
assert.ok(packageAssets.paths.includes('persona_worldbook/care_chains.txt'));
assert.ok(!packageAssets.paths.includes('admin.txt'));
assert.ok(!packageAssets.paths.includes('persona.zip'));
assert.ok(!packageAssets.paths.some((assetPath) => assetPath.startsWith('persona/')));

assert.throws(
  () => collectPromptAssetPaths({ mode: 'git', projectRoot, gitExecutable: 'git-command-that-does-not-exist' }),
  /PROMPT_CHECK_ASSET_MODE=package/,
  'explicit Git mode must fail when tracked assets cannot be enumerated'
);

const unknownField = evaluatePromptGovernance(buildInput({
  allowlist: {
    version: 1,
    private_manifest_assets: [],
    generated_asset_groups: [],
    supplemental_asset_groups: [],
    conflict_tag_reuse: [],
    supplemental_assets: []
  }
}));
assert.ok(
  unknownField.errors.some((message) => message.includes('unknown field: supplemental_assets')),
  'unknown allowlist fields must fail instead of silently weakening the gate'
);

const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-prompt-package-'));
try {
  const packagePromptsDir = path.join(packageRoot, 'prompts');
  fs.mkdirSync(path.join(packagePromptsDir, 'persona'), { recursive: true });
  fs.mkdirSync(path.join(packagePromptsDir, 'persona_modules'), { recursive: true });
  fs.writeFileSync(path.join(packagePromptsDir, 'SYSTEM.txt'), 'system', 'utf8');
  fs.writeFileSync(path.join(packagePromptsDir, 'persona', 'identity.txt'), 'private', 'utf8');
  fs.writeFileSync(path.join(packagePromptsDir, 'persona_modules', 'catalog.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(packagePromptsDir, 'persona.zip'), 'archive', 'utf8');

  const packageAllowlist = {
    private_manifest_assets: [{ path: 'persona/identity.txt' }],
    generated_asset_groups: [{ paths: ['persona_modules/catalog.json'] }]
  };
  const fallbackAssets = collectPromptAssetPaths({
    projectRoot: packageRoot,
    promptsDir: packagePromptsDir,
    gitExecutable: 'git-command-that-does-not-exist',
    allowlist: packageAllowlist
  });
  assert.strictEqual(fallbackAssets.mode, 'package');
  assert.deepStrictEqual(fallbackAssets.paths, ['SYSTEM.txt', 'persona.zip']);
  assert.deepStrictEqual(fallbackAssets.excludedPaths, [
    'persona/identity.txt',
    'persona_modules/catalog.json'
  ]);

  fs.rmSync(path.join(packagePromptsDir, 'SYSTEM.txt'));
  fs.rmSync(path.join(packagePromptsDir, 'persona.zip'));
  assert.throws(
    () => collectPromptAssetPaths({
      mode: 'package',
      projectRoot: packageRoot,
      promptsDir: packagePromptsDir,
      allowlist: packageAllowlist
    }),
    /No governed prompt assets found/,
    'package fallback must not pass when only excluded or archive assets remain'
  );
} finally {
  fs.rmSync(packageRoot, { recursive: true, force: true });
}

console.log('promptCheckGovernance.test.js passed');
