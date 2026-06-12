const assert = require('assert');

const {
  isCycleTlsMisdirectedRequest
} = require('../src/model/http/model-post.chunk');

const cycleTls421 = new Error('Request failed with status code 421');
cycleTls421.response = {
  status: 421,
  request: {
    transport: 'cycletls'
  }
};
assert.strictEqual(isCycleTlsMisdirectedRequest(cycleTls421), true);

const axios421 = new Error('Request failed with status code 421');
axios421.response = {
  status: 421,
  request: {
    transport: 'axios'
  }
};
assert.strictEqual(isCycleTlsMisdirectedRequest(axios421), false);

const cycleTls403 = new Error('Request failed with status code 403');
cycleTls403.response = {
  status: 403,
  request: {
    transport: 'cycletls'
  }
};
assert.strictEqual(isCycleTlsMisdirectedRequest(cycleTls403), false);

console.log('modelHttpCycleTlsFallback.test.js passed');
