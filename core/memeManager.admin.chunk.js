function normalizeSurfaceList() {
  const items = String(config.MEME_MANAGER_SURFACES || '')
    .split(',')
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  return new Set(items);
}

function isSurfaceEnabled(surface) {
  const store = memeStore.getStore();
  const surfaceSet = normalizeSurfaceList();
  if (!store.enabled || !config.MEME_MANAGER_ENABLED) return false;
  if (!surfaceSet.has(String(surface || '').trim().toLowerCase())) return false;
  if (surface === 'direct') return store.surfaces.direct !== false;
  if (surface === 'passive') return store.surfaces.passive !== false;
  if (surface === 'scheduled') return store.surfaces.scheduled !== false;
  return false;
}

function getSessionKey(groupId, userId) {
  return `${String(groupId || '').trim()}:${String(userId || '').trim()}`;
}

function cleanupExpiredSessions(now = Date.now()) {
  for (const [key, session] of uploadSessions.entries()) {
    if (!session || Number(session.expiresAt || 0) <= now) {
      uploadSessions.delete(key);
    }
  }
}

function startUploadSession({ groupId, userId, categoryName }) {
  cleanupExpiredSessions();
  const sessionKey = getSessionKey(groupId, userId);
  const session = {
    key: sessionKey,
    groupId: String(groupId || '').trim(),
    userId: String(userId || '').trim(),
    categoryName: String(categoryName || '').trim(),
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(1000, Number(config.MEME_MANAGER_UPLOAD_WINDOW_MS || 60000)),
    importedCount: 0
  };
  uploadSessions.set(sessionKey, session);
  return { ...session };
}

function getUploadSession(groupId, userId) {
  cleanupExpiredSessions();
  const session = uploadSessions.get(getSessionKey(groupId, userId));
  return session ? { ...session } : null;
}

function endUploadSession(groupId, userId) {
  uploadSessions.delete(getSessionKey(groupId, userId));
}

function listCategorySummaryLines() {
  const categories = memeStore.listCategories();
  if (!categories.length) return ['当前图库为空。'];
  return categories.map((category) => (
    `${category.name} | ${category.assetCount} 张 | ${category.description}`
  ));
}

function formatFilesList(categoryName) {
  const files = memeStore.listCategoryFiles(categoryName);
  if (!files.length) return '该分类当前没有图片。';
  return files
    .map((file) => {
      const resolved = resolveAssetAnalysis(file).resolved;
      const feedback = file.feedback || {};
      return [
        file.id,
        file.mime || 'unknown',
        `${file.size}B`,
        new Date(file.createdAt).toISOString(),
        `analysisStatus=${file.analysis?.status || 'pending'}`,
        `primaryMood=${resolved.primaryMood || 'none'}`,
        `intensity=${resolved.intensity || 'low'}`,
        `blocked=${feedback.blocked === true}`,
        `feedback=${JSON.stringify({
          likes: Math.max(0, Number(feedback.likes) || 0),
          dislikes: Math.max(0, Number(feedback.dislikes) || 0),
          skips: Math.max(0, Number(feedback.skips) || 0)
        })}`
      ].join(' | ');
    })
    .join('\n');
}

function formatCategoryDetails(categoryName) {
  const category = memeStore.getCategory(categoryName);
  if (!category) throw new Error('Category not found.');
  return [
    `name: ${category.name}`,
    `description: ${category.description || '(empty)'}`,
    `moods: ${(category.moods || []).join(', ') || '(empty)'}`,
    `intensities: ${(category.intensities || []).join(', ') || '(all)'}`,
    `keywords: ${(category.keywords || []).join(', ') || '(empty)'}`,
    `assetCount: ${Array.isArray(category.assets) ? category.assets.length : 0}`,
    `enabled: ${category.enabled !== false}`
  ].join('\n');
}

function formatAssetDetails(categoryName, assetId) {
  const asset = memeStore.getAsset(categoryName, assetId);
  if (!asset) throw new Error('Asset not found.');
  const analysis = resolveAssetAnalysis(asset);
  return [
    `category: ${categoryName}`,
    `assetId: ${asset.id}`,
    `fileName: ${asset.fileName}`,
    `mime: ${asset.mime || 'unknown'}`,
    `size: ${asset.size}`,
    `analysisStatus: ${analysis.status}`,
    `analysisVersion: ${analysis.version}`,
    `analysisModel: ${analysis.model || '(empty)'}`,
    `analyzedAt: ${analysis.analyzedAt ? new Date(analysis.analyzedAt).toISOString() : '(never)'}`,
    `primaryMood: ${analysis.resolved.primaryMood || 'none'}`,
    `intensity: ${analysis.resolved.intensity || 'low'}`,
    `blocked: ${asset.feedback?.blocked === true}`,
    `feedback: ${JSON.stringify(asset.feedback || {})}`,
    `resolvedAnalysis: ${JSON.stringify(analysis.resolved)}`,
    `overrides: ${JSON.stringify(analysis.overrides || {})}`,
    `lastError: ${analysis.lastError || '(empty)'}`
  ].join('\n');
}

