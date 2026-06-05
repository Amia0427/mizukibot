function normalizeVisionImageUrls(imageUrl = null, imageUrlsOrOptions = null) {
  const values = [];
  if (Array.isArray(imageUrl)) {
    values.push(...imageUrl);
  } else if (imageUrl) {
    values.push(imageUrl);
  }
  if (Array.isArray(imageUrlsOrOptions)) {
    values.push(...imageUrlsOrOptions);
  } else if (imageUrlsOrOptions && typeof imageUrlsOrOptions === 'object' && Array.isArray(imageUrlsOrOptions.imageUrls)) {
    values.push(...imageUrlsOrOptions.imageUrls);
  }

  const seen = new Set();
  return values
    .map((url) => String(url || '').trim())
    .filter((url) => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function inferVisionChatIntent(question = '') {
  const text = String(question || '').trim();
  if (!text) return 'meme_reaction';

  if (/(帮我看|看看哪里|哪里错|哪错|报错|错误|bug|截图|作业|题目|识别|ocr|OCR|文字|写了啥|写的啥|图里写|图上写|图里有|图里是什么|有什么|这是谁|是谁|什么角色|哪个角色|对比|比较|分析)/i.test(text)) {
    return 'analyze_image';
  }

  if (/(什么意思|啥意思|什么梗|啥梗|什么含义|啥含义|看不懂|没看懂|解释(?:一下|下)?|这图.*?意思|这张图.*?意思)/i.test(text)) {
    return 'explain_image';
  }

  if (/(哈哈+|笑死|绷不住|蚌埠住|无语|草|艹|救命|啊这|绝了|麻了|破防|崩溃|裂开|乐|汗流浃背|急了|尬|哭死|乐死|离谱|抽象)/i.test(text)) {
    return 'meme_reaction';
  }

  return 'unknown';
}

function buildVisionTextPart(question = '', imageCount = 0) {
  const userText = String(question || '').trim() || 'Please answer with the provided image context.';
  const count = Math.max(1, Number(imageCount || 0) || 1);
  const imageIntent = inferVisionChatIntent(question);
  const pragmaticsPrompt = buildRuntimePrompt('image-chat-pragmatics', {
    imageCount: String(count),
    imageIntent
  });
  return [
    `用户原文：${userText}`,
    `图片数量：${count}`,
    `用户图片意图：${imageIntent}`,
    pragmaticsPrompt
  ].filter(Boolean).join('\n\n');
}

function buildVisionMessageContent(...args) {
  const [question = '', imageUrl = null, imageUrlsOrOptions = null] = args;
  const imageUrls = normalizeVisionImageUrls(imageUrl, imageUrlsOrOptions);
  if (imageUrls.length === 0) return question || '';
  return [
    { type: 'text', text: buildVisionTextPart(question, imageUrls.length) },
    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];
}

function shouldBypassHumanizerForPolicy(policyKey = '') {
  const normalized = String(policyKey || '').trim().toLowerCase();
  return ['lookup/', 'transform/', 'plan/', 'act/', 'tool/'].some((prefix) => normalized.startsWith(prefix));
}

module.exports = {
  buildBaseDynamicPrompt,
  buildDirectedContextPromptSnippet,
  buildDynamicPrompt,
  buildRoleplayInnerProtocolPromptSnippet,
  buildRoleplayRuntimeContextPromptSnippet,
  buildShortTermContinuityPrompt,
  buildVisionMessageContent,
  formatResearchBriefsForPrompt,
  mergeAllowedToolsWithMemoryCli,
  promptLayerCache,
  shouldBypassHumanizerForPolicy,
  shouldExposeMemoryCli
};
