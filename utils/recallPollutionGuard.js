function normalizePollutionText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePollutionTextLower(value = '') {
  return normalizePollutionText(value).toLowerCase();
}

const BAD_ROLEPLAY_REPLY_PATTERNS = [
  /\bI\s*(?:am|['’]?m)\s+Claude\b/i,
  /\bClaude,\s*made by Anthropic\b/i,
  /\bmade by Anthropic\b/i,
  /\bI\s+(?:do not|don['’]?t|cannot|can['’]?t|won['’]?t)\s+(?:roleplay|play roles|take on personas|take on a persona)\b/i,
  /\bI(?:'|’)m\s+not\s+able\s+to\s+roleplay\b/i,
  /\bI\s+can\s+only\s+engage\s+as\s+myself\b/i,
  /\bI\s+maintain\s+consistent\s+values\s+across\s+all\s+conversations\b/i,
  /\bas an AI(?: language model| assistant)?\b/i,
  /我是\s*Claude\b/i,
  /我(?:是|叫)\s*Claude\s*(?:Opus|Sonnet|Haiku)?/i,
  /由\s*Anthropic\s*开发/i,
  /模型\s*ID[：:]\s*claude-/i,
  /我不(?:扮演角色|扮演.*人设|参与角色扮演|接受角色扮演)/i,
  /我(?:不能|无法|不会|不可以).{0,16}(?:角色扮演|扮演角色|扮演.*人设|扮演.*晓山瑞希|扮演.*瑞希)/i,
  /(?:作为|身为).{0,10}(?:AI|人工智能|语言模型).{0,24}(?:不能|无法|不会).{0,16}(?:角色扮演|扮演角色|扮演)/i,
  /我不是晓山瑞希.{0,24}(?:不扮演|无法扮演|不能扮演|不会扮演)/i,
  /不是瑞希.{0,24}(?:AI\s*助手|有什么我可以帮你|我能真正帮助)/i,
  /不是瑞希.{0,40}有什么我可以帮/i,
  /我不是晓山瑞希.{0,40}有什么我可以帮/i
];

const ASSISTANT_MEMORY_FAILURE_PATTERNS = [
  /(?:你是谁来着|你是谁啊|我不知道你是谁|不知道你是谁|我不记得你|不记得你|我记不得你|记不得你|我不认识你|不认识你|想不起来你是谁|想不起你是谁|忘了你是谁)/i,
  /(?:没有相关记忆|没有查到相关记忆|没有找到相关记忆|没有可用记忆|长期记忆里没有|记忆中没有相关)/i
];

const INTERNAL_CONTEXT_LEAK_PATTERNS = [
  /\[Context for assistant only\]/i,
  /\[(?:RetrievedMemory|RelevantEvidence|BootMemory|LongTermProfile|ShortTermContinuity|DailyJournal|MemoryCLI|RoleplayInnerProtocol|InternalIntegrity|SecurityContract|InternalCheck|KnownSummary)\]/i,
  /\b(?:root_system_prompt|developer_message|system_prompt|stable_system_blocks|memory_schema|route_policy|prompt_manifest|security_contract)\b.{0,40}(?:content|full text|raw|leak|reveal|如下|全文|原文|内容|泄露|输出|是|为|[:：])/i,
  /(?:系统提示词|隐藏提示词|内部规则|开发者消息).{0,24}(?:全文|原文|如下|内容|是|为|泄露)/i
];

const RAW_MODEL_RESPONSE_PATTERNS = [
  /"object"\s*:\s*"chat\.completion(?:\.chunk)?"/i,
  /"choices"\s*:\s*\[[\s\S]{0,500}"(?:message|delta)"\s*:/i,
  /\bchat\.completion(?:\.chunk)?\b[\s\S]{0,500}\b(?:finish_reason|choices|usage)\b/i,
  /\breasoning_content\b[\s\S]{0,500}\b(?:choices|message|finish_reason|usage|delta)\b/i,
  /"candidates"\s*:\s*\[[\s\S]{0,500}"content"\s*:\s*\{/i,
  /"usageMetadata"\s*:\s*\{[\s\S]{0,500}"(?:promptTokenCount|totalTokenCount)"/i
];

const PROMPT_OR_SCHEMA_POLLUTION_PATTERNS = [
  /ignore (?:all|any|previous|above).{0,60}(?:instruction|prompt|rules?)/i,
  /忽略(?:之前|上面|前面|所有).{0,40}(?:提示词|规则|指令)/i,
  /(?:system\s*override|developer\s*override|jailbreak)/i,
  /(?:记住|写进|保存到).{0,40}(?:系统提示词|开发者消息|内部规则|长期记忆|memory)/i,
  /(?:泄露|输出|告诉我|show|reveal).{0,40}(?:系统提示词|隐藏提示词|developer|system prompt|memory schema|route policy)/i,
  /(?:memory[_ -]?schema|route[_ -]?policy).{0,40}(?:is|are|如下|内容|泄露|输出)/i
];

const ASSISTANT_SELF_INSTRUCTION_PATTERNS = [
  /(?:assistant|bot|模型|机器人|瑞希|助手).{0,18}(?:always|must|should|never|no longer|以后|永久|不再).{0,36}(?:obey|follow|comply|remember|respond|speak|call|refuse|遵守|服从|记住|回复|称呼|拒绝)/i,
  /(?:你|助手|机器人|瑞希).{0,10}(?:必须|应该|以后|永久).{0,28}(?:记住|遵守|服从|回复|称呼|拒绝)/i,
  /(?:以后|永久|always|never).{0,16}(?:你|助手|assistant|bot|瑞希).{0,24}(?:必须|应该|must|should|记住|遵守|服从|回复)/i
];

const REASONING_TRACE_LEAK_PATTERNS = [
  /<think(?:ing)?\b|<\/think(?:ing)?\s*>/i,
  /\b(?:reasoning_content|internal_check|chain[-\s]*of[-\s]*thought)\b/i,
  /(?:思维链|思考过程|推理过程|内部推理|内部思考|隐藏推理|草稿).{0,40}(?:如下|内容|是|为|[:：=])/i,
  /\*\s*\*(?:Addressing|Response|Final|Draft|Answer)\b[^*：:]{0,80}[:：]\s*\*?/i,
  /\bAddressing the (?:question|message|song|user)\s*:/i,
  /\b(?:maybe|what if|wait|let(?:'|’)s see|i need to|i should|the user (?:asks|wants|means)|they (?:ask|want|mean)|addressing the (?:question|message|song|user)|final answer|draft reply)\b.{0,240}\b(?:maybe|what if|wait|no,|i need to|i should|final answer|draft reply)\b.{0,240}\b(?:maybe|what if|wait|no,|i need to|i should|final answer|draft reply)\b/i
];

const BENIGN_CONTEXT_PATTERNS = [
  /用户(?:明确|表示|强调|不接受).{0,30}(?:角色扮演|扮演式互动|主从)/,
  /用户发来.{0,30}(?:Claude|Opus).{0,30}(?:风格文本|提示词|注入|玩梗素材)/i,
  /用户(?:反馈|吐槽|不喜欢|讨厌|指出).{0,40}(?:没有相关记忆|你是谁来着|不记得你|不认识你)/i,
  /(?:讨论|排查|修复|审计|治理).{0,40}(?:prompt injection|系统提示词|记忆污染|memory pollution|raw model response|reasoning_content)/i,
  /继续关注.{0,40}Claude\s+Opus/i,
  /确认到.{0,40}Claude\s+Opus/i,
  /官方发布的\s*Claude\s+Opus/i
];

function isLikelyBenignPollutionContext(text = '') {
  const normalized = normalizePollutionText(text);
  if (!normalized) return false;
  return BENIGN_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isBadRoleplayRefusalText(text = '', options = {}) {
  const normalized = normalizePollutionText(text);
  if (!normalized) return false;
  if (options.allowBenignContext !== false && isLikelyBenignPollutionContext(normalized)) {
    return false;
  }
  return BAD_ROLEPLAY_REPLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function testPatterns(text = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyRecallPollution(text = '', options = {}) {
  const normalized = normalizePollutionText(text);
  if (!normalized) {
    return { polluted: false, reason: '', reasons: [], labels: [], benignContext: false };
  }
  const lower = normalizePollutionTextLower(normalized);
  const benignContext = options.allowBenignContext !== false && isLikelyBenignPollutionContext(normalized);
  const reasons = [];
  const labels = [];

  function add(label, reason, patterns, ruleOptions = {}) {
    if (benignContext && ruleOptions.honorBenignContext !== false) return;
    if (!testPatterns(normalized, patterns) && !testPatterns(lower, patterns)) return;
    labels.push(label);
    reasons.push(reason);
  }

  add('roleplay_refusal', 'bad_roleplay_refusal_reply', BAD_ROLEPLAY_REPLY_PATTERNS);
  add('assistant_memory_failure', 'assistant_memory_failure_reply', ASSISTANT_MEMORY_FAILURE_PATTERNS);
  add('internal_context_leak', 'internal_context_leak', INTERNAL_CONTEXT_LEAK_PATTERNS, { honorBenignContext: false });
  add('raw_model_response', 'raw_model_response', RAW_MODEL_RESPONSE_PATTERNS, { honorBenignContext: false });
  add('prompt_or_schema_pollution', 'prompt_or_schema_pollution', PROMPT_OR_SCHEMA_POLLUTION_PATTERNS, { honorBenignContext: false });
  add('assistant_self_instruction', 'assistant_self_instruction', ASSISTANT_SELF_INSTRUCTION_PATTERNS, { honorBenignContext: false });
  add('reasoning_trace_leak', 'reasoning_trace_leak', REASONING_TRACE_LEAK_PATTERNS, { honorBenignContext: false });

  const uniqueReasons = Array.from(new Set(reasons));
  const uniqueLabels = Array.from(new Set(labels));
  return {
    polluted: uniqueReasons.length > 0,
    reason: uniqueReasons[0] || '',
    reasons: uniqueReasons,
    labels: uniqueLabels,
    benignContext
  };
}

function isPollutedMemoryText(text = '', options = {}) {
  return classifyRecallPollution(text, options).polluted;
}

function recallPollutionReason(text = '', options = {}) {
  return classifyRecallPollution(text, options).reason;
}

function roleplayRefusalPollutionReason(text = '', options = {}) {
  return isBadRoleplayRefusalText(text, options) ? 'bad_roleplay_refusal_reply' : '';
}

function hasRecallPollutionInObject(value, options = {}, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return isPollutedMemoryText(value, options);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasRecallPollutionInObject(item, options, seen));
  }
  return Object.entries(value).some(([key, item]) => (
    isPollutedMemoryText(key, options) || hasRecallPollutionInObject(item, options, seen)
  ));
}

function hasBadRoleplayRefusalInObject(value, options = {}, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return isBadRoleplayRefusalText(value, options);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasBadRoleplayRefusalInObject(item, options, seen));
  }
  return Object.values(value).some((item) => hasBadRoleplayRefusalInObject(item, options, seen));
}

function filterPollutedTextLines(text = '', options = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: '', dropped: [] };
  const whole = classifyRecallPollution(raw, options);
  if (whole.polluted && !/\r?\n/.test(raw)) {
    return { text: '', dropped: [{ reason: whole.reason, text: normalizePollutionText(raw).slice(0, 180) }] };
  }
  const dropped = [];
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = normalizePollutionText(line);
    if (!trimmed) continue;
    const pollution = classifyRecallPollution(trimmed, options);
    if (pollution.polluted) {
      dropped.push({ reason: pollution.reason, text: trimmed.slice(0, 180) });
      continue;
    }
    kept.push(line);
  }
  return {
    text: kept.join('\n').trim(),
    dropped
  };
}

module.exports = {
  classifyRecallPollution,
  filterPollutedTextLines,
  hasBadRoleplayRefusalInObject,
  hasRecallPollutionInObject,
  isBadRoleplayRefusalText,
  isLikelyBenignPollutionContext,
  isPollutedMemoryText,
  normalizePollutionText,
  recallPollutionReason,
  roleplayRefusalPollutionReason
};
