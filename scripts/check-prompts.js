const fs = require('fs');
const path = require('path');

const { buildPromptSnapshot } = require('../utils/promptCompiler');
const {
  loadAgentPromptsFromRoots
} = require('../utils/agentPrompts');
const { buildSecuritySystemPrompt } = require('../utils/promptSecurity');
const {
  collectPrivateManifestAssetPaths,
  collectMainReplyManifestPaths,
  collectPromptAssetPaths,
  evaluatePromptGovernance,
  loadPromptCheckAllowlist
} = require('./prompt-check-governance');

const PROJECT_ROOT = path.join(__dirname, '..');
const PROMPTS_DIR = path.resolve(process.env.PROMPTS_DIR || path.join(PROJECT_ROOT, 'prompts'));
const PROMPT_MANIFEST_PATH = path.join(PROMPTS_DIR, 'prompt-manifest.json');
const ROUTE_PROMPT_POLICY_PATH = path.join(PROMPTS_DIR, 'runtime', 'route-policies.json');

function ok(msg) { console.log(`[OK] ${msg}`); }
function warn(msg) { console.log(`[WARN] ${msg}`); }
function fail(msg) { console.error(`[FAIL] ${msg}`); }

function readManifestSections(promptManifest) {
  const sections = Array.isArray(promptManifest?.system_prompt?.sections)
    ? promptManifest.system_prompt.sections
    : [];

  return sections.map((section) => ({
    id: String(section?.id || '').trim(),
    path: String(section?.path || '').trim(),
    required: section?.required !== false,
    kind: String(section?.kind || '').trim() || 'unknown'
  }));
}

function renderRuntimePromptTemplate(templateText, variables = {}) {
  const rendered = String(templateText || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (variables[key] === undefined || variables[key] === null) {
      throw new Error(`missing required template variable: ${key}`);
    }
    return String(variables[key]);
  }).trim();
  return { text: rendered };
}

function collectTemplateVariables(templateText) {
  const matches = String(templateText || '').match(/\{\{(\w+)\}\}/g) || [];
  return Array.from(new Set(matches.map((token) => token.slice(2, -2))));
}

