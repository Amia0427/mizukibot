const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_ALLOWLIST_PATH = path.join(__dirname, '..', 'config', 'prompt-check-allowlist.json');
const NON_GOVERNED_PROMPT_PATHS = new Set(['prompt-manifest.json']);
const ALLOWLIST_KEYS = new Set([
  'version',
  'private_manifest_assets',
  'generated_asset_groups',
  'supplemental_asset_groups',
  'conflict_tag_reuse'
]);
const PRIVATE_ASSET_KEYS = new Set(['path', 'reason', 'review_by']);
const ASSET_GROUP_KEYS = new Set(['id', 'paths', 'reason', 'review_by']);
const CONFLICT_ENTRY_KEYS = new Set(['tag', 'section_ids', 'reason', 'review_by']);

function normalizeRelativePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function currentDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function isGovernedPromptAssetPath(value, excludedPaths = new Set()) {
  const assetPath = normalizeRelativePath(value);
  if (!assetPath || NON_GOVERNED_PROMPT_PATHS.has(assetPath)) return false;
  if (excludedPaths.has(assetPath)) return false;
  return true;
}

function collectAllowlistedExcludedPaths(allowlist = {}) {
  const paths = [];
  for (const entry of Array.isArray(allowlist.private_manifest_assets) ? allowlist.private_manifest_assets : []) {
    paths.push(normalizeRelativePath(entry?.path));
  }
  for (const group of Array.isArray(allowlist.generated_asset_groups) ? allowlist.generated_asset_groups : []) {
    for (const assetPath of Array.isArray(group?.paths) ? group.paths : []) {
      paths.push(normalizeRelativePath(assetPath));
    }
  }
  return new Set(paths.filter(Boolean));
}

function collectPrivateManifestAssetPaths(allowlist = {}) {
  return new Set(
    (Array.isArray(allowlist.private_manifest_assets) ? allowlist.private_manifest_assets : [])
      .map((entry) => normalizeRelativePath(entry?.path))
      .filter(Boolean)
  );
}

function normalizeTrackedPromptPath(value) {
  const repositoryPath = normalizeRelativePath(value);
  if (!repositoryPath.startsWith('prompts/')) return '';
  return normalizeRelativePath(repositoryPath.slice('prompts/'.length));
}

function readPackageFileEntries(projectRoot) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return (Array.isArray(packageJson.files) ? packageJson.files : [])
    .map(normalizeRelativePath)
    .filter(Boolean);
}

function isIncludedInPackage(repositoryPath, packageFileEntries) {
  if (packageFileEntries.length === 0) return true;
  return packageFileEntries.some((entry) => {
    const normalizedEntry = entry.replace(/\/+$/, '');
    return repositoryPath === normalizedEntry || repositoryPath.startsWith(`${normalizedEntry}/`);
  });
}

function collectPackagePromptPaths(promptsDir, projectRoot) {
  const files = [];
  const packageFileEntries = readPackageFileEntries(projectRoot);
  const stack = [promptsDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const promptPath = normalizeRelativePath(path.relative(promptsDir, fullPath));
        const repositoryPath = `prompts/${promptPath}`;
        if (isIncludedInPackage(repositoryPath, packageFileEntries)) files.push(promptPath);
      }
    }
  }
  return files;
}

function resolveAssetAllowlist(options, projectRoot) {
  if (options.allowlist && typeof options.allowlist === 'object') return options.allowlist;
  const allowlistPath = path.resolve(
    options.allowlistPath || path.join(projectRoot, 'config', 'prompt-check-allowlist.json')
  );
  if (!fs.existsSync(allowlistPath)) return {};
  return loadPromptCheckAllowlist(allowlistPath);
}

