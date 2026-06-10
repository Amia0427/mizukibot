const fs = require('fs');
const path = require('path');

const { PROMPTS_DIR, PROMPT_MANIFEST, PROMPT_MANIFEST_PATH } = require('../config');
const { RUNTIME_PROMPT_DEFAULTS, renderRuntimePromptTemplate } = require('../utils/runtimePrompts');
const { buildPromptSnapshot } = require('../utils/promptCompiler');
const {
  loadAgentPromptsFromRoots
} = require('../utils/agentPrompts');
const {
  buildPlannerStageSystemPrompt,
  buildReviewStageSystemPrompt
} = require('../utils/stagePromptContracts');
const { buildSecuritySystemPrompt } = require('../utils/promptSecurity');
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

function collectConflictTags(sections = []) {
  const seen = new Map();
  const conflicts = [];
  for (const section of sections) {
    const tags = Array.isArray(section.conflictTags || section.conflict_tags)
      ? (section.conflictTags || section.conflict_tags).map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    for (const tag of tags) {
      if (seen.has(tag)) conflicts.push({ tag, sectionId: section.id, priorSectionId: seen.get(tag) });
      else seen.set(tag, section.id);
    }
  }
  return conflicts;
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
  const projectRoot = path.join(__dirname, '..');
  const ignoredRelPaths = new Set([
    'prompt-manifest.json',
    'persona_modules/module-catalog.json',
    'persona_modules/reference_anchor_map.json',
    'persona_modules/distilled_sources.json'
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
  let agentPrompts = [];
  try {
    agentPrompts = loadAgentPromptsFromRoots([
      PROMPTS_DIR,
      path.join(projectRoot, 'skills'),
      path.join(projectRoot, 'artifacts'),
      ...collectExtraAgentPromptRoots()
    ], { rootDir: projectRoot });
  } catch (error) {
    fail(`agent prompt load failed: ${error.message || error}`);
    failureCount += 1;
  }

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
    const sampleVariables = Object.fromEntries(vars.map((key) => [key, `${key}_sample`]));
    try {
      const rendered = renderRuntimePromptTemplate(templateText, sampleVariables);
      if (rendered.meta.unusedVariables.length > 0) {
        warn(`runtime template has unused sample variables ${templateId}: ${rendered.meta.unusedVariables.join(', ')}`);
      }
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
    warn('no agent prompt files found under prompts/, skills/, or artifacts/');
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

  if (!fs.existsSync(ROUTE_PROMPT_POLICY_PATH)) {
    fail(`route prompt policy missing: ${ROUTE_PROMPT_POLICY_PATH}`);
    failureCount += 1;
  } else {
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

  const manifestConflicts = collectConflictTags(Array.isArray(PROMPT_MANIFEST?.system_prompt?.sections) ? PROMPT_MANIFEST.system_prompt.sections : []);
  for (const conflict of manifestConflicts) {
    warn(`manifest conflict tag reused: ${conflict.tag} (${conflict.priorSectionId} -> ${conflict.sectionId})`);
  }

  const stageSnapshots = {
    main: buildPromptSnapshot([
      { id: 'policy', label: 'Policy', content: 'policy block', priority: 10 },
      { id: 'memory', label: 'Memory', content: 'memory block', priority: 20 },
      { id: 'persona', label: 'Persona', content: 'persona block', priority: 30 },
      { id: 'few_shot', label: 'Few Shot', content: 'few shot block', priority: 40, conflictTags: ['few_shot'] }
    ], { stage: 'main', policyKey: 'check/main', budgetTokens: 1000 }),
    review: buildReviewStageSystemPrompt(),
    planner: buildPlannerStageSystemPrompt([])
  };

  if (!stageSnapshots.main.assembledBlocks.length) {
    fail('main prompt snapshot assembledBlocks empty');
    failureCount += 1;
  } else {
    ok(`main prompt snapshot blocks: ${stageSnapshots.main.assembledBlocks.length}`);
  }

  if (!String(stageSnapshots.review || '').trim()) {
    fail('review stage system prompt empty');
    failureCount += 1;
  } else {
    ok('review stage system prompt present');
  }

  if (!String(stageSnapshots.planner || '').trim()) {
    fail('planner stage system prompt empty');
    failureCount += 1;
  } else {
    ok('planner stage system prompt present');
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
