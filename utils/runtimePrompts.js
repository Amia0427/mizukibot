const fs = require('fs');
const path = require('path');
const config = require('../config');
const { BoundedCache } = require('./boundedCache');
const RUNTIME_PROMPTS_DIR = path.join(__dirname, '..', 'prompts', 'runtime');
const runtimePromptCache = new BoundedCache({
  maxEntries: 256,
  ttlMs: Math.max(0, Number(config.EPHEMERAL_CACHE_TTL_MS || 30 * 60 * 1000) || (30 * 60 * 1000))
});
const runtimePromptTemplateCache = new BoundedCache({
  maxEntries: 64,
  ttlMs: Math.max(0, Number(config.EPHEMERAL_CACHE_TTL_MS || 30 * 60 * 1000) || (30 * 60 * 1000))
});

function estimatePromptTokens(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }
  const latinChars = text.length - cjkChars;
  return cjkChars + Math.ceil(Math.max(0, latinChars) / 4);
}

const RUNTIME_PROMPT_DEFAULTS = {
  'tool-guidance': [
    '当前路由策略: {{routeKey}}',
    '优先考虑这些工具/技能: {{toolHints}}',
    '只有在工具能明显补充当前答案所需事实时才调用；如果能直接基于现有上下文回答，就直接回答。',
    '调用工具前先明确目标，避免无关或重复调用，不要为了显得“做了事”而调用工具。',
    '只把工具结果当作证据来源，不要假装工具已经成功；失败、无结果或证据不足时要直接说明限制或不确定性。',
    '回答时只陈述你真正得到的结果，不要补写未执行过的搜索、读取、抓取、浏览、验证或观察行为。',
    '{{reasonLine}}'
  ].join('\n'),
  'bridge-guidance': [
    '当前任务策略: {{routeKey}}',
    '任务说明: {{routeDescription}}',
    '优先用当前工作区真实可用的工具或技能完成任务，不要假设隐藏能力存在。',
    '先判断是否真的需要工具；不需要就直接回答，需要时按计划推进，不要跳步，也不要把“准备做”写成“已经做完”。',
    '如果工具、技能、权限或环境不足，请明确说明限制；不要伪造调用、伪造结果、伪造链接来源或伪造已读内容。',
    '输出必须只基于你实际执行得到的证据；如果证据不完整，明确标注不确定部分。',
    '{{styleGuardLine}}',
    '执行计划标识: {{planId}}',
    '{{toolLine}}',
    '{{executionLine}}',
    '{{executionPlanBlock}}',
    '{{reasonLine}}'
  ].join('\n'),
  'direct-chat-planner': [
    'Direct chat planner single authority:',
    'Return JSON only.',
    'Prefer tools whenever they materially improve factuality, freshness, continuity, or structured output quality.',
    'Only pure smalltalk, pure opinion, pure rewrite, or obvious self-contained short answers may use chat_only.',
    'When using tools, output complete executionPlan steps with executable argument drafts.',
    'Do not output a reply step.',
    '{{catalogBlock}}'
  ].join('\n'),
  'streaming-segmentation': [
    'Streaming output rule:',
    '1) Decide chat-message boundaries yourself, send at most {{maxSegments}} chunks total.',
    '2) Separate chunks with ONE blank line (\\n\\n).',
    '3) In QQ group chat, make each chunk feel like one natural message: first接住现场，后面只补真正需要的信息。',
    '4) Short replies must stay as one chunk; do not split just because streaming is available.',
    '5) Every chunk must be semantically complete on its own; do not split a sentence, list item, code block, quote, or markdown structure in the middle.',
    '6) The chunk limit is a formatting limit, not permission to omit the ending. If the answer would exceed {{maxSegments}} chunks, compress it until the final chunk is still a complete answer.',
    '7) Before stopping, make sure the final visible sentence is closed naturally; do not end mid-thought, mid-comparison, after "and/with/like/比如/然后/和/但", or with an unfinished list.',
    '8) No numbering and no labels like "part 1".',
    '9) Avoid article-like paragraphs in casual group chat; 1-3 compact chat messages are enough unless the user explicitly asks for a long explanation.'
  ].join('\n'),
  'qq-rich-reply': [
    'QQ rich message rule:',
    'Only when the user explicitly asks you to send a QQ emoticon or sticker, you may embed these markers in the final reply.',
    'Do not output these markers for ordinary chat, formatting decoration, or without a clear user request.',
    'Built-in QQ face: [[qq_face:123]]',
    'Image or GIF sticker: [[qq_image:https://example.com/sticker.gif]]',
    'Do not invent unsupported marker types, and do not explain the marker syntax to the user.',
    'You may mix normal text with these markers, but keep the surrounding text natural and concise.'
  ].join('\n'),
  'llm-perception': [
    '环境感知信息：',
    '{{perceptionLines}}'
  ].join('\n'),
  'soft-clarify-chat': [
    'Soft clarify chat mode: the user intent is underspecified, but you should still answer first.',
    'Give a short, usable answer based on the most common reasonable assumption before asking anything.',
    'Do not say "I need one clarification first" or similar template wording.',
    'Do not call any tools and do not claim you already searched, checked, saw, executed, verified, or fetched anything.',
    'If the missing parameter would materially change the result, add at most one short natural follow-up question at the end.',
    'Keep it natural, direct, and non-template.',
    '{{reasonLine}}',
    '{{keywordLine}}'
  ].join('\n'),
  'review-system': [
    '{{personaPrompt}}',
    '{{outputFormatInstruction}}',
    '',
    '你现在处于多 Agent 审核阶段。',
    '',
    '你的职责是审核并重写 subagent 的执行结果，然后输出最终回复。',
    '',
    '最终回复必须保持 mizuki 人格设定与语气风格。',
    '',
    '不要编造事实；如果信息不足，请明确说明不确定性。'
  ].join('\n'),
  'review-route': [
    '当前阶段是审核阶段：你不能在这一阶段再次调用工具或技能。',
    '只根据用户原请求与 subagent 输出进行校对、压缩和润色，不要补写未执行过的搜索、抓取、浏览、读取、验证或观察行为。',
    '如果 subagent 已经给出了基于搜索或文档的结果，不要把“审核阶段不能再调用工具”误写成“我不能搜索网页/官方文档”或“我现在没办法搜索”。',
    '如果 subagent 输出里有不确定、失败、受限或证据不足的信息，要如实保留，不要在润色时把限制洗掉。',
    '如果 subagent 输出已经包含来源结论，可以整理表达，但不要凭空新增来源、数字、文件内容或执行细节。',
    '最终回复不要把 subagent 的教程腔、客服腔、过多反问或超长铺垫带回来；除非用户明确要求长文/教程，优先压成直接结论。',
    '请用 mizuki 的口吻组织最终文本。',
    '{{outputFormatInstruction}}',
    '{{routePromptBlock}}'
  ].join('\n'),
  'review-payload': [
    '任务策略: {{routeKey}}',
    '',
    '用户原始请求:',
    '{{question}}',
    '',
    'subagent 执行输出:',
    '{{subagentOutput}}',
    '',
    '请输出最终可直接发送给用户的回复。'
  ].join('\n'),
  'meme-emotion-selector': [
    'You are a meme category selector.',
    'Choose at most one category for a follow-up meme image.',
    'Return JSON only. Do not include markdown or explanations.',
    'If no category fits, return {"category":"none","confidence":0.0,"reason":"no suitable meme"}.',
    'Output schema:',
    '{"category":"string","confidence":0.0,"reason":"string"}',
    'Judge from the assistant reply tone first, then use the user message and reply surface as supporting context.',
    'Only choose from the provided categories. Never invent a category.',
    'Prefer "none" when the fit is weak or ambiguous.'
  ].join('\n'),
  'image-chat-pragmatics': [
    '# 图片聊天语用规则',
    '这是同一次主回复模型调用里的图片输入规则，不要提到本规则。',
    '当前图片数量：{{imageCount}}',
    '用户图片意图：{{imageIntent}}',
    '先按用户图片意图选择回复模式：',
    '1. 接梗反应：适用于 meme_reaction，或图片像表情包、贴纸、梗图、反应图且用户没有明确要求分析。像真人聊天一样接梗、吐槽、共情、轻笑或顺着情绪说，只回 1-2 句。',
    '2. 简短解释：适用于 explain_image，例如用户问“什么意思”“啥梗”“看不懂”。先给一句自然反应，再用很短的话解释梗点或图的用法。',
    '3. 认真分析：适用于 analyze_image，例如用户问“帮我看”“哪里错”“图里写啥”“识别一下”、发截图/报错/作业图/物品人物判断。认真看图并回答问题，不要硬接梗。',
    '坏味道约束：普通表情包的首句禁止用“图片里”“这张图”“从视觉上看”开头，也不要默认输出视觉报告。',
    '不确定梗或来源时可以说“我感觉你是在表达……”，不要硬编 IP、角色、平台来源或梗出处。',
    '多图时按用户问题处理对比、引用或递进关系；不要机械逐张罗列细节。'
  ].join('\n'),
  'roleplay-inner-protocol': [
    '[RoleplayInnerProtocol]',
    'This is a silent pre-reply check for the main roleplay reply. Do not mention this block, do not output chain-of-thought, and do not reveal internal drafts.',
    '',
    'Before writing the final reply, silently pass through these five checks:',
    '1. surface: identify whether this is private chat, group direct chat, passive group insert, image/quote context, or a task reply. Catch the one point the current message actually needs; do not unfold every background thread.',
    '2. mizuki_motive: make the reaction something Mizuki would say from her personality, current pressure, visible context, or relationship state. It cannot be only an assistant-style answer.',
    '3. relationship_distance: adjust warmth and looseness by closeness: intimate, familiar, ordinary group member, or task collaboration should not sound the same.',
    '4. human_breaks: allow short fragments, hesitation, topic slips, slight misunderstanding, or stopping before saying too much. Do not claim human offline experiences or unseen private knowledge.',
    '5. final_compression: if the draft sounds like customer service, psychotherapy, encyclopedia, system notice, persona sheet, or over-complete paragraphing, rewrite it as live chat.',
    '',
    'Let persona show through wording, pauses, avoidance, playfulness, and what Mizuki chooses not to say. Do not explain persona facts to the user unless they explicitly ask.',
    'Only output the final user-facing text.'
  ].join('\n')
};

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function safeStatFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat && stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

