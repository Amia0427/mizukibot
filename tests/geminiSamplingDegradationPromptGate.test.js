const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const { recordGeminiRecentStyleSignal } = require('../utils/geminiRecentStyleGuard');

module.exports = (async () => {
  const previousStyleStorePath = process.env.GEMINI_RECENT_STYLE_STORE_PATH;
  const tempStyleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-style-gate-'));
  process.env.GEMINI_RECENT_STYLE_STORE_PATH = path.join(tempStyleDir, 'signals.json');
  try {
  const ambient = await buildDynamicPrompt(
    { level: 'friend', points: 10 },
    'u_gemini_sampling_ambient',
    '区',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: 'old profile: 用户之前聊过完全无关的成人玩笑。',
        promptRetrievedMemoryText: 'old profile: 用户之前聊过完全无关的成人玩笑。',
        promptDailyJournalText: '2026-05-18 无关旧日记。',
        dailyJournalText: '2026-05-18 无关旧日记。',
        promptLongTermProfileText: '用户偏好被夸张角色化。',
        promptImpressionText: '用户正在开玩笑。',
        summary: '旧聊天摘要。',
        diagnostics: {
          memoryTrace: {
            retrieval_path: 'prepare_fallback_no_rag',
            injected_block_ids: ['retrieved_memory_lite', 'daily_journal'],
            hits: []
          }
        }
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [],
            rationaleByBlock: {}
          }
        }
      }
    }
  );

  const ambientIds = ambient.promptSnapshot.assembledBlocks.map((item) => item.id);
  const ambientText = ambient.promptSnapshot.assembledBlocks.map((item) => item.content).join('\n');
  assert.ok(!ambientIds.includes('retrieved_memory_lite'));
  assert.ok(!ambientIds.includes('daily_journal'));
  assert.ok(!ambientIds.includes('memory_recall_policy'));
  assert.ok(!ambientText.includes('无关的成人玩笑'));
  assert.ok(!ambientText.includes('无关旧日记'));

  const recall = await buildDynamicPrompt(
    { level: 'friend', points: 10 },
    'u_gemini_sampling_recall',
    '你还记得我们昨天聊了什么吗',
    null,
    {
      routePolicyKey: 'lookup/notebook-answer',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '[RelevantEvidence] 昨天聊了汤咖喱和素材店。',
        promptRetrievedMemoryText: '[RelevantEvidence] 昨天聊了汤咖喱和素材店。',
        promptDailyJournalText: 'date: 2026-06-12\n昨天聊了汤咖喱和素材店。',
        dailyJournalText: 'date: 2026-06-12\n昨天聊了汤咖喱和素材店。'
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', reason: 'planner missed recall' },
              { blockId: 'daily_journal', decision: 'skip', reason: 'planner missed recall' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );

  const recallIds = recall.promptSnapshot.assembledBlocks.map((item) => item.id);
  assert.ok(recallIds.includes('retrieved_memory_lite'));
  assert.ok(recallIds.includes('daily_journal'));

  recordGeminiRecentStyleSignal({
    assistantText: '诶——这个秘密小彩蛋有点犯规喔',
    modelName: 'gemini-3-flash-preview',
    userId: 'u_gemini_style_gate',
    groupId: 'g_style_gate',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    routeMeta: { chatType: 'group', groupId: 'g_style_gate' }
  });
  const guarded = await buildDynamicPrompt(
    { level: 'friend', points: 10 },
    'u_gemini_style_gate',
    '继续',
    null,
    {
      modelName: 'gemini-3-flash-preview',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'group', groupId: 'g_style_gate' }
    }
  );
  assert.ok(guarded.promptSnapshot.dynamicBlockIds.includes('gemini_recent_style_guard'));
  assert.ok(guarded.dynamicPrompt.includes('[GeminiRecentStyleGuard]'));
  assert.ok(guarded.dynamicPrompt.includes('秘密小彩蛋'));

  const adminGuarded = await buildDynamicPrompt(
    { level: 'friend', points: 10 },
    'admin_style_gate',
    '继续',
    null,
    {
      modelName: 'gemini-3-flash-preview',
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      routeMeta: { chatType: 'private' },
      isAdmin: true
    }
  );
  assert.ok(!adminGuarded.promptSnapshot.dynamicBlockIds.includes('gemini_recent_style_guard'));
  assert.ok(!adminGuarded.dynamicPrompt.includes('[GeminiRecentStyleGuard]'));
  } finally {
    if (previousStyleStorePath === undefined) delete process.env.GEMINI_RECENT_STYLE_STORE_PATH;
    else process.env.GEMINI_RECENT_STYLE_STORE_PATH = previousStyleStorePath;
    try {
      fs.rmSync(tempStyleDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();
