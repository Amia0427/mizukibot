const assert = require('assert');
const { escapeHtml, renderGreetingEmail, renderVerificationEmail } = require('../src/features/email-greetings/template');

assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
const message = renderGreetingEmail({
  subject: '七夕 <测试>',
  greeting: '小明',
  body: '愿你今天开心。\n不要有压力。',
  closing: '瑞希',
  dateLabel: '2026年8月19日',
  events: [{ name: '七夕 <测试>' }]
});
assert.ok(message.html.includes('七夕 &lt;测试&gt;'));
assert.ok(!message.html.includes('<script>'));
assert.ok(message.text.includes('愿你今天开心。'));
assert.ok(renderVerificationEmail('123456').html.includes('123456'));

console.log('emailGreetingTemplate.test.js passed');