function collectExtraAgentPromptRoots() {
  return String(process.env.AGENT_PROMPT_EXTRA_ROOTS || '')
    .split(path.delimiter)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function summarizeAgentPromptFormats(agentPrompts = []) {
  const summary = {
    total: 0,
    markdown: 0,
    yaml: 0,
    invalid: 0
  };

  for (const prompt of Array.isArray(agentPrompts) ? agentPrompts : []) {
    summary.total += 1;
    const format = String(prompt?.format || '').trim().toLowerCase();
    if (format === 'markdown') summary.markdown += 1;
    if (format === 'yaml') summary.yaml += 1;
    if (!prompt?.ok) summary.invalid += 1;
  }

  return summary;
}

function main() {
  let failureCount = 0;
  console.log('================ Prompt Check Start ================');
  let promptManifest;

  try {
    promptManifest = JSON.parse(fs.readFileSync(PROMPT_MANIFEST_PATH, 'utf8'));
  } catch (error) {
    fail(`prompt manifest missing or invalid: ${PROMPT_MANIFEST_PATH}`);
    return 1;
  }
  ok(`prompt manifest loaded: ${PROMPT_MANIFEST_PATH}`);

  const sections = readManifestSections(promptManifest);
  const referencedRelPaths = new Set(sections.map((section) => section.path).filter(Boolean));
  try {
    for (const assetPath of collectMainReplyManifestPaths({ promptsDir: PROMPTS_DIR, projectRoot: PROJECT_ROOT })) {
      referencedRelPaths.add(assetPath);
    }
  } catch (error) {
    fail(error.message || error);
    failureCount += 1;
  }
  let allowlist;
  let promptAssets;
  try {
    allowlist = loadPromptCheckAllowlist(process.env.PROMPT_CHECK_ALLOWLIST_PATH || undefined);
    promptAssets = collectPromptAssetPaths({
      projectRoot: PROJECT_ROOT,
      promptsDir: PROMPTS_DIR,
      allowlist
    });
    ok(`prompt assets enumerated: mode=${promptAssets.mode}, governed=${promptAssets.paths.length}`);
  } catch (error) {
    fail(`prompt governance setup failed: ${error.message || error}`);
    failureCount += 1;
  }
  const privateManifestPaths = collectPrivateManifestAssetPaths(allowlist);
  let runtimePolicy = {};
  try {
    runtimePolicy = JSON.parse(fs.readFileSync(ROUTE_PROMPT_POLICY_PATH, 'utf8'));
  } catch (error) {
    fail(`route prompt policy missing or invalid: ${ROUTE_PROMPT_POLICY_PATH}`);
    failureCount += 1;
  }
  let agentPrompts = [];
  try {
    agentPrompts = loadAgentPromptsFromRoots([
      PROMPTS_DIR,
      path.join(PROJECT_ROOT, 'skills'),
      path.join(PROJECT_ROOT, 'artifacts'),
      ...collectExtraAgentPromptRoots()
    ], { rootDir: PROJECT_ROOT });
  } catch (error) {
    fail(`agent prompt load failed: ${error.message || error}`);
    failureCount += 1;
  }

  for (const section of sections) {
    const fullPath = path.join(PROMPTS_DIR, ...section.path.split('/'));
    if (!fs.existsSync(fullPath)) {
      if (privateManifestPaths.has(section.path)) {
        ok(`private manifest asset intentionally absent from public checkout: ${section.path}`);
        continue;
      }
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

  if (allowlist && promptAssets) {
    const governance = evaluatePromptGovernance({
      allowlist,
      promptAssetPaths: promptAssets.paths,
      repositoryAssetPaths: promptAssets.allPaths,
      referencedPaths: Array.from(referencedRelPaths),
      manifestSections: promptManifest.system_prompt.sections
    });
    for (const error of governance.errors) {
      fail(error);
      failureCount += 1;
    }
    if (governance.errors.length === 0) {
      ok(`prompt asset allowlist exact: approved=${governance.approvedAssetCount}`);
      ok(`prompt conflict allowlist exact: approved=${governance.approvedConflictTagCount}`);
    }
  }

  const runtimeTemplatePaths = (promptAssets?.paths || [])
    .filter((assetPath) => assetPath.startsWith('runtime/') && assetPath.endsWith('.txt'))
    .sort();
  for (const relPath of runtimeTemplatePaths) {
    const templateId = path.posix.basename(relPath, '.txt');
    const fullPath = path.join(PROMPTS_DIR, ...relPath.split('/'));
    const templateText = fs.readFileSync(fullPath, 'utf8');
    const vars = collectTemplateVariables(templateText);
    ok(`runtime template variables ${templateId}: ${vars.join(', ') || '(none)'}`);
    const sampleVariables = Object.fromEntries(vars.map((key) => [key, `${key}_sample`]));
    try {
      const rendered = renderRuntimePromptTemplate(templateText, sampleVariables);
      if (!rendered.text) {
        fail(`runtime template rendered empty block: ${templateId}`);
        failureCount += 1;
      }
    } catch (error) {
      fail(`runtime template render failed ${templateId}: ${error.message || error}`);
      failureCount += 1;
    }
  }

  if (agentPrompts.length === 0) {
    ok('no agent prompt files found under prompts/, skills/, or artifacts/');
  }

  const agentPromptSummary = summarizeAgentPromptFormats(agentPrompts);
  ok(`agent prompt formats: total=${agentPromptSummary.total}, markdown=${agentPromptSummary.markdown}, yaml=${agentPromptSummary.yaml}, invalid=${agentPromptSummary.invalid}`);

  for (const parsed of agentPrompts) {
    try {
      if (!parsed.ok) {
        fail(`agent prompt invalid ${parsed.relativePath}: ${(parsed.problems || []).join('; ')}`);
        failureCount += 1;
        continue;
      }
      ok(`agent prompt parsed ${parsed.relativePath}: ${parsed.displayName}`);
    } catch (error) {
      fail(`agent prompt parse failed: ${error.message || error}`);
      failureCount += 1;
    }
  }

  if (fs.existsSync(ROUTE_PROMPT_POLICY_PATH)) {
    ok(`route prompt policy loaded: ${ROUTE_PROMPT_POLICY_PATH}`);
  }

  const defaults = runtimePolicy.defaults && typeof runtimePolicy.defaults === 'object'
    ? runtimePolicy.defaults
    : {};
  if (!defaults.chat) {
    fail('route prompt policy defaults.chat missing');
    failureCount += 1;
  } else {
    ok('route prompt policy chat defaults present');
  }

  const knownChatKeys = new Set([
    'include_tool_guidance',
    'include_streaming_segmentation',
    'include_qq_rich_reply_when_requested',
    'disable_stream_when_qq_rich_requested'
  ]);
  const routeEntries = runtimePolicy.routes && typeof runtimePolicy.routes === 'object'
    ? Object.entries(runtimePolicy.routes)
    : [];
  for (const [routeType, routePolicy] of routeEntries) {
    for (const [mode, modePolicy] of Object.entries(routePolicy || {})) {
      const knownKeys = mode === 'chat' ? knownChatKeys : null;
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

  const mainStageSnapshot = buildPromptSnapshot([
      { id: 'policy', label: 'Policy', content: 'policy block', priority: 10 },
      { id: 'memory', label: 'Memory', content: 'memory block', priority: 20 },
      { id: 'persona', label: 'Persona', content: 'persona block', priority: 30 },
      { id: 'few_shot', label: 'Few Shot', content: 'few shot block', priority: 40, conflictTags: ['few_shot'] }
    ], { stage: 'main', policyKey: 'check/main', budgetTokens: 1000 });

  if (!mainStageSnapshot.assembledBlocks.length) {
    fail('main prompt snapshot assembledBlocks empty');
    failureCount += 1;
  } else {
    ok(`main prompt snapshot blocks: ${mainStageSnapshot.assembledBlocks.length}`);
  }

  const securityBlock = buildSecuritySystemPrompt();
  if (!String(securityBlock || '').trim()) {
    fail('security system prompt missing');
    failureCount += 1;
  } else {
    ok('security system prompt present');
  }

  if (failureCount > 0) {
    console.log('================ Prompt Check Failed ================');
    return 1;
  }

  console.log('================ Prompt Check Passed ================');
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  summarizeAgentPromptFormats
};