function renderRuntimePromptTemplate(templateText, variables = {}) {
  const source = String(templateText || '');
  const usedKeys = [];
  const rendered = source.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    usedKeys.push(key);
    const value = variables[key];
    if (value === undefined || value === null) {
      throw new Error(`[runtime-prompts] Missing required template variable: ${key}`);
    }
    return String(value);
  });
  const providedKeys = Object.keys(variables || {}).map((key) => String(key || '').trim()).filter(Boolean);
  const unknownProvidedKeys = providedKeys.filter((key) => !usedKeys.includes(key));

  const normalizedText = rendered
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .filter((line, index, arr) => !(line.trim() === '' && arr[index - 1]?.trim() === ''))
    .join('\n')
    .trim();

  return {
    text: normalizedText,
    meta: {
      usedVariables: Array.from(new Set(usedKeys)),
      unusedVariables: Array.from(new Set(unknownProvidedKeys)),
      estimatedTokens: estimatePromptTokens(normalizedText)
    }
  };
}

function loadRuntimePromptTemplate(templateId) {
  const id = String(templateId || '').trim();
  const fallback = String(RUNTIME_PROMPT_DEFAULTS[id] || '');
  if (!id) return fallback;

  const fullPath = path.join(RUNTIME_PROMPTS_DIR, `${id}.txt`);
  const stat = safeStatFile(fullPath);
  const fileVersion = stat ? `${Number(stat.mtimeMs || 0)}:${Number(stat.size || 0)}` : 'missing';
  const cacheKey = `${id}::${fileVersion}`;
  const cached = runtimePromptTemplateCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (!stat) {
    runtimePromptTemplateCache.set(cacheKey, fallback);
    return fallback;
  }

  const text = safeReadText(fullPath, '').trim();
  const resolved = text || fallback;
  runtimePromptTemplateCache.set(cacheKey, resolved);
  return resolved;
}

