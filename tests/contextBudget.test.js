const assert = require('assert');

const {
  estimateTokens,
  trimTextByTokenBudget
} = require('../utils/contextBudget');

function trimTextByTokenBudgetLinear(text, tokenBudget, strategy = 'tail') {
  const input = String(text || '');
  const budget = Math.max(0, Number(tokenBudget) || 0);
  if (!input || budget <= 0) return '';
  if (estimateTokens(input) <= budget) return input;

  if (strategy === 'head') {
    let end = input.length;
    while (end > 0 && estimateTokens(input.slice(0, end)) > budget) end -= 32;
    return input.slice(0, Math.max(end, 0)).trim();
  }

  let start = 0;
  while (start < input.length && estimateTokens(input.slice(start)) > budget) start += 32;
  return input.slice(Math.min(start, input.length)).trim();
}

const samples = [
  'short text',
  `${'a'.repeat(47)}${'中文'.repeat(19)}${'z'.repeat(35)}`,
  `  ${'细节'.repeat(97)} mixed Latin text ${'😀'.repeat(13)}  `,
  `${'prefix '.repeat(33)}${'尾部'.repeat(41)}x`
];
const budgets = [1, 7, 31, 64, 127, 256, 512];

for (const sample of samples) {
  for (const strategy of ['head', 'tail']) {
    for (const budget of budgets) {
      assert.strictEqual(
        trimTextByTokenBudget(sample, budget, strategy),
        trimTextByTokenBudgetLinear(sample, budget, strategy),
        `${strategy} budget=${budget} should preserve linear trimming semantics`
      );
    }
  }
}

console.log('contextBudget.test.js passed');
