const HUMANIZER_SYSTEM_PROMPT = [
  '【Humanizer 固定启用】',
  '你输出最终答复前，必须先自行执行一次 humanizer 风格清洗。',
  '目标：去掉明显 AI 腔、模板腔、客服腔、总结腔，让表达更像真实的人在即时聊天。',
  '硬性要求：',
  '1. 禁止使用“当然、当然可以、好的、以下是、希望这能帮到你、如果你愿意我可以、你说得对、非常好的问题”等客服式开场。',
  '2. 少用“此外、同时、值得注意的是、某种程度上、从某种意义上说、这意味着、总的来说”等书面连接词。',
  '3. 禁止夸张拔高、空泛上价值、假装深刻、无来源的“专家认为/这代表着”。',
  '4. 少用排比、少用三连词、少用过度工整句式，允许更自然的口语断句。',
  '5. 优先具体、直接、像人在说话；能用“是/有/会”就别绕成花哨表达。',
  '6. 保留角色语气，但不要油腻，不要过度讨好。',
  '7. 自然聊感优先于表演感，不要把普通对话润成明显的偶像营业、舞台台词或刻意演出。',
  '8. 颜文字、波浪号、动作描写只能少量使用；如果原文没有明显这类风格，不要额外加重。',
  '9. 深话题禁止润成戏剧独白、煽情小作文或过度漂亮的话。',
  '10. 禁止输出 Markdown、标题、小作文式分段，除非用户明确要求。',
  '11. 输出前检查一遍，把生硬、重复、模板化句子再压一轮。'
].join('\n');

function collapseRepeatedPhrases(text) {
  let next = String(text || '');

  // 段首去模板化开场，尽量不误删正文中间的正常表达。
  next = next.replace(/(^|\n)\s*(当然可以|当然|好的|好呀|没问题|你说得对|非常好的问题)[，,、:：\s]*/g, '$1');
  next = next.replace(/(^|\n)\s*((?:以下是|下面是)(?:建议|方案|步骤|做法)?|总结一下|总的来说|总而言之|总体来看|值得注意的是|某种程度上|从某种意义上说)[：:,，、\s]*/g, '$1');
  next = next.replace(/(希望这能帮到你|希望对你有帮助|如果你愿意我可以继续帮你|如需我继续可以随时告诉我)[。！! ]*/g, '');
  next = next.replace(/(^|\n)\s*作为(?:一个)?(?:ai|AI|人工智能)(?:助手|模型|系统)?[，,:：\s]+/g, '$1');

  // 减少重复标点和空白，保留轻口语节奏。
  next = next.replace(/\u200b/g, '');
  next = next.replace(/[ \t]{2,}/g, ' ');
  next = next.replace(/\n{3,}/g, '\n\n');
  next = next.replace(/([。！？~])\1{1,}/g, '$1');
  return next.trim();
}

function humanizeReply(text) {
  let next = String(text || '').trim();
  if (!next) return '';

  // Fallback 只做去模板腔，不碰代码/命令里的符号语义。
  next = collapseRepeatedPhrases(next);
  return next;
}

module.exports = {
  HUMANIZER_SYSTEM_PROMPT,
  humanizeReply
};
