const fs = require('fs');
const path = require('path');

const { PROMPTS_DIR, PROMPT_MANIFEST, PROMPT_MANIFEST_PATH } = require('../config');
const { RUNTIME_PROMPT_DEFAULTS } = require('../utils/runtimePrompts');
const {
  readRoutePromptPolicy,
  ROUTE_PROMPT_POLICY_PATH
} = require('../utils/routePromptPolicy');

function ok(msg) { console.log(`[OK] ${msg}`); }
function warn(msg) { console.log(`[WARN] ${msg}`); }
function fail(msg) { console.error(`[FAIL] ${msg}`); }

function collectPromptFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  if (fs.existsSync(rootDir)) walk(rootDir);
  return files;
}

function readManifestSections() {
  const sections = Array.isArray(PROMPT_MANIFEST?.system_prompt?.sections)
    ? PROMPT_MANIFEST.system_prompt.sections
    : [];

  return sections.map((section) => ({
    id: String(section?.id || '').trim(),
    path: String(section?.path || '').trim(),
    required: section?.required !== false,
    kind: String(section?.kind || '').trim() || 'unknown'
  }));
}

function collectTemplateVariables(templateText) {
  const matches = String(templateText || '').match(/\{\{(\w+)\}\}/g) || [];
  return Array.from(new Set(matches.map((token) => token.slice(2, -2))));
}

function main() {
  let failureCount = 0;
  console.log('================ Prompt Check Start ================');
  const ignoredRelPaths = new Set([
    'prompt-manifest.json'
  ]);

  if (!PROMPT_MANIFEST || typeof PROMPT_MANIFEST !== 'object') {
    fail(`prompt manifest missing or invalid: ${PROMPT_MANIFEST_PATH}`);
    process.exit(1);
  }
  ok(`prompt manifest loaded: ${PROMPT_MANIFEST_PATH}`);

  const sections = readManifestSections();
  const referencedRelPaths = new Set(sections.map((section) => section.path).filter(Boolean));
  const promptFiles = collectPromptFiles(PROMPTS_DIR);
  const runtimePolicy = readRoutePromptPolicy();

  for (const section of sections) {
    const fullPath = path.join(PROMPTS_DIR, ...section.path.split('/'));
    if (!fs.existsSync(fullPath)) {
      if (section.required) {
        fail(`missing required prompt asset: ${section.path}`);
        failureCount += 1;
      } else {
        warn(`optional prompt asset missing: ${section.path}`);
      }
      continue;
    }
    ok(`manifest asset present: ${section.path}`);
  }

  for (const filePath of promptFiles) {
    const relPath = path.relative(PROMPTS_DIR, filePath).split(path.sep).join('/');
    if (referencedRelPaths.has(relPath)) continue;
    if (ignoredRelPaths.has(relPath)) continue;
    if (relPath === 'persona/000.zip') {
      warn(`untracked prompt archive left in tree: ${relPath}`);
      continue;
    }
    warn(`prompt asset not referenced by manifest: ${relPath}`);
  }

  for (const [templateId, fallbackText] of Object.entries(RUNTIME_PROMPT_DEFAULTS)) {
    const relPath = `runtime/${templateId}.txt`;
    const fullPath = path.join(PROMPTS_DIR, ...relPath.split('/'));
    const templateText = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : fallbackText;
    const vars = collectTemplateVariables(templateText);
    ok(`runtime template variables ${templateId}: ${vars.join(', ') || '(none)'}`);
  }

  if (!fs.existsSync(ROUTE_PROMPT_POLICY_PATH)) {
    fail(`route prompt policy missing: ${ROUTE_PROMPT_POLICY_PATH}`);
    failureCount += 1;
  } else {
    ok(`route prompt policy loaded: ${ROUTE_PROMPT_POLICY_PATH}`);
  }

  const defaults = runtimePolicy.defaults && typeof runtimePolicy.defaults === 'object'
    ? runtimePolicy.defaults
    : {};
  if (!defaults.chat || !defaults.subagent) {
    fail('route prompt policy defaults.chat/defaults.subagent missing');
    failureCount += 1;
  } else {
    ok('route prompt policy defaults present');
  }

  const knownChatKeys = new Set([
    'include_tool_guidance',
    'include_streaming_segmentation',
    'include_qq_rich_reply_when_requested',
    'disable_stream_when_qq_rich_requested'
  ]);
  const knownSubagentKeys = new Set([
    'include_tool_guidance',
    'include_bridge_guidance'
  ]);

  const routeEntries = runtimePolicy.routes && typeof runtimePolicy.routes === 'object'
    ? Object.entries(runtimePolicy.routes)
    : [];
  for (const [routeType, routePolicy] of routeEntries) {
    for (const [mode, modePolicy] of Object.entries(routePolicy || {})) {
      const knownKeys = mode === 'chat' ? knownChatKeys : mode === 'subagent' ? knownSubagentKeys : null;
      if (!knownKeys) {
        fail(`unknown route policy mode: ${routeType}.${mode}`);
        failureCount += 1;
        continue;
      }
      for (const key of Object.keys(modePolicy || {})) {
        if (!knownKeys.has(key)) {
          fail(`unknown route policy key: ${routeType}.${mode}.${key}`);
          failureCount += 1;
        }
      }
    }
  }

  if (failureCount > 0) {
    console.log('================ Prompt Check Failed ================');
    process.exit(1);
  }

  console.log('================ Prompt Check Passed ================');
}

main();
