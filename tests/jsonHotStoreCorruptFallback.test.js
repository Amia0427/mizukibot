const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJsonHotStore } = require('../utils/jsonHotStore');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-hot-store-corrupt-'));

try {
  const nulFile = path.join(tmpDir, 'nul.json');
  fs.writeFileSync(nulFile, Buffer.alloc(32));
  const nulStore = createJsonHotStore(nulFile, {
    fallback: () => ({ recovered: true })
  });
  assert.deepStrictEqual(nulStore.read(), { recovered: true });

  const badJsonFile = path.join(tmpDir, 'bad.json');
  fs.writeFileSync(badJsonFile, '{"broken":', 'utf8');
  const badJsonStore = createJsonHotStore(badJsonFile, {
    fallback: () => ({ recovered: 'bad-json' })
  });
  assert.deepStrictEqual(badJsonStore.read(), { recovered: 'bad-json' });

  const readOnlyFile = path.join(tmpDir, 'readonly.json');
  fs.writeFileSync(readOnlyFile, JSON.stringify({ old: true }), 'utf8');
  fs.chmodSync(readOnlyFile, 0o444);
  const readOnlyStore = createJsonHotStore(readOnlyFile, {
    fallback: () => ({ recovered: 'readonly' })
  });
  assert.deepStrictEqual(readOnlyStore.read(), { old: true });
  readOnlyStore.replace({ ok: true }, { flushNow: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(readOnlyFile, 'utf8')), { ok: true });
} finally {
  try {
    fs.chmodSync(path.join(tmpDir, 'readonly.json'), 0o666);
  } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