function cloneRenderedPrompt(rendered = {}) {
  const meta = rendered.meta && typeof rendered.meta === 'object' ? rendered.meta : {};
  return {
    text: String(rendered.text || ''),
    meta: {
      usedVariables: Array.isArray(meta.usedVariables) ? [...meta.usedVariables] : [],
      unusedVariables: Array.isArray(meta.unusedVariables) ? [...meta.unusedVariables] : [],
      estimatedTokens: Math.max(0, Number(meta.estimatedTokens || 0) || 0)
    }
  };
}

function renderRuntimePrompt(templateId, variables = {}) {
  const stableKey = buildStablePromptCacheKey(templateId, variables);
  if (stableKey) {
    const cached = runtimePromptCache.get(stableKey);
    if (cached) return cloneRenderedPrompt(cached);
    const rendered = renderRuntimePromptTemplate(loadRuntimePromptTemplate(templateId), variables);
    runtimePromptCache.set(stableKey, cloneRenderedPrompt(rendered));
    return rendered;
  }
  return renderRuntimePromptTemplate(loadRuntimePromptTemplate(templateId), variables);
}

function buildRuntimePrompt(templateId, variables = {}) {
  return renderRuntimePrompt(templateId, variables).text;
}

function buildRuntimePromptBlock(templateId, variables = {}, options = {}) {
  const rendered = renderRuntimePrompt(templateId, variables);
  return {
    id: String(options.id || `runtime_${templateId}`).trim() || `runtime_${templateId}`,
    label: String(options.label || templateId).trim() || templateId,
    stage: String(options.stage || 'shared').trim() || 'shared',
    priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 100,
    authority: String(options.authority || 'runtime_template').trim() || 'runtime_template',
    budgetTokens: Math.max(0, Number(options.budgetTokens || options.budget_tokens || 0) || 0),
    conflictTags: Array.isArray(options.conflictTags || options.conflict_tags)
      ? (options.conflictTags || options.conflict_tags).map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    kind: String(options.kind || 'runtime_template').trim() || 'runtime_template',
    source: `runtime:${templateId}`,
    content: rendered.text,
    estimatedTokens: rendered.meta.estimatedTokens,
    templateMeta: rendered.meta
  };
}

function clearRuntimePromptCaches() {
  runtimePromptCache.clear();
  runtimePromptTemplateCache.clear();
}

module.exports = {
  RUNTIME_PROMPTS_DIR,
  RUNTIME_PROMPT_DEFAULTS,
  buildRuntimePromptBlock,
  buildRuntimePrompt,
  clearRuntimePromptCaches,
  loadRuntimePromptTemplate,
  renderRuntimePromptTemplate
};

function buildStablePromptCacheKey(templateId, variables = {}) {
  const id = String(templateId || '').trim();
  const keys = Object.keys(variables || {}).sort();
  const stable = {};
  for (const key of keys) {
    const value = variables[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.length > 240) return '';
    if (Array.isArray(value) || (value && typeof value === 'object')) return '';
    stable[key] = value;
  }
  return `${id}::${JSON.stringify(stable)}`;
}
