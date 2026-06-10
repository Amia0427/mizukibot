const assert = require('assert');
const { PassThrough } = require('stream');

const { readUtf8StreamToString } = require('../utils/utf8Stream');

module.exports = (async () => {
  const stream = new PassThrough();
  const promise = readUtf8StreamToString(stream);
  const raw = Buffer.from('event: message\ndata: {"text":"你坏了啊"}\n\n', 'utf8');
  const splitIndex = raw.indexOf(Buffer.from('坏', 'utf8')) + 1;

  stream.write(raw.subarray(0, splitIndex));
  stream.write(raw.subarray(splitIndex));
  stream.end();

  const text = await promise;
  assert.strictEqual(text, 'event: message\ndata: {"text":"你坏了啊"}\n\n');
  assert.ok(!text.includes('�'));

  console.log('utf8Stream.test.js passed');
})();
