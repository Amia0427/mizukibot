class BoundedCache {
  constructor(options = {}) {
    this.maxEntries = Math.max(1, Number(options.maxEntries || 256) || 256);
    this.ttlMs = Math.max(0, Number(options.ttlMs || 0) || 0);
    this.map = new Map();
  }

  _isExpired(entry, now = Date.now()) {
    if (!entry) return true;
    if (this.ttlMs <= 0) return false;
    return (now - Number(entry.updatedAt || 0)) > this.ttlMs;
  }

  _touch(key, entry, now = Date.now()) {
    const next = {
      ...entry,
      updatedAt: now
    };
    this.map.delete(key);
    this.map.set(key, next);
    return next;
  }

  _trim(now = Date.now()) {
    for (const [key, entry] of this.map.entries()) {
      if (this._isExpired(entry, now)) {
        this.map.delete(key);
      }
    }
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  get(key) {
    const entry = this.map.get(key);
    const now = Date.now();
    if (!entry || this._isExpired(entry, now)) {
      this.map.delete(key);
      return undefined;
    }
    return this._touch(key, entry, now).value;
  }

  set(key, value) {
    const now = Date.now();
    this.map.set(key, {
      value,
      updatedAt: now
    });
    this._trim(now);
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  getOrCompute(key, factory) {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = typeof factory === 'function' ? factory() : undefined;
    if (value === undefined) return undefined;
    this.set(key, value);
    return value;
  }

  entries() {
    this._trim(Date.now());
    return Array.from(this.map.entries()).map(([key, entry]) => [key, entry.value]);
  }

  size() {
    this._trim(Date.now());
    return this.map.size;
  }
}

module.exports = {
  BoundedCache
};
