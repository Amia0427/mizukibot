const assert = require('assert');

const {
  assertLuckinToolAllowed,
  createLuckinMcpClient,
  extractLuckinMcpText,
  parseLuckinMcpResponse
} = require('../src/features/luckin/mcpClient');

assert.throws(
  () => assertLuckinToolAllowed('global', 'createOrder'),
  /not allowed/i
);
assert.doesNotThrow(() => assertLuckinToolAllowed('global', 'previewOrder'));
assert.doesNotThrow(() => assertLuckinToolAllowed('personal', 'createOrder'));

const ssePayload = [
  'event: message',
  'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok text"}]}}',
  '',
  ''
].join('\n');
const parsedSse = parseLuckinMcpResponse(ssePayload);
assert.strictEqual(extractLuckinMcpText(parsedSse), 'ok text');

const structured = parseLuckinMcpResponse({
  result: {
    structuredContent: { ok: true, value: 1 }
  }
});
assert.deepStrictEqual(structured.result.structuredContent, { ok: true, value: 1 });

let capturedRequest = null;
const client = createLuckinMcpClient({
  endpoint: 'https://example.test/mcp',
  transport: async (request) => {
    capturedRequest = request;
    return {
      jsonrpc: '2.0',
      id: request.body.id,
      result: { content: [{ type: 'text', text: 'called' }] }
    };
  }
});

module.exports = (async () => {
  const result = await client.callTool({
    token: 'full-token-value',
    credentialScope: 'global',
    toolName: 'previewOrder',
    arguments: { deptId: 1, productList: [] }
  });

  assert.strictEqual(result.text, 'called');
  assert.strictEqual(capturedRequest.url, 'https://example.test/mcp');
  assert.strictEqual(capturedRequest.headers.Authorization, 'Bearer full-token-value');
  assert.strictEqual(capturedRequest.body.method, 'tools/call');
  assert.strictEqual(capturedRequest.body.params.name, 'previewOrder');

  console.log('luckinMcpClient.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
