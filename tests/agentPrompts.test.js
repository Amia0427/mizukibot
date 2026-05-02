const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  formatAgentPromptForRuntime,
  loadAgentPromptsFromRoots,
  loadSkillAgentPrompts,
  parseAgentPromptText
} = require('../utils/agentPrompts');
const nativeSkillValidation = require('../api/skills_native/skillValidation');
const checkPrompts = require('../scripts/check-prompts');

async function withTempSkill(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-agent-prompts-'));
  const skillRoot = path.join(root, 'markdown-agent-skill');
  fs.mkdirSync(path.join(skillRoot, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: markdown-agent-skill',
    'description: test skill',
    '---',
    '',
    '# Markdown Agent Skill'
  ].join('\n'));
  try {
    return await fn(root, skillRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function clearProjectModule(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

async function captureOutput(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function runCheckMain(modulePath, envPatch = {}) {
  const oldEnv = {};
  for (const key of Object.keys(envPatch)) oldEnv[key] = process.env[key];
  Object.assign(process.env, envPatch);
  clearProjectModule(modulePath);
  try {
    const mod = require(modulePath);
    return captureOutput(() => mod.main());
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearProjectModule(modulePath);
  }
}

module.exports = (async () => {
  const yamlAgent = parseAgentPromptText([
    'interface:',
    '  display_name: "Gateway Image Gen"',
    '  short_description: "Generate images"',
    '  default_prompt: "Use the gateway image tool."'
  ].join('\n'), { filePath: 'openai.yaml' });

  assert.strictEqual(yamlAgent.ok, true);
  assert.strictEqual(yamlAgent.interface.display_name, 'Gateway Image Gen');
  assert.strictEqual(yamlAgent.defaultPrompt, 'Use the gateway image tool.');

  const legacyTopLevelYamlAgent = parseAgentPromptText([
    'name: "Legacy Top Level Agent"',
    'description: "Old structured prompt shape"',
    'default_prompt: "Use the top-level YAML prompt."'
  ].join('\n'), { filePath: 'legacy.yaml' });

  assert.strictEqual(legacyTopLevelYamlAgent.ok, true);
  assert.strictEqual(legacyTopLevelYamlAgent.displayName, 'Legacy Top Level Agent');
  assert.strictEqual(legacyTopLevelYamlAgent.defaultPrompt, 'Use the top-level YAML prompt.');

  const emptyMarkdownAgent = parseAgentPromptText('', { filePath: 'empty.md' });
  assert.strictEqual(emptyMarkdownAgent.ok, false);
  assert.ok(emptyMarkdownAgent.problems.includes('Missing default prompt text'));
  assert.throws(
    () => formatAgentPromptForRuntime(emptyMarkdownAgent),
    /Missing default prompt text/
  );

  const frontMatterOnlyMarkdownAgent = parseAgentPromptText([
    '---',
    'name: Metadata Only Agent',
    'description: Has no body prompt',
    '---'
  ].join('\n'), { filePath: 'metadata-only.md' });
  assert.strictEqual(frontMatterOnlyMarkdownAgent.ok, false);
  assert.ok(frontMatterOnlyMarkdownAgent.problems.includes('Missing default prompt text'));

  await withTempSkill(async (root) => {
    const promptRoot = path.join(root, 'prompt-root');
    fs.mkdirSync(path.join(promptRoot, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(promptRoot, 'agents', 'runtime-markdown.md'), [
      '# Runtime Markdown Agent',
      '',
      'This pure Markdown prompt must flow through prompts-root loading.',
      '',
      'Return stable runtime text.'
    ].join('\n'));

    const promptsRootAgents = loadAgentPromptsFromRoots([promptRoot], { rootDir: root });
    assert.strictEqual(promptsRootAgents.length, 1);
    assert.strictEqual(promptsRootAgents[0].ok, true);
    assert.strictEqual(promptsRootAgents[0].format, 'markdown');
    assert.strictEqual(promptsRootAgents[0].displayName, 'Runtime Markdown Agent');
    assert.ok(promptsRootAgents[0].defaultPrompt.includes('This pure Markdown prompt must flow'));

    const runtimeFormatted = formatAgentPromptForRuntime(promptsRootAgents[0]);
    assert.ok(runtimeFormatted.includes('Runtime Markdown Agent'));
    assert.ok(runtimeFormatted.includes('This pure Markdown prompt must flow through prompts-root loading.'));

    const promptCheck = await runCheckMain('../scripts/check-prompts.js', {
      AGENT_PROMPT_EXTRA_ROOTS: promptRoot
    });
    assert.strictEqual(promptCheck.code, 0);
    assert.ok(promptCheck.output.includes('prompt-root/agents/runtime-markdown.md'));
    assert.ok(promptCheck.output.includes('Runtime Markdown Agent'));

    const agentCheck = await runCheckMain('../scripts/check-agent.js', {
      AGENT_PROMPT_EXTRA_ROOTS: promptRoot,
      CHECK_RUN: '0'
    });
    assert.strictEqual(agentCheck.code, 0);
    assert.ok(agentCheck.output.includes('agent prompt assets parsed:'));
  });

  await withTempSkill(async (root) => {
    const invalidPromptRoot = path.join(root, 'invalid-prompt-root');
    fs.mkdirSync(path.join(invalidPromptRoot, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(invalidPromptRoot, 'agents', 'empty.md'), '');
    fs.writeFileSync(path.join(invalidPromptRoot, 'agents', 'frontmatter-only.md'), [
      '---',
      'name: Frontmatter Only',
      'description: no body',
      '---'
    ].join('\n'));

    const invalidPrompts = loadAgentPromptsFromRoots([invalidPromptRoot], { rootDir: root });
    assert.strictEqual(invalidPrompts.length, 2);
    assert.strictEqual(invalidPrompts.filter((item) => !item.ok).length, 2);
    assert.deepStrictEqual(checkPrompts.summarizeAgentPromptFormats(invalidPrompts), {
      total: 2,
      markdown: 2,
      yaml: 0,
      invalid: 2
    });

    const promptCheck = await runCheckMain('../scripts/check-prompts.js', {
      AGENT_PROMPT_EXTRA_ROOTS: invalidPromptRoot
    });
    assert.strictEqual(promptCheck.code, 1);
    assert.ok(promptCheck.output.includes('agent prompt formats: total='));
    assert.ok(promptCheck.output.includes('invalid=2'));
    assert.ok(promptCheck.output.includes('Missing default prompt text'));
  });

  await withTempSkill(async (root, skillRoot) => {
    fs.writeFileSync(path.join(skillRoot, 'agents', 'plain.md'), [
      '# Plain Markdown Agent',
      '',
      'Use this plain Markdown prompt in the runtime.',
      '',
      '- Keep the response concise.',
      '- Preserve tool boundaries.'
    ].join('\n'));

    const prompts = loadSkillAgentPrompts(skillRoot);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].ok, true);
    assert.strictEqual(prompts[0].format, 'markdown');
    assert.strictEqual(prompts[0].displayName, 'Plain Markdown Agent');
    assert.ok(prompts[0].defaultPrompt.includes('Use this plain Markdown prompt in the runtime.'));

    const validation = nativeSkillValidation.validateSkillByName(root, 'markdown-agent-skill');
    assert.ok(validation.includes('Valid: yes'));
    assert.ok(validation.includes('Agent prompts: 1'));

    process.env.MIZUKI_SKILLS_DIR = root;
    delete require.cache[require.resolve('../api/toolExecutors')];
    const { _test } = require('../api/toolExecutors');
    const runtimeText = await _test.loadSkillReference('markdown-agent-skill', {});
    assert.ok(runtimeText.includes('AGENT_PROMPTS:'));
    assert.ok(runtimeText.includes('Plain Markdown Agent'));
    assert.ok(runtimeText.includes('Use this plain Markdown prompt in the runtime.'));

    const promptCheck = await runCheckMain('../scripts/check-prompts.js', {
      AGENT_PROMPT_EXTRA_ROOTS: root
    });
    assert.strictEqual(promptCheck.code, 0);
    assert.ok(promptCheck.output.includes('agent prompt parsed'));
    assert.ok(promptCheck.output.includes('Plain Markdown Agent'));

    const agentCheck = await runCheckMain('../scripts/check-agent.js', {
      AGENT_PROMPT_EXTRA_ROOTS: root,
      CHECK_RUN: '0'
    });
    assert.strictEqual(agentCheck.code, 0);
    assert.ok(agentCheck.output.includes('agent prompt assets parsed:'));
  });

  console.log('agentPrompts.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
