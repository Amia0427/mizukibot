const { openImageMemory } = require('../imageMemoryIndex');

function formatOpenedImage(openedImage) {
  if (!openedImage) return null;
  return {
    source: 'image',
    id: openedImage.cacheKey,
    data: {
      cacheKey: openedImage.cacheKey,
      imageRef: openedImage.imageRef,
      mediaType: openedImage.mediaType,
      sourceUrl: openedImage.sourceUrl,
      exists: openedImage.exists,
      userId: openedImage.userId,
      groupId: openedImage.groupId,
      sessionKey: openedImage.sessionKey,
      messageId: openedImage.messageId,
      createdAt: openedImage.createdAt,
      lastSeenAt: openedImage.lastSeenAt,
      summary: openedImage.summary,
      ocrText: openedImage.ocrText,
      visibleText: openedImage.visibleText,
      userText: openedImage.userText,
      observations: Array.isArray(openedImage.observations) ? openedImage.observations.slice(0, 5) : []
    }
  };
}

function openImageMemoryResult(target, context = {}) {
  return formatOpenedImage(openImageMemory(target, context));
}

module.exports = {
  formatOpenedImage,
  openImageMemoryResult
};