function buildHelpText() {
  return [
    '可用命令：',
    '/meme help',
    '/meme status',
    '/meme on',
    '/meme off',
    '/meme categories',
    '/meme category add <分类> <描述>',
    '/meme category desc <分类> <描述>',
    '/meme category show <分类>',
    '/meme category moods <分类> <csv>',
    '/meme category intensity <分类> <csv>',
    '/meme category keywords <分类> <csv>',
    '/meme category remove <分类>',
    '/meme test <replyText>',
    '/meme add <分类>',
    '/meme done',
    '/meme cancel',
    '/meme files <分类>',
    '/meme delete <分类> <assetId>',
    '/meme asset show <分类> <assetId>',
    '/meme asset patch <分类> <assetId> <json>',
    '/meme asset relabel <分类> <assetId>',
    '/meme asset feedback <分类> <assetId> like|dislike|skip|block|unblock',
    '/meme reindex pending',
    '/meme reindex category <分类>',
    '/meme reindex all',
    '/meme reindex status'
  ].join('\n');
}

function splitCommandArgs(text = '') {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function parseMemeCommand(raw = '') {
  const text = String(raw || '').trim();
  if (!/^\/meme(?:\s|$)/i.test(text)) return null;

  const args = splitCommandArgs(text);
  if (args.length === 1) return { action: 'help' };
  if (args[1] === 'help') return { action: 'help' };
  if (args[1] === 'status') return { action: 'status' };
  if (args[1] === 'on') return { action: 'on' };
  if (args[1] === 'off') return { action: 'off' };
  if (args[1] === 'categories') return { action: 'categories' };
  if (args[1] === 'done') return { action: 'done' };
  if (args[1] === 'cancel') return { action: 'cancel' };
  if (args[1] === 'test') {
    const payloadText = text.split(/\s+/).slice(2).join(' ').trim();
    let jsonPayload = null;
    if (/^\s*\{[\s\S]*\}\s*$/.test(payloadText)) {
      try {
        jsonPayload = JSON.parse(payloadText);
      } catch (_) {}
    }
    return {
      action: 'test',
      replyText: payloadText,
      payload: jsonPayload
    };
  }
  if (args[1] === 'add') return { action: 'add-session', categoryName: String(args[2] || '').trim() };
  if (args[1] === 'files') return { action: 'files', categoryName: String(args[2] || '').trim() };
  if (args[1] === 'delete') {
    return {
      action: 'delete-file',
      categoryName: String(args[2] || '').trim(),
      assetId: String(args[3] || '').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'show') {
    return {
      action: 'asset-show',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'patch') {
    return {
      action: 'asset-patch',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim(),
      payloadText: text.split(/\s+/).slice(5).join(' ').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'relabel') {
    return {
      action: 'asset-relabel',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim()
    };
  }
  if (args[1] === 'asset' && args[2] === 'feedback') {
    return {
      action: 'asset-feedback',
      categoryName: String(args[3] || '').trim(),
      assetId: String(args[4] || '').trim(),
      feedbackAction: String(args[5] || '').trim().toLowerCase()
    };
  }
  if (args[1] === 'reindex' && args[2] === 'pending') return { action: 'reindex-pending' };
  if (args[1] === 'reindex' && args[2] === 'all') return { action: 'reindex-all' };
  if (args[1] === 'reindex' && args[2] === 'status') return { action: 'reindex-status' };
  if (args[1] === 'reindex' && args[2] === 'category') {
    return {
      action: 'reindex-category',
      categoryName: String(args[3] || '').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'add') {
    return {
      action: 'category-add',
      categoryName: String(args[3] || '').trim(),
      description: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'desc') {
    return {
      action: 'category-desc',
      categoryName: String(args[3] || '').trim(),
      description: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'show') {
    return { action: 'category-show', categoryName: String(args[3] || '').trim() };
  }
  if (args[1] === 'category' && args[2] === 'moods') {
    return {
      action: 'category-moods',
      categoryName: String(args[3] || '').trim(),
      csv: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'intensity') {
    return {
      action: 'category-intensity',
      categoryName: String(args[3] || '').trim(),
      csv: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'keywords') {
    return {
      action: 'category-keywords',
      categoryName: String(args[3] || '').trim(),
      csv: text.split(/\s+/).slice(4).join(' ').trim()
    };
  }
  if (args[1] === 'category' && args[2] === 'remove') {
    return { action: 'category-remove', categoryName: String(args[3] || '').trim() };
  }
  return { action: 'unknown' };
}

function inferImageExtFromUrl(url = '') {
  const clean = String(url || '').split('?')[0].trim();
  const ext = path.extname(clean).toLowerCase();
  return ext || '.jpg';
}

function inferMimeFromResponse(url = '', headers = {}) {
  const contentType = String(headers?.['content-type'] || headers?.['Content-Type'] || '').trim().toLowerCase();
  if (contentType.startsWith('image/')) return contentType;
  const ext = inferImageExtFromUrl(url);
  return memeStore.inferMimeFromExt(`file${ext}`);
}

async function consumePendingUploadFromMessage(msg = {}) {
  cleanupExpiredSessions();
  if (String(msg.post_type || '') !== 'message' || String(msg.message_type || '') !== 'group') {
    return { consumed: false };
  }

  const groupId = String(msg.group_id || '').trim();
  const userId = String(msg.user_id || '').trim();
  const sessionKey = getSessionKey(groupId, userId);
  const session = uploadSessions.get(sessionKey);
  if (!session) return { consumed: false };

  const rawText = String(msg.raw_message || '');
  const match = rawText.match(/\[CQ:image,.*?url=([^,\]]+).*?\]/);
  if (!match) return { consumed: false };

  const imageUrl = String(match[1] || '').replace(/&amp;/g, '&').trim();
  if (!imageUrl) return { consumed: false };

  const maxImages = Math.max(1, Number(config.MEME_MANAGER_MAX_IMAGES_PER_SESSION || 20));
  if (session.importedCount >= maxImages) {
    uploadSessions.delete(sessionKey);
    return {
      consumed: true,
      replyText: `上传窗口已达到上限 ${maxImages} 张，已自动结束。`
    };
  }

  try {
    try {
      await assertSafeHttpUrl(imageUrl);
    } catch (_) {
      return {
        consumed: true,
        replyText: '图片来源地址不安全，已拒绝导入。'
      };
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: Math.max(1000, Number(config.MEME_MANAGER_TIMEOUT_MS || 8000)),
      proxy: false,
      maxRedirects: 0
    });
    const buffer = Buffer.from(response.data || []);
    const maxBytes = Math.max(1, Number(config.MEME_MANAGER_MAX_FILE_SIZE_MB || 10)) * 1024 * 1024;
    if (buffer.length > maxBytes) {
      return {
        consumed: true,
        replyText: `图片过大，超过 ${(maxBytes / (1024 * 1024)).toFixed(0)}MB 限制。`
      };
    }

    const ext = inferImageExtFromUrl(imageUrl);
    const asset = memeStore.importAsset(session.categoryName, buffer, {
      ext,
      mime: inferMimeFromResponse(imageUrl, response.headers || {})
    });
    let analysisReplySuffix = '';
    try {
      const analysisResult = await analyzeMemeAsset({
        categoryName: session.categoryName,
        assetId: asset.id
      });
      memeStore.updateAssetAnalysis(session.categoryName, asset.id, {
        status: 'ready',
        version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
        analyzedAt: Date.now(),
        model: analysisResult.model,
        lastError: '',
        auto: analysisResult.parsed
      });
    } catch (analysisError) {
      memeStore.updateAssetAnalysis(session.categoryName, asset.id, {
        status: 'failed',
        version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
        analyzedAt: Date.now(),
        model: getAssetAnalysisModel(),
        lastError: analysisError?.message || String(analysisError)
      });
      analysisReplySuffix = ` (analysis failed: ${analysisError?.message || String(analysisError)})`;
    }

    session.importedCount += 1;
    session.expiresAt = Date.now() + Math.max(1000, Number(config.MEME_MANAGER_UPLOAD_WINDOW_MS || 60000));
    uploadSessions.set(sessionKey, session);

    console.log('[meme-manager] asset imported', {
      groupId,
      userId,
      category: session.categoryName,
      assetId: asset.id,
      size: asset.size
    });

    return {
      consumed: true,
      replyText: `已导入 ${session.categoryName}: ${asset.id}${analysisReplySuffix}`
    };
  } catch (error) {
    return {
      consumed: true,
      replyText: `导入失败: ${error?.message || String(error)}`
    };
  }
}

