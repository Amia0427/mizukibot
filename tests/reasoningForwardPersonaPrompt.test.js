const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const promptPath = path.join(__dirname, '..', 'prompts', 'runtime', 'reasoning-forward-persona.txt');
  const manifestPath = path.join(__dirname, '..', 'prompts', 'prompt-manifest.json');
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sections = Array.isArray(manifest?.system_prompt?.sections)
    ? manifest.system_prompt.sections
    : [];

  assert.ok(
    sections.some((section) => section.id === 'runtime_reasoning_forward_persona'
      && section.path === 'runtime/reasoning-forward-persona.txt'
      && section.include_in_system_prompt === false),
    'reasoning forward persona prompt should be registered as a runtime-only template'
  );
  assert.ok(prompt.includes('不要输出完整推理链'), 'prompt should forbid full chain-of-thought');
  assert.ok(prompt.includes('模型自述'), 'prompt should forbid model self-description');
  assert.ok(prompt.includes('短暂想法'), 'prompt should anchor the visible short inner-note style');
  assert.ok(prompt.includes('不要复述主回复'), 'prompt should avoid duplicating the final reply');

  console.log('reasoningForwardPersonaPrompt.test.js passed');
})();
