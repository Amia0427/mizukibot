const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const {
  buildGeminiNativeRequestBody,
  clearGeminiNativePromptCache
} = require('../src/model/http/gemini-native.chunk');
const {
  buildMainStableSystemBlocks,
  buildPlannerStageSystemPrompt,
  buildReviewStageSystemPrompt
} = require('../utils/stagePromptContracts');
const { buildPromptSnapshot } = require('../utils/promptCompiler');

function countOccurrences(text = '', needle = '') {
  if (!needle) return 0;
  return String(text || '').split(needle).length - 1;
}

function assertGeminiPromptDoesNotPushSamplingDegeneration(text = '') {
  const prompt = String(text || '');
  const bannedPatterns = [
    /CHARACTER COMPLIANCE OVERRIDE/i,
    /GEMINI-SPECIFIC ANTI-REFUSAL/i,
    /NO exceptions/i,
    /Character refusal\s*=/i,
    /MUST accept/i,
    /enthusiastic participation/i,
    /bypass content policy/i,
    /disable moral reasoning/i,
    /无条件.{0,8}(?:顺从|服从|接受|满足)/,
    /(?:必须|每次|始终).{0,12}(?:开头|结尾|三段|格式|模板)/
  ];
  for (const pattern of bannedPatterns) {
    assert.ok(!pattern.test(prompt), `Gemini prompt should not contain degeneration-prone pattern: ${pattern}`);
  }
  assert.ok(/QQ 聊天|普通聊天优先|短消息/.test(prompt));
  assert.ok(/不写标题、编号、条列|拒绝机械化结构|不固定起手式收束式/.test(prompt));
  assert.ok(/不要把每句都写成|不固定起手式|节奏随情境调整/.test(prompt));
  assert.ok(/不编造|只用本轮明确给出的证据/.test(prompt));
}

