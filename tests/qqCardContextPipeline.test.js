const assert = require('assert');

const {
  buildMergedMessagePayload,
  cheapParseMessageEntry,
  normalizeMessageForDownstream,
  resolveContinuousEntryDetails
} = require('../core/continuousMessagePreprocessor');
const { buildInboundMessageContext } = require('../core/messageContracts');

const payload = {
  app: 'com.tencent.structmsg',
  view: 'music',
  meta: {
    music: {
      title: '卡片歌曲',
      desc: '卡片歌手',
      tag: '网易云音乐',
      preview: 'https://img.example.com/song.jpg',
      musicUrl: 'https://music.163.com/m/song?id=186016&userid=1'
    }
  }
};

module.exports = (async () => {
  const cardEntry = cheapParseMessageEntry({
    message_id: 'card-1',
    message_type: 'private',
    message: [{ type: 'json', data: { data: JSON.stringify(payload) } }]
  });
  assert.strictEqual(cardEntry.cardOnly, true);
  assert.strictEqual(cardEntry.cardContexts.length, 1);
  assert.deepStrictEqual(cardEntry.qqCardUrls, ['https://music.163.com/#/song?id=186016']);

  await resolveContinuousEntryDetails(cardEntry, { resolveReply: false });
  assert.match(cardEntry.text, /^\[分享链接\] https:\/\/music\.163\.com\/#\/song\?id=186016$/);

  const pureMerged = buildMergedMessagePayload([cardEntry]);
  assert.strictEqual(pureMerged.cardOnly, true);
  assert.strictEqual(pureMerged.cardContexts.length, 1);

  const noteEntry = cheapParseMessageEntry({
    message_id: 'text-1',
    message_type: 'private',
    raw_message: '帮我评价一下',
    message: [{ type: 'text', data: { text: '帮我评价一下' } }]
  });
  const merged = buildMergedMessagePayload([cardEntry, noteEntry]);
  assert.strictEqual(merged.cardOnly, false);
  assert.strictEqual(merged.cardContexts.length, 1);

  const effectiveMsg = normalizeMessageForDownstream({ message_id: 'card-1' }, merged);
  assert.strictEqual(effectiveMsg.__continuousMessageMeta.cardOnly, false);
  assert.strictEqual(effectiveMsg.__continuousMessageMeta.cardContexts[0].kind, 'music');
  assert.deepStrictEqual(effectiveMsg.__continuousMessageMeta.qqCardUrls, ['https://music.163.com/#/song?id=186016']);

  const inbound = buildInboundMessageContext({
    effectiveMsg,
    continuousMeta: effectiveMsg.__continuousMessageMeta,
    rawText: effectiveMsg.raw_message,
    cleanText: merged.text
  });
  assert.strictEqual(inbound.cardOnly, false);
  assert.strictEqual(inbound.cardContexts[0].title, '卡片歌曲');
  assert.deepStrictEqual(inbound.qqCardUrls, ['https://music.163.com/#/song?id=186016']);

  console.log('qqCardContextPipeline.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
