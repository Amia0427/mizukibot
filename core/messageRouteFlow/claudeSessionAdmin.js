const child_process = require('child_process');

function buildClaudeSessionKey(buildSessionId, chatType = '', senderId = '', groupId = '') {
  return buildSessionId(senderId, {
    sessionChannel: String(chatType || '').trim().toLowerCase() === 'private' ? 'qq-private' : 'qq-group',
    sessionChatId: String(chatType || '').trim().toLowerCase() === 'private'
      ? `direct_${senderId}`
      : `group_${groupId}_user_${senderId}`
  });
}

async function runClaudeWrapperMetadata(message = '', session = null) {
  const scriptPath = 'D:/waifu/scripts/hapi-runners/run-claude.ps1';
  const workspaceRoot = 'D:/waifu';
  const args = [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Message',
    String(message || '').trim(),
    '-WorkspaceRoot',
    workspaceRoot,
    '-ReturnMetadata'
  ];
  const resumeSessionId = String(session?.claude_session_id || '').trim();
  if (resumeSessionId) {
    args.push('-ResumeSessionId', resumeSessionId);
  }

  return new Promise((resolve, reject) => {
    const child = child_process.spawn(
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      args,
      {
        cwd: workspaceRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += String(buf); });
    child.stderr.on('data', (buf) => { stderr += String(buf); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (Number(code) !== 0) {
        return reject(new Error(String(stderr || stdout || `claude wrapper exited with code ${code}`)));
      }
      try {
        const parsed = JSON.parse(String(stdout || '').trim());
        return resolve(parsed);
      } catch (error) {
        return reject(new Error(`claude metadata parse failed: ${error.message || error}`));
      }
    });
  });
}

function createClaudeSessionAdminHandler(deps = {}) {
  const {
    buildSessionId,
    claudeSessionRuntime,
    isAdminUser,
    sendGroupReply,
    runClaudeWrapperMetadataImpl = runClaudeWrapperMetadata
  } = deps;

  function isAdminPrivateChat(chatType = '', senderId = '') {
    return String(chatType || '').trim().toLowerCase() === 'private'
      && typeof isAdminUser === 'function'
      && isAdminUser(senderId);
  }

  return async function handleClaudeSessionAdminCommand({
    route,
    groupId,
    senderId,
    chatType = 'group'
  }) {
    const normalizedChatType = String(chatType || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    if (!isAdminPrivateChat(normalizedChatType, senderId)) {
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: '仅管理员私聊可用。',
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    const command = route?.meta?.command || {};
    const cmd = String(command.cmd || '').trim().toLowerCase();
    const payload = String(command.payload || '').trim();
    const sessionKey = buildClaudeSessionKey(buildSessionId, normalizedChatType, senderId, groupId);
    const currentSession = claudeSessionRuntime.getSession(sessionKey);

    if (cmd === 'claude-open') {
      if (currentSession && ['open', 'running', 'idle'].includes(String(currentSession.status || '').trim().toLowerCase())) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: [
            `Claude 会话已存在。`,
            `session_id: ${String(currentSession.claude_session_id || 'unknown').trim() || 'unknown'}`,
            `status: ${String(currentSession.status || 'unknown').trim() || 'unknown'}`
          ].join('\n'),
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        const metadata = await runClaudeWrapperMetadataImpl('进入会话，等待后续指令。', null);
        const nextSession = claudeSessionRuntime.openSession({
          sessionKey,
          claudeSessionId: String(metadata.session_id || '').trim(),
          transcriptPath: String(metadata.transcript_path || '').trim(),
          status: 'open',
          lastPrompt: '进入会话，等待后续指令。'
        });
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: [
            'Claude 会话已建立。',
            `session_id: ${String(nextSession?.claude_session_id || 'unknown').trim() || 'unknown'}`,
            `status: ${String(nextSession?.status || 'open').trim() || 'open'}`
          ].join('\n'),
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: `Claude 会话创建失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      }
      return true;
    }

    if (cmd === 'claude-send') {
      if (!currentSession || !['open', 'running', 'idle'].includes(String(currentSession.status || '').trim().toLowerCase())) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '当前没有活跃 Claude 会话，请先发送 /claude-open。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }
      if (!payload) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '/claude-send 后面需要跟具体内容。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      try {
        claudeSessionRuntime.updateSession(sessionKey, {
          status: 'running',
          last_prompt: payload,
          active_run_id: `${Date.now()}`
        });
        void runClaudeWrapperMetadataImpl(payload, currentSession)
          .then((metadata) => {
            claudeSessionRuntime.updateSession(sessionKey, {
              claude_session_id: String(metadata.session_id || currentSession.claude_session_id || '').trim(),
              transcript_path: String(metadata.transcript_path || currentSession.transcript_path || '').trim(),
              status: 'idle',
              last_error: ''
            });
          })
          .catch((error) => {
            claudeSessionRuntime.updateSession(sessionKey, {
              status: 'failed',
              last_error: String(error?.message || error || 'unknown error').trim()
            });
          });

        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '已发送到 Claude 会话，使用 /claude-tail 查看输出。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      } catch (error) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: `Claude 会话发送失败：${String(error?.message || error || 'unknown error').trim()}`,
          atSender: false,
          retries: 1,
          waitMs: 300
        });
      }
      return true;
    }

    if (cmd === 'claude-tail') {
      if (!currentSession) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '当前没有 Claude 会话，请先发送 /claude-open。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }
      const tailResult = claudeSessionRuntime.readTail(sessionKey);
      const replyText = !tailResult.ok
        ? `Claude 会话输出不可读：${tailResult.reason}`
        : (tailResult.hasNewOutput
          ? tailResult.text
          : '当前没有新的 Claude 输出。');
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText,
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    if (cmd === 'claude-stop') {
      if (!currentSession) {
        await sendGroupReply({
          chatType: normalizedChatType,
          groupId,
          userId: senderId,
          senderId,
          replyText: '当前没有可关闭的 Claude 会话。',
          atSender: false,
          retries: 1,
          waitMs: 300
        });
        return true;
      }
      claudeSessionRuntime.closeSession(sessionKey);
      await sendGroupReply({
        chatType: normalizedChatType,
        groupId,
        userId: senderId,
        senderId,
        replyText: 'Claude 会话已关闭。',
        atSender: false,
        retries: 1,
        waitMs: 300
      });
      return true;
    }

    return false;
  };
}

module.exports = {
  buildClaudeSessionKey,
  runClaudeWrapperMetadata,
  createClaudeSessionAdminHandler
};