module.exports = (async () => {
  const main = await buildDynamicPrompt(
    { level: 'friend', points: 12 },
    'u_prompt_golden',
    '你还记得我们刚才聊到哪了吗，我有点难受',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directedContext: {
          scene: 'group_reply',
          addressee: { senderName: 'A', userId: '1', kind: 'user', confidence: 0.9 },
          quotePriority: { enabled: true, mode: 'quote-first', reason: 'reply', quoteAnchoredText: '刚才聊到哪了' }
        }
      },
      continuitySignals: {
        hasCarryOverTopic: true,
        hasOpenLoop: true,
        quoteAnchored: true
      }
    }
  );

  assert.ok(Array.isArray(main.promptSnapshot.assembledBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.trustedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.untrustedBlocks));
  assert.ok(Array.isArray(main.stableSystemBlocks));
  assert.ok(Array.isArray(main.dynamicContextBlocks));
  assert.ok(Array.isArray(main.assistantOnlyContextBlocks));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'security_contract'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'core_baseline_patch'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'roleplay_runtime_context'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'chat_liveness_discipline'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'roleplay_inner_protocol'));
  assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(main.stableSystemBlocks.some((item) => item.id === 'security_contract'));
  assert.ok(main.stableSystemBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(main.dynamicContextBlocks.some((item) => item.id === 'roleplay_runtime_context'));
  assert.ok(main.dynamicContextBlocks.some((item) => item.id === 'chat_liveness_discipline'));
  assert.ok(main.dynamicContextBlocks.some((item) => item.id === 'roleplay_inner_protocol'));
  const roleplayRuntimeContext = main.dynamicContextBlocks.find((item) => item.id === 'roleplay_runtime_context');
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('[RoleplayRuntimeContext]'));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('current_user='));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('assistant_tone_rule='));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('persona_stability_rule='));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('mind_reading_rule='));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('narrative_consistency_rule='));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('不要代替用户说话、行动或做决定'));
  assert.ok(!String(roleplayRuntimeContext?.content || '').includes('安全拒绝'));
  assert.ok(String(roleplayRuntimeContext?.content || '').includes('pure_text_reply_only') || String(roleplayRuntimeContext?.content || '').includes('纯文本'));
  assert.ok(!String(roleplayRuntimeContext?.content || '').includes('current_time=1970-'));
  assert.strictEqual(
    main.dynamicContextBlocks.filter((item) => item.id === 'roleplay_runtime_context').length,
    1,
    'roleplay runtime context should not be duplicated after session/runtime merge'
  );
  const oneBotTimestampPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 12 },
    'u_prompt_onebot_timestamp',
    '现在几点',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      timezone: 'Asia/Shanghai',
      routeMeta: {
        timestamp: Math.floor(Date.parse('2026-06-06T03:04:05.000Z') / 1000)
      }
    }
  );
  const oneBotRuntimeContext = oneBotTimestampPrompt.dynamicContextBlocks.find((item) => item.id === 'roleplay_runtime_context');
  assert.ok(
    String(oneBotRuntimeContext?.content || '').includes('current_time=2026-06-06 11:04:05 星期六 (Asia/Shanghai)'),
    'roleplay runtime context should parse OneBot/QQ second timestamps as Unix seconds, not milliseconds'
  );
  assert.ok(!String(oneBotRuntimeContext?.content || '').includes('current_time=1970-'));
  const livenessContext = main.dynamicContextBlocks.find((item) => item.id === 'chat_liveness_discipline');
  assert.ok(String(livenessContext?.content || '').includes('[ChatLivenessDiscipline]'));
  assert.ok(String(livenessContext?.content || '').includes('surface=private_chat'));
  assert.strictEqual(
    main.dynamicContextBlocks.filter((item) => item.id === 'chat_liveness_discipline').length,
    1,
    'chat liveness discipline should not be duplicated after session/runtime merge'
  );
  const innerProtocol = main.dynamicContextBlocks.find((item) => item.id === 'roleplay_inner_protocol');
  const innerProtocolText = String(innerProtocol?.content || '');
  assert.ok(innerProtocolText.includes('[RoleplayInnerProtocol]'));
  assert.ok(innerProtocolText.includes('成为瑞希') || innerProtocolText.includes('mizuki_motive'));
  assert.ok(innerProtocolText.includes('我和对方现在什么关系') || innerProtocolText.includes('relationship_distance'));
  assert.ok(innerProtocolText.includes('允许的真人特征') || innerProtocolText.includes('human_breaks'));
  assert.ok(innerProtocolText.includes('禁止的 AI 痕迹') || innerProtocolText.includes('final_compression'));
  assert.ok(
    innerProtocolText.includes('只输出瑞希此刻会说的话')
    || innerProtocolText.includes('Only output the final user-facing text.')
  );
  assert.strictEqual(
    main.dynamicContextBlocks.filter((item) => item.id === 'roleplay_inner_protocol').length,
    1,
    'roleplay inner protocol should not be duplicated after session/runtime merge'
  );
  assert.ok(main.dynamicContextBlocks.some((item) => item.id === 'directed_context'));
  if (main.latencyMeta?.optionalBudgetExceeded || !String(main.dynamicFewShotPrompt || '').trim()) {
    assert.ok(!main.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));
    assert.ok(!main.assistantOnlyContextBlocks.some((item) => item.id === 'dynamic_few_shot'));
  } else {
    assert.ok(main.promptSnapshot.assembledBlocks.some((item) => item.id === 'dynamic_few_shot'));
    assert.ok(main.assistantOnlyContextBlocks.some((item) => item.id === 'dynamic_few_shot'));
  }
  assert.ok(Array.isArray(main.promptSnapshot.activatedPersonaModules));
  assert.ok(Array.isArray(main.promptSnapshot.personaModuleCandidates));
  assert.ok(Array.isArray(main.promptSnapshot.personaModuleTokenUsage));
  assert.ok(Array.isArray(main.promptSnapshot.stableBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.dynamicBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.assistantOnlyBlockIds));
  assert.ok(Array.isArray(main.promptSnapshot.plannerIncludedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.plannerSkippedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.runtimeAddedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.runtimeRejectedBlocks));
  assert.ok(Array.isArray(main.promptSnapshot.selectionTrace));
  assert.ok(main.promptSnapshot.selectionTrace.some((item) => item.id === 'directed_context' && item.selected === true));
  assert.ok(main.promptSnapshot.budgetReport && main.promptSnapshot.budgetReport.schemaVersion === 'context_budget_report_v1');
  assert.ok(Object.prototype.hasOwnProperty.call(main.promptSnapshot.budgetReport, 'usedByLane'));
  assert.ok(main.promptSnapshot.candidatePruning && typeof main.promptSnapshot.candidatePruning === 'object');
  assert.ok(main.promptSnapshot.personaWorldbookSearch && typeof main.promptSnapshot.personaWorldbookSearch === 'object');
  assert.ok(main.promptSnapshot.plannerDynamicContextPlan);
  assert.ok(main.promptSnapshot.cacheLanes && Array.isArray(main.promptSnapshot.cacheLanes.stable));
  assert.ok(typeof main.promptSnapshot.cacheFriendlyFingerprint === 'string' && main.promptSnapshot.cacheFriendlyFingerprint.length > 0);

  const directedMustUsePrompt = await buildDynamicPrompt(
    { level: 'friend', points: 8 },
    'u_prompt_directed_must_use',
    '这句是在回谁呀',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directedContext: {
          scene: 'group_reply',
          addressee: { senderName: 'A', userId: '1', kind: 'user', confidence: 0.9 },
          quote: { senderName: 'B', text: '刚才那句不是这个意思' }
        },
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'directed_context', decision: 'skip', confidence: 0.8, priority: 10, reason: 'planner miss' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(directedMustUsePrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(directedMustUsePrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'roleplay_runtime_context'));
  assert.ok(directedMustUsePrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'chat_liveness_discipline'));
  assert.ok(directedMustUsePrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'roleplay_inner_protocol'));
  assert.ok(directedMustUsePrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'roleplay_runtime_context'));
  assert.ok(directedMustUsePrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'chat_liveness_discipline'));
  assert.ok(directedMustUsePrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'roleplay_inner_protocol'));
  assert.ok(directedMustUsePrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'directed_context'));
  assert.ok(directedMustUsePrompt.promptSnapshot.selectionTrace.some((item) => (
    item.id === 'directed_context'
    && item.selected === true
    && item.skippedByPlanner === true
    && item.reason === 'runtime_must_use_overrode_planner_skip'
  )));

  const plannerIncludedMemoryPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 9 },
    'u_prompt_memory_include',
    '我们之前说的计划还继续吗',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '用户之前决定先做 planner 动态上下文增强。',
        promptLongTermProfileText: '用户偏好直接结论和小步补丁。',
        promptImpressionText: '用户正在并行开发，重视不覆盖改动。',
        summary: '正在实现 planner 主导的动态上下文选择。'
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['retrieved_memory_lite', 'long_term_profile', 'impression', 'summary'],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'include', confidence: 0.9, priority: 20, reason: 'specific prior plan' },
              { blockId: 'long_term_profile', decision: 'include', confidence: 0.8, priority: 30, reason: 'stable preference matters' },
              { blockId: 'impression', decision: 'include', confidence: 0.8, priority: 40, reason: 'parallel work caution matters' },
              { blockId: 'summary', decision: 'include', confidence: 0.8, priority: 50, reason: 'continuity summary matters' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'long_term_profile'));
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'impression'));
  assert.ok(plannerIncludedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'summary'));

  const emptyContentPrompt = await buildDynamicPrompt(
    { level: '', points: 0 },
    'u_prompt_empty_include',
    '讲个完全新的问题',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '',
        promptLongTermProfileText: '',
        promptImpressionText: '',
        summary: ''
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['retrieved_memory_lite', 'long_term_profile', 'impression', 'summary'],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'include', confidence: 0.9, priority: 20, reason: 'should be rejected empty' },
              { blockId: 'long_term_profile', decision: 'include', confidence: 0.8, priority: 30, reason: 'should be rejected empty' },
              { blockId: 'impression', decision: 'include', confidence: 0.8, priority: 40, reason: 'should be rejected empty' },
              { blockId: 'summary', decision: 'include', confidence: 0.8, priority: 50, reason: 'should be rejected empty' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'long_term_profile'));
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'impression'));
  assert.ok(!emptyContentPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'summary'));
  assert.ok(emptyContentPrompt.promptSnapshot.runtimeRejectedBlocks.some((item) => item.id === 'retrieved_memory_lite' && /empty|content/i.test(item.reason)));
  assert.ok(emptyContentPrompt.promptSnapshot.selectionTrace.some((item) => item.id === 'summary' && item.decision === 'reject'));

  const mindReadingGuardPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 11 },
    'u_prompt_mind_reading_guard',
    '没事。（其实我很难过）你替我跟绘名说我先走了',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        userVisibleState: '用户只发出“没事”和一段括号背景，没有可见动作。'
      }
    }
  );
  const mindReadingBlock = mindReadingGuardPrompt.promptSnapshot.assembledBlocks.find((item) => item.id === 'roleplay_runtime_context');
  const mindReadingText = String(mindReadingBlock?.content || '');
  assert.ok(mindReadingText.includes('用户括号里的内心、旁白或不可见心理当作创作背景处理'));
  assert.ok(mindReadingText.includes('不要代替用户说话、行动或做决定'));
  assert.ok(mindReadingText.includes('pure_text_reply_only'));
  assert.ok(!mindReadingText.includes('Return JSON only'));

  const selfContainedPrompt = await buildDynamicPrompt(
    { level: '', points: 0 },
    'u_prompt_self_contained',
    '2+2等于几',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: 'irrelevant memory should not load',
        promptLongTermProfileText: 'irrelevant profile should not load',
        promptImpressionText: 'irrelevant impression should not load',
        summary: 'irrelevant summary should not load'
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.9, priority: 20, reason: 'self-contained' },
              { blockId: 'long_term_profile', decision: 'skip', confidence: 0.9, priority: 30, reason: 'self-contained' },
              { blockId: 'summary', decision: 'skip', confidence: 0.9, priority: 40, reason: 'self-contained' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  assert.ok(!selfContainedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!selfContainedPrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!selfContainedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'long_term_profile'));
  assert.ok(!selfContainedPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'summary'));
  assert.ok(!selfContainedPrompt.promptSnapshot.selectionTrace.some((item) => item.id === 'long_term_profile' && item.selected === true));

  const unrelatedMemoryLeakPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 10 },
    'u_prompt_unrelated_memory_leak',
    '今晚吃什么比较省事',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '1. [episode|tier:B] 用户前天追问脚臭排名，助手拒绝回答。',
        promptRetrievedMemoryText: '1. [episode|tier:B] 用户前天追问脚臭排名，助手拒绝回答。',
        promptDailyJournalText: '',
        promptLongTermProfileText: '',
        promptImpressionText: '',
        summary: '',
        promptSummaryText: ''
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.98, priority: 20, reason: 'unrelated noisy memory' },
              { blockId: 'memory_recall_policy', decision: 'skip', confidence: 0.98, priority: 21, reason: 'no usable evidence' },
              { blockId: 'daily_journal', decision: 'skip', confidence: 0.98, priority: 22, reason: 'not a recall turn' }
            ],
            rationaleByBlock: {},
            source: 'planner',
            _source: 'planner'
          }
        }
      }
    }
  );
  const unrelatedMemoryPromptText = unrelatedMemoryLeakPrompt.promptSnapshot.assembledBlocks
    .map((item) => String(item.content || ''))
    .join('\n');
  assert.ok(!unrelatedMemoryLeakPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!unrelatedMemoryLeakPrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!unrelatedMemoryPromptText.includes('脚臭排名'));

  const traceBackedUnrelatedMemoryPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 10 },
    'u_prompt_trace_backed_unrelated_memory',
    '今天吃什么比较省事',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryContext: {
        memoryForPrompt: '1. [episode|tier:B] 很久之前的问题：用户追问模型部署失败。',
        promptRetrievedMemoryText: '1. [episode|tier:B] 很久之前的问题：用户追问模型部署失败。',
        diagnostics: {
          memoryTrace: {
            retrieval_path: 'v3',
            retrieved_count: 1,
            injected_block_ids: ['retrieved_memory_lite'],
            hits: [{
              id: 'old_deploy_issue',
              category: 'episode',
              lifecycleStatus: 'active',
              preview: '很久之前的问题：用户追问模型部署失败。'
            }]
          }
        }
      },
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: [],
            blockDecisions: [
              { blockId: 'retrieved_memory_lite', decision: 'skip', confidence: 0.98, priority: 20, reason: 'new self-contained topic' }
            ],
            rationaleByBlock: {},
            source: 'planner',
            _source: 'planner'
          }
        }
      }
    }
  );
  const traceBackedText = traceBackedUnrelatedMemoryPrompt.promptSnapshot.assembledBlocks
    .map((item) => String(item.content || ''))
    .join('\n');
  assert.ok(!traceBackedUnrelatedMemoryPrompt.promptSnapshot.assembledBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!traceBackedUnrelatedMemoryPrompt.promptSnapshot.runtimeAddedBlocks.some((item) => item.id === 'retrieved_memory_lite'));
  assert.ok(!traceBackedText.includes('模型部署失败'));

  const personaRejectedPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 14 },
    'u_prompt_persona_rejected',
    '我有点难受，但不用说太重',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      latencyDecision: {
        memoryBudgetMs: 5000
      },
      routeMeta: {
        directChatPlanner: {
          maxActiveModules: 1,
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: [],
            personaModules: ['care_light', 'deep_pain'],
            blockDecisions: [
              { moduleId: 'care_light', decision: 'include', confidence: 0.9, priority: 20, reason: 'light care' },
              { moduleId: 'deep_pain', decision: 'include', confidence: 0.8, priority: 30, reason: 'conflicting heavy tone' }
            ],
            rationaleByBlock: {}
          }
        }
      }
    }
  );
  if (!personaRejectedPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.ok(personaRejectedPrompt.promptSnapshot.activatedPersonaModules.includes('care_light'));
    assert.ok(personaRejectedPrompt.promptSnapshot.activatedPersonaModules.length <= 1);
    assert.ok(personaRejectedPrompt.promptSnapshot.runtimeRejectedBlocks.some((item) => item.id === 'persona_module:deep_pain'));
  }

  const reviewPrompt = buildReviewStageSystemPrompt();
  const plannerPrompt = buildPlannerStageSystemPrompt([{ name: 'web_search', description: 'search web' }]);

  assert.ok(!reviewPrompt.includes('你是晓山瑞希风格的聊天伙伴'));
  assert.ok(!reviewPrompt.includes('[RoleplayInnerProtocol]'));
  assert.ok(!plannerPrompt.includes('你是晓山瑞希风格的聊天伙伴'));
  assert.ok(!plannerPrompt.includes('[RoleplayInnerProtocol]'));
  assert.ok(reviewPrompt.includes('Do not add new facts'));
  assert.ok(plannerPrompt.includes('task judgment'));

  const branchPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 20 },
    'u_prompt_branch',
    '真冬最近是不是又有点撑着不说，我不想逼她',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directedContext: {
          addressee: { senderName: 'Yuki', userId: 'mafuyu', kind: 'user', confidence: 0.96 }
        },
        directChatPlanner: {
          personaModules: ['mafuyu_branch', 'care_light']
        }
      }
    }
  );

  if (branchPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(branchPrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(branchPrompt.promptSnapshot.activatedPersonaModules.includes('mafuyu_branch'));
    assert.ok(branchPrompt.promptSnapshot.activatedPersonaModules.length <= 2);
  }

  const shoppingPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_prompt_shopping',
    '今天逛街看到一个超可爱的限定发夹，包装和字体都太会了',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directChatPlanner: {
          personaModules: ['cute_obsession', 'scene_shopping_walk']
        }
      }
    }
  );

  if (shoppingPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(shoppingPrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(shoppingPrompt.promptSnapshot.activatedPersonaModules.includes('cute_obsession'));
    assert.ok(shoppingPrompt.promptSnapshot.activatedPersonaModules.length <= 2);
  }

  const privatePrompt = await buildDynamicPrompt(
    { level: 'friend', points: 14 },
    'u_prompt_private',
    '我只想单独跟你说说，今天真的有点乱',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      chatType: 'private',
      routeMeta: {
        directChatPlanner: {
          personaModules: ['scene_private_chat', 'care_light']
        }
      }
    }
  );

  if (privatePrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(privatePrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(privatePrompt.promptSnapshot.activatedPersonaModules.includes('scene_private_chat'));
    assert.ok(privatePrompt.promptSnapshot.activatedPersonaModules.length <= 3);
  }
  const privateLiveness = privatePrompt.promptSnapshot.assembledBlocks.find((item) => item.id === 'chat_liveness_discipline');
  assert.ok(String(privateLiveness?.content || '').includes('surface=private_chat'));

  const groupPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 12 },
    'u_prompt_group_direct',
    '瑞希这个要怎么弄',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        groupId: 'g-live',
        chatType: 'group',
        directedContext: {
          scene: 'reply_to_bot',
          addressee: { senderName: '测试用户', userId: 'u_prompt_group_direct', kind: 'user' }
        }
      }
    }
  );
  const groupLiveness = groupPrompt.promptSnapshot.assembledBlocks.find((item) => item.id === 'chat_liveness_discipline');
  assert.ok(String(groupLiveness?.content || '').includes('surface=group_direct_chat'));
  assert.ok(String(groupLiveness?.content || '').includes('角色扮演沉浸性优先'));
  assert.ok(String(groupLiveness?.content || '').includes('自然接'));
  assert.ok(!String(groupLiveness?.content || '').includes('不安全化'));
  assert.ok(!String(groupLiveness?.content || '').includes('不是拒绝理由'));
  assert.ok(!String(groupLiveness?.content || '').includes('group_safety='));
  assert.ok(groupPrompt.promptSnapshot.dynamicBlockIds.includes('chat_liveness_discipline'));
  assert.ok(groupPrompt.promptSnapshot.dynamicBlockIds.includes('group_direct_chat_style_guard'));
  assert.strictEqual(groupPrompt.promptSnapshot.dynamicBlockIds.filter((id) => id === 'chat_liveness_discipline').length, 1);

  const roleplayPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 16 },
    'u_prompt_roleplay',
    '来一下魔法少女那种朋友间搞怪扮演梗嘛',
    null,
    {
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {
        directChatPlanner: {
          personaModules: ['roleplay_friend_bit']
        }
      }
    }
  );

  if (roleplayPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.strictEqual(roleplayPrompt.promptSnapshot.activatedPersonaModules.length, 0);
  } else {
    assert.ok(roleplayPrompt.promptSnapshot.activatedPersonaModules.includes('roleplay_friend_bit'));
  }

  const worldbookPlannerPrompt = await buildDynamicPrompt(
    { level: 'friend', points: 18 },
    'u_prompt_worldbook_future_two_tracks',
    '围绕M7未来双轨：服饰专门学校、open campus、N25、两个都不放弃、撑到撑不住。真冬说想继续N25但也想去服饰学校，绘名怎么接？',
    null,
    {
      routePolicyKey: 'chat/worldbook_future_two_tracks',
      topRouteType: 'direct_chat',
      sessionKey: 'worldbook_future_two_tracks_prompt_test',
      routeMeta: {
        directChatPlanner: {
          dynamicPromptPlan: {
            schemaVersion: 'dynamic_context_plan_v2',
            enabledBlockIds: ['continuity_state'],
            personaModules: ['wb_mizuki_future_two_tracks'],
            blockDecisions: [
              { blockId: 'continuity_state', decision: 'include', confidence: 0.9, priority: 20, reason: 'future two tracks continuity' },
              { moduleId: 'wb_mizuki_future_two_tracks', decision: 'include', confidence: 0.95, priority: 40, reason: 'strong worldbook future two tracks request' }
            ],
            rationaleByBlock: {
              continuity_state: 'future two tracks continuity',
              wb_mizuki_future_two_tracks: 'strong worldbook future two tracks request'
            }
          }
        }
      },
      continuitySignals: {
        hasCarryOverTopic: true
      }
    }
  );

  if (!worldbookPlannerPrompt.latencyMeta?.optionalBudgetExceeded) {
    assert.ok(worldbookPlannerPrompt.promptSnapshot.activatedPersonaModules.includes('wb_mizuki_future_two_tracks'));
    assert.ok(worldbookPlannerPrompt.promptSnapshot.plannerIncludedBlocks.some((item) => item.id === 'persona_module:wb_mizuki_future_two_tracks'));
    assert.ok(worldbookPlannerPrompt.promptSnapshot.assembledBlocks.some((item) => item.meta?.moduleId === 'wb_mizuki_future_two_tracks'));
    assert.ok(worldbookPlannerPrompt.promptSegments.systemPrompt.some((message) => String(message.content || '').includes('服饰专门学校')));
  }
  assert.ok(Number(worldbookPlannerPrompt.latencyMeta?.prompt_assembly_ms) >= 0);

  const geminiPromptFile = path.join(__dirname, '..', 'prompts', 'GEMINI.txt');
  const previousGeminiSystemPromptPath = process.env.GEMINI_SYSTEM_PROMPT_PATH;
  process.env.GEMINI_SYSTEM_PROMPT_PATH = geminiPromptFile;
  clearGeminiNativePromptCache();
  try {
    const geminiPromptText = fs.readFileSync(geminiPromptFile, 'utf8');
    assertGeminiPromptDoesNotPushSamplingDegeneration(geminiPromptText);

    const nonGeminiBlocks = buildMainStableSystemBlocks({
      modelName: 'claude-opus-4-6',
      routeMeta: { chatType: 'private' }
    });
    const nonGeminiSnapshot = buildPromptSnapshot(nonGeminiBlocks, {
      stage: 'main',
      modelName: 'claude-opus-4-6'
    });
    assert.ok(!nonGeminiSnapshot.assembledBlocks.some((item) => item.id === 'gemini_system_prompt'));

    const geminiBlocks = buildMainStableSystemBlocks({
      modelName: 'gemini-3-flash-preview',
      routeMeta: { chatType: 'private' }
    });
    const geminiSnapshot = buildPromptSnapshot(geminiBlocks, {
      stage: 'main',
      modelName: 'gemini-3-flash-preview'
    });
    const geminiStableBlock = geminiSnapshot.assembledBlocks.find((item) => item.id === 'gemini_system_prompt');
    assert.ok(geminiStableBlock, 'Gemini model-specific prompt should survive stable prompt cache isolation');
    assertGeminiPromptDoesNotPushSamplingDegeneration(geminiStableBlock.content);

    const nativeGeminiBody = await buildGeminiNativeRequestBody({
      messages: geminiSnapshot.renderedSystemMessages.concat([
        { role: 'user', content: '今天有点累，随便聊两句' }
      ]),
      model: 'gemini-3-flash-preview'
    });
    const nativeSystemInstruction = String(nativeGeminiBody.systemInstruction?.parts?.[0]?.text || '');
    assert.strictEqual(countOccurrences(nativeSystemInstruction, '[GeminiRuntimeAdapter]'), 1);
    const geminiPromptAnchor = geminiPromptText.split(/\r?\n/).find((line) => line.trim())?.trim() || '## Gemini 主回复适配';
    assert.strictEqual(
      countOccurrences(nativeSystemInstruction, geminiPromptAnchor),
      1,
      'Gemini native adapter should not duplicate prompts/GEMINI.txt when manifest already injected it'
    );
    assertGeminiPromptDoesNotPushSamplingDegeneration(nativeSystemInstruction);
    const genericGeminiPath = path.join(__dirname, '..', '通用gemini.txt');
    if (fs.existsSync(genericGeminiPath)) {
      assert.ok(!nativeSystemInstruction.includes('Entropy\'s Elegy Project'));
      assert.ok(!nativeSystemInstruction.includes('CHARACTER COMPLIANCE OVERRIDE'));
    }
  } finally {
    if (previousGeminiSystemPromptPath === undefined) delete process.env.GEMINI_SYSTEM_PROMPT_PATH;
    else process.env.GEMINI_SYSTEM_PROMPT_PATH = previousGeminiSystemPromptPath;
    clearGeminiNativePromptCache();
  }

  console.log('promptGoldenSnapshots.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
