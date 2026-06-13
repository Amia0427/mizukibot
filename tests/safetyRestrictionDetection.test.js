const assert = require('assert');
const { sanitizeUserFacingText } = require('../utils/userFacingText');

console.log('Testing safety restriction detection...\n');

// Test 1: 带有 /% 标记的文本
const test1 = '这个话题我们还是不聊了吧/%';
const result1 = sanitizeUserFacingText(test1, { returnMeta: true });
console.log('Test 1 - With /%:');
console.log('Input:', test1);
console.log('Output:', result1);
assert.strictEqual(typeof result1, 'object', 'Should return object');
assert.strictEqual(result1.hasSafetyRestriction, true, 'Should detect safety restriction');
assert.strictEqual(result1.text, '这个话题我们还是不聊了吧', 'Should remove /%');
console.log('✅ Test 1 passed\n');

// Test 2: 不带 /% 的正常文本
const test2 = '这是普通的回复';
const result2 = sanitizeUserFacingText(test2, { returnMeta: true });
console.log('Test 2 - Without /%:');
console.log('Input:', test2);
console.log('Output:', result2);
assert.strictEqual(typeof result2, 'object', 'Should return object');
assert.strictEqual(result2.hasSafetyRestriction, false, 'Should not detect safety restriction');
assert.strictEqual(result2.text, '这是普通的回复', 'Text should be unchanged');
console.log('✅ Test 2 passed\n');

// Test 3: 带空格的 /%
const test3 = '好的，那我们换个话题吧   /%  ';
const result3 = sanitizeUserFacingText(test3, { returnMeta: true });
console.log('Test 3 - With /% and spaces:');
console.log('Input:', test3);
console.log('Output:', result3);
assert.strictEqual(result3.hasSafetyRestriction, true, 'Should detect safety restriction with spaces');
assert.strictEqual(result3.text.trim(), '好的，那我们换个话题吧', 'Should remove /% and trailing spaces');
console.log('✅ Test 3 passed\n');

// Test 4: 向后兼容性 - 不带 returnMeta
const test4 = '普通文本';
const result4 = sanitizeUserFacingText(test4);
console.log('Test 4 - Backward compatibility:');
console.log('Input:', test4);
console.log('Output:', result4);
assert.strictEqual(typeof result4, 'string', 'Should return string without returnMeta');
assert.strictEqual(result4, '普通文本', 'Should return clean text');
console.log('✅ Test 4 passed\n');

console.log('All tests passed! ✅');