function collectPromptAssetPaths(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'));
  const requestedMode = String(options.mode || process.env.PROMPT_CHECK_ASSET_MODE || 'auto').trim().toLowerCase();
  const excludedPaths = collectAllowlistedExcludedPaths(resolveAssetAllowlist(options, projectRoot));
  let mode = requestedMode;
  let paths;

  if (mode === 'git' || mode === 'auto') {
    try {
      const output = execFileSync(
        options.gitExecutable || 'git',
        ['-C', projectRoot, 'ls-files', '-z', '--', 'prompts'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      paths = output.split('\0').map(normalizeTrackedPromptPath).filter(Boolean);
      mode = 'git';
    } catch (error) {
      if (mode === 'git') {
        throw new Error(
          'Unable to enumerate Git-tracked prompt assets. '
          + 'Run from a Git checkout or use PROMPT_CHECK_ASSET_MODE=package for an unpacked npm package.'
        );
      }
      mode = 'package';
    }
  }

  if (mode === 'package' && !paths) {
    const promptsDir = path.resolve(options.promptsDir || path.join(projectRoot, 'prompts'));
    if (!fs.existsSync(promptsDir) || !fs.statSync(promptsDir).isDirectory()) {
      throw new Error(`Package prompt directory is missing: ${promptsDir}`);
    }
    paths = collectPackagePromptPaths(promptsDir, projectRoot);
  } else if (mode !== 'git') {
    throw new Error(`Unknown PROMPT_CHECK_ASSET_MODE: ${requestedMode || '(empty)'}`);
  }

  const allPaths = Array.from(new Set(paths.filter((assetPath) => isGovernedPromptAssetPath(assetPath)))).sort();
  const governedPaths = allPaths.filter((assetPath) => !excludedPaths.has(assetPath));
  if (governedPaths.length === 0) {
    throw new Error(`No governed prompt assets found in ${mode} mode`);
  }

  return {
    mode,
    allPaths,
    excludedPaths: allPaths.filter((assetPath) => excludedPaths.has(assetPath)),
    paths: governedPaths
  };
}

function validateExactKeys(value, allowedKeys, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${label} has unknown field: ${key}`);
  }
}

function isValidReviewDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function collectConflictTagGroups(sections = []) {
  const groups = new Map();
  for (const section of Array.isArray(sections) ? sections : []) {
    const sectionId = String(section?.id || '').trim();
    const rawTags = section?.conflictTags || section?.conflict_tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.map((tag) => String(tag || '').trim()).filter(Boolean)
      : [];
    for (const tag of tags) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(sectionId);
    }
  }

  return new Map(
    Array.from(groups.entries())
      .filter(([, sectionIds]) => sectionIds.length > 1)
      .map(([tag, sectionIds]) => [tag, Array.from(new Set(sectionIds)).sort()])
  );
}

function validateReviewMetadata(entry, label, today, errors) {
  if (!String(entry?.reason || '').trim()) {
    errors.push(`${label} must explain why the exception is required`);
  }

  const reviewBy = String(entry?.review_by || '').trim();
  if (!isValidReviewDate(reviewBy)) {
    errors.push(`${label} has invalid review_by date: ${reviewBy || '(missing)'}`);
    return false;
  }
  if (reviewBy < today) {
    errors.push(`${label} expired on ${reviewBy}`);
    return false;
  }
  return true;
}

function evaluatePromptGovernance(options = {}) {
  const allowlist = options.allowlist && typeof options.allowlist === 'object'
    ? options.allowlist
    : {};
  const today = String(options.today || currentDate());
  const referencedPaths = new Set(
    (options.referencedPaths || []).map(normalizeRelativePath).filter(Boolean)
  );
  const promptAssetPaths = new Set(
    (options.promptAssetPaths || [])
      .map(normalizeRelativePath)
      .filter((assetPath) => assetPath && assetPath !== 'prompt-manifest.json')
  );
  const unreferencedPaths = new Set(
    Array.from(promptAssetPaths).filter((assetPath) => !referencedPaths.has(assetPath))
  );
  const errors = [];

  if (allowlist.version !== 1) {
    errors.push(`prompt check allowlist version must be 1, received ${String(allowlist.version)}`);
  }
  validateExactKeys(allowlist, ALLOWLIST_KEYS, 'prompt check allowlist', errors);

  const privateManifestPaths = new Set();
  if (!Array.isArray(allowlist.private_manifest_assets)) {
    errors.push('prompt check allowlist private_manifest_assets must be an array');
  }
  for (const entry of Array.isArray(allowlist.private_manifest_assets) ? allowlist.private_manifest_assets : []) {
    const assetPath = normalizeRelativePath(entry?.path);
    const label = `private manifest asset ${assetPath || '(missing path)'}`;
    validateExactKeys(entry, PRIVATE_ASSET_KEYS, label, errors);
    validateReviewMetadata(entry, label, today, errors);
    if (!assetPath) {
      errors.push(`${label} must define an exact path`);
      continue;
    }
    if (path.posix.isAbsolute(assetPath) || assetPath.split('/').includes('..')) {
      errors.push(`${label} contains a non-relative path`);
      continue;
    }
    if (!(assetPath === 'admin.txt' || assetPath.startsWith('persona/') || assetPath.startsWith('private/'))) {
      errors.push(`${label} is not under a private prompt path`);
    }
    if (privateManifestPaths.has(assetPath)) errors.push(`private manifest asset is listed more than once: ${assetPath}`);
    privateManifestPaths.add(assetPath);
    if (!referencedPaths.has(assetPath)) errors.push(`private manifest asset allowlist entry is stale: ${assetPath}`);
  }
  for (const assetPath of referencedPaths) {
    const isPrivatePath = assetPath === 'admin.txt' || assetPath.startsWith('persona/') || assetPath.startsWith('private/');
    if (isPrivatePath && !privateManifestPaths.has(assetPath)) {
      errors.push(`private manifest asset is not allowlisted: ${assetPath}`);
    }
  }

  const repositoryAssetPaths = new Set(
    (options.repositoryAssetPaths || options.promptAssetPaths || [])
      .map(normalizeRelativePath)
      .filter(Boolean)
  );
  const generatedAssetPaths = new Set();
  const generatedGroupIds = new Set();
  if (!Array.isArray(allowlist.generated_asset_groups)) {
    errors.push('prompt check allowlist generated_asset_groups must be an array');
  }
  for (const group of Array.isArray(allowlist.generated_asset_groups) ? allowlist.generated_asset_groups : []) {
    const groupId = String(group?.id || '').trim();
    const paths = Array.isArray(group?.paths)
      ? group.paths.map(normalizeRelativePath).filter(Boolean)
      : [];
    const label = `generated asset group ${groupId || '(missing id)'} (${paths.join(', ') || 'no paths'})`;
    validateExactKeys(group, ASSET_GROUP_KEYS, label, errors);
    if (!groupId) errors.push(`${label} must define an id`);
    if (groupId && generatedGroupIds.has(groupId)) errors.push(`generated asset group id is listed more than once: ${groupId}`);
    if (groupId) generatedGroupIds.add(groupId);
    validateReviewMetadata(group, label, today, errors);
    if (paths.length === 0) errors.push(`${label} must list at least one exact path`);
    for (const assetPath of paths) {
      if (path.posix.isAbsolute(assetPath) || assetPath.split('/').includes('..')) {
        errors.push(`${label} contains a non-relative path: ${assetPath}`);
        continue;
      }
      if (generatedAssetPaths.has(assetPath)) errors.push(`generated asset path is listed more than once: ${assetPath}`);
      generatedAssetPaths.add(assetPath);
      if (!repositoryAssetPaths.has(assetPath)) errors.push(`generated asset allowlist entry is stale: ${assetPath}`);
    }
  }

  const declaredAssets = new Map();
  const declaredAssetGroupIds = new Set();
  if (!Array.isArray(allowlist.supplemental_asset_groups)) {
    errors.push('prompt check allowlist supplemental_asset_groups must be an array');
  }
  const assetGroups = Array.isArray(allowlist.supplemental_asset_groups)
    ? allowlist.supplemental_asset_groups
    : [];
  for (const group of assetGroups) {
    const groupId = String(group?.id || '').trim();
    const paths = Array.isArray(group?.paths)
      ? group.paths.map(normalizeRelativePath).filter(Boolean)
      : [];
    const label = `supplemental asset group ${groupId || '(missing id)'} (${paths.join(', ') || 'no paths'})`;
    validateExactKeys(group, ASSET_GROUP_KEYS, label, errors);
    if (!groupId) errors.push(`${label} must define an id`);
    if (groupId && declaredAssetGroupIds.has(groupId)) errors.push(`supplemental asset group id is listed more than once: ${groupId}`);
    if (groupId) declaredAssetGroupIds.add(groupId);
    const metadataValid = validateReviewMetadata(group, label, today, errors);
    if (paths.length === 0) errors.push(`${label} must list at least one exact path`);

    for (const assetPath of paths) {
      if (path.posix.isAbsolute(assetPath) || assetPath.split('/').includes('..')) {
        errors.push(`${label} contains a non-relative path: ${assetPath}`);
        continue;
      }
      if (declaredAssets.has(assetPath)) {
        errors.push(`supplemental asset path is listed more than once: ${assetPath}`);
        continue;
      }
      declaredAssets.set(assetPath, { metadataValid, label });
    }
  }

  for (const assetPath of Array.from(unreferencedPaths).sort()) {
    if (!declaredAssets.has(assetPath)) {
      errors.push(`prompt asset is not referenced by manifest or allowlist: ${assetPath}`);
    }
  }
  for (const [assetPath] of declaredAssets) {
    if (!unreferencedPaths.has(assetPath)) {
      errors.push(`supplemental asset allowlist entry is stale: ${assetPath}`);
    }
  }

  const actualConflictGroups = collectConflictTagGroups(options.manifestSections);
  const declaredConflicts = new Map();
  if (!Array.isArray(allowlist.conflict_tag_reuse)) {
    errors.push('prompt check allowlist conflict_tag_reuse must be an array');
  }
  const conflictEntries = Array.isArray(allowlist.conflict_tag_reuse)
    ? allowlist.conflict_tag_reuse
    : [];
  for (const entry of conflictEntries) {
    const tag = String(entry?.tag || '').trim();
    const label = `conflict tag allowlist entry ${tag || '(missing tag)'}`;
    validateExactKeys(entry, CONFLICT_ENTRY_KEYS, label, errors);
    if (!tag) errors.push(`${label} must define a tag`);
    validateReviewMetadata(entry, label, today, errors);
    const sectionIds = Array.isArray(entry?.section_ids)
      ? Array.from(new Set(entry.section_ids.map((id) => String(id || '').trim()).filter(Boolean))).sort()
      : [];
    if (sectionIds.length < 2) errors.push(`${label} must list at least two section_ids`);
    if (declaredConflicts.has(tag)) errors.push(`conflict tag is listed more than once: ${tag}`);
    else if (tag) declaredConflicts.set(tag, sectionIds);
  }

  for (const [tag, sectionIds] of actualConflictGroups) {
    const allowedSectionIds = declaredConflicts.get(tag);
    if (!allowedSectionIds) {
      errors.push(`manifest conflict tag reuse is not allowlisted: ${tag} (${sectionIds.join(', ')})`);
      continue;
    }
    if (allowedSectionIds.join('\0') !== sectionIds.join('\0')) {
      errors.push(`manifest conflict tag ${tag} does not match allowlist: expected (${allowedSectionIds.join(', ')}), actual (${sectionIds.join(', ')})`);
    }
  }
  for (const tag of declaredConflicts.keys()) {
    if (!actualConflictGroups.has(tag)) {
      errors.push(`conflict tag allowlist entry is stale: ${tag}`);
    }
  }

  return {
    errors,
    approvedAssetCount: Array.from(unreferencedPaths).filter((assetPath) => declaredAssets.get(assetPath)?.metadataValid).length,
    approvedConflictTagCount: Array.from(actualConflictGroups.keys()).filter((tag) => declaredConflicts.has(tag)).length
  };
}

function loadPromptCheckAllowlist(filePath = DEFAULT_ALLOWLIST_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  DEFAULT_ALLOWLIST_PATH,
  collectConflictTagGroups,
  collectPrivateManifestAssetPaths,
  collectPromptAssetPaths,
  evaluatePromptGovernance,
  isGovernedPromptAssetPath,
  loadPromptCheckAllowlist
};
