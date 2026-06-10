const fs = require('fs');
const path = require('path');

// 简单估算token（中文字符*1.8 + 英文单词*1.3）
function estimateTokens(text) {
  const chineseChars = (text.match(/[一-龥]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  const punctuation = (text.match(/[，。；！？、：""''（）]/g) || []).length;
  return Math.ceil(chineseChars * 1.8 + englishWords * 1.3 + punctuation * 0.5);
}

const files = [
  'SYSTEM.txt',
  'persona/01_identity.txt',
  'persona/02_style.txt',
  'persona/03_boundaries.txt',
  'persona/04_behavior.txt',
  'persona/05_voice_samples.txt',
  'persona/06_state_modulation.txt',
  'persona/09_liveness_authentic.txt'
];

console.log('=== Persona文件Token估算（优化后）===\n');

let total = 0;
const results = [];
files.forEach(file => {
  const fullPath = path.join(__dirname, '../prompts', file);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf8');
    const tokens = estimateTokens(content);
    const lines = content.split('\n').length;
    total += tokens;
    results.push({ file, tokens, lines });
    console.log(`${file.padEnd(50)} ${tokens.toString().padStart(5)} tokens (${lines} lines)`);
  }
});

console.log('\n' + '='.repeat(70));
console.log(`总计: ${total} tokens\n`);

console.log('=== 优化效果 ===\n');
console.log('优化前总计: 10,511 tokens');
console.log(`优化后总计: ${total} tokens`);
console.log(`减少: ${10511 - total} tokens (${((10511 - total) / 10511 * 100).toFixed(1)}%)\n`);

console.log('主要优化项：');
console.log('1. 删除 00_roleplay_liveness_prelude.txt (307 tokens) - 已合并到SYSTEM.txt');
console.log('2. 删除 08_human_imperfection.txt (938 tokens) - 已合并到02_style.txt');
console.log('3. 精简 01_identity.txt: 3208 → 2211 tokens (-997 tokens, -31%)');
console.log('4. 优化 02_style.txt: 1792 → 1152 tokens (-640 tokens, -36%)');
console.log('5. 精简 03_boundaries.txt: 1165 → 1018 tokens (-147 tokens, -13%)');
console.log('6. 增强 SYSTEM.txt: 282 → 422 tokens (+140 tokens, 包含合并内容)');
