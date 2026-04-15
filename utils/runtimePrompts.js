const fs = require('fs');
const path = require('path');

const RUNTIME_PROMPTS_DIR = path.join(__dirname, '..', 'prompts', 'runtime');

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
    '1) decide chunk boundaries yourself, send at most {{maxSegments}} chunks total.',
    '2) separate chunks with ONE blank line (\\n\\n).',
    '3) every chunk must be semantically complete on its own; do not split a sentence, list item, code block, quote, or markdown structure in the middle.',
    '4) no numbering and no labels like "part 1".',
    '5) if the answer is short, return a single chunk instead of forcing multiple chunks.'
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

function renderRuntimePromptTemplate(templateText, variables = {}) {
  const source = String(templateText || '');
  const rendered = source.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  });

  return rendered
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .filter((line, index, arr) => !(line.trim() === '' && arr[index - 1]?.trim() === ''))
    .join('\n')
    .trim();
}

function loadRuntimePromptTemplate(templateId) {
  const id = String(templateId || '').trim();
  const fallback = String(RUNTIME_PROMPT_DEFAULTS[id] || '');
  if (!id) return fallback;

  const fullPath = path.join(RUNTIME_PROMPTS_DIR, `${id}.txt`);
  const text = safeReadText(fullPath, '').trim();
  return text || fallback;
}

function buildRuntimePrompt(templateId, variables = {}) {
  return renderRuntimePromptTemplate(loadRuntimePromptTemplate(templateId), variables);
}

module.exports = {
  RUNTIME_PROMPTS_DIR,
  RUNTIME_PROMPT_DEFAULTS,
  buildRuntimePrompt,
  loadRuntimePromptTemplate,
  renderRuntimePromptTemplate
};
