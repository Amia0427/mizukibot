const {
  estimateTokens,
  normalizeObject,
  normalizeText
} = require('./text');

class OpenVikingCommitScheduler {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
    this.sessions = new Map();
    this.auth = new Map();
    this.timers = new Map();
  }

  getState(sessionId = '') {
    const id = normalizeText(sessionId);
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        pendingMessages: 0,
        pendingTokens: 0,
        lastMessageAt: 0,
        lastCommitAt: 0,
        committing: false
      });
    }
    return this.sessions.get(id);
  }

  setAuth(sessionId = '', auth = {}) {
    const id = normalizeText(sessionId);
    if (id) this.auth.set(id, normalizeObject(auth));
  }

  recordMessage(sessionId = '', tokenEstimate = 0, auth = {}) {
    const id = normalizeText(sessionId);
    if (!id) return { scheduled: false, reason: 'missing_session' };
    if (auth && Object.keys(normalizeObject(auth)).length > 0) this.setAuth(id, auth);
    const state = this.getState(id);
    state.pendingMessages += 1;
    state.pendingTokens += Math.max(1, Math.floor(Number(tokenEstimate || 0) || 0));
    state.lastMessageAt = Date.now();
    this.resetIdleTimer(id);
    if (this.shouldCommit(state)) {
      this.commitSoon(id);
      return { scheduled: true, reason: 'threshold' };
    }
    return { scheduled: false, reason: 'below_threshold' };
  }

  recordText(sessionId = '', text = '', auth = {}) {
    return this.recordMessage(sessionId, estimateTokens(text), auth);
  }

  shouldCommit(state = {}) {
    if (!state || state.committing) return false;
    const messageThreshold = Math.max(1, Number(this.config.OPENVIKING_COMMIT_MESSAGE_THRESHOLD || 20) || 20);
    const tokenThreshold = Math.max(1, Number(this.config.OPENVIKING_COMMIT_TOKEN_THRESHOLD || 4096) || 4096);
    return Number(state.pendingMessages || 0) >= messageThreshold
      || Number(state.pendingTokens || 0) >= tokenThreshold;
  }

  resetIdleTimer(sessionId = '') {
    const id = normalizeText(sessionId);
    if (!id) return;
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const idleMs = Math.max(1000, Number(this.config.OPENVIKING_COMMIT_IDLE_MS || 30 * 60 * 1000) || 30 * 60 * 1000);
    const timer = setTimeout(() => {
      this.commitSoon(id);
    }, idleMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(id, timer);
  }

  commitSoon(sessionId = '') {
    const id = normalizeText(sessionId);
    if (!id) return;
    setImmediate(() => {
      this.commitSession(id).catch((error) => {
        if (this.config.ENABLE_DEBUG_LOG) {
          console.warn('[openviking] commit failed:', error?.message || error);
        }
      });
    });
  }

  async commitSession(sessionId = '') {
    const id = normalizeText(sessionId);
    if (!id) return { committed: false, reason: 'missing_session' };
    const state = this.getState(id);
    if (state.committing) return { committed: false, reason: 'already_committing' };
    if (state.pendingMessages <= 0) return { committed: false, reason: 'no_pending_messages' };
    state.committing = true;
    try {
      await this.client.commitSession(id, this.auth.get(id) || {});
      state.pendingMessages = 0;
      state.pendingTokens = 0;
      state.lastCommitAt = Date.now();
      return { committed: true };
    } finally {
      state.committing = false;
    }
  }

  getStatus(sessionId = '') {
    const state = this.getState(sessionId);
    return {
      pendingMessages: state.pendingMessages,
      pendingTokens: state.pendingTokens,
      lastMessageAt: state.lastMessageAt,
      lastCommitAt: state.lastCommitAt,
      committing: state.committing
    };
  }
}

module.exports = {
  OpenVikingCommitScheduler
};
