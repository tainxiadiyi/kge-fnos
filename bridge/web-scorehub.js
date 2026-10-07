/* Same-origin NAS score consumer. No source credentials, media URLs or audio
 * enter this client. Each completed take keeps the account verified at start. */
const SERVER = /^[0-9a-f]{32}$/, ACCOUNT = /^nas:[0-9]{1,20}$/, DIGEST = /^[0-9a-f]{64}$/;
const METHOD = 'demucs-htdemucs/torchcrepe-full/acoustic-v1';
const OUTBOX = 'kge-scorehub-result-v1:';
const same = (a, b) => Boolean(a && b && a.serverId === b.serverId && a.accountId === b.accountId);
const validBinding = value => Boolean(value && typeof value.serverId === 'string' && typeof value.accountId === 'string' && SERVER.test(value.serverId) && ACCOUNT.test(value.accountId));
const abortError = () => Object.assign(new Error('评分连接已变化'), { name: 'AbortError' });
const safeStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

// This ID is a public playback identifier, never an authentication credential.
export function playerSessionId(random = globalThis.crypto) {
  try { if (typeof random?.randomUUID === 'function') return random.randomUUID(); } catch {}
  try { const bytes = new Uint8Array(16); random.getRandomValues(bytes); return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join(''); } catch {}
  return null; // Playback still works when secure entropy is unavailable.
}

export function referenceIdentity(value) {
  if (value?.status !== 'ready' || value.source !== 'original-file-sha256' || !DIGEST.test(value.mediaSha256)
      || !Number.isSafeInteger(value.mediaBytes) || value.mediaBytes <= 0
      || !Number.isInteger(value.originalAudioTrack) || value.originalAudioTrack < 0 || value.originalAudioTrack > 63) return null;
  return { mediaSha256: value.mediaSha256, mediaBytes: value.mediaBytes, audioTrack: value.originalAudioTrack };
}

export function validateReference(data, identity, requestedTrack) {
  if (!data || data.status !== 'ready' || data.complete !== true || data.referenceVersion !== 5
      || !Number.isInteger(data.timelineVersion) || data.timelineVersion < 2 || data.method !== METHOD
      || data.mediaSha256 !== identity.mediaSha256 || data.requestedTrack !== requestedTrack
      || data.audioTrack !== identity.audioTrack || !DIGEST.test(data.revision)
      || (data.mediaBytes != null && data.mediaBytes !== identity.mediaBytes)
      || !Number.isInteger(data.stepMs) || data.stepMs < 10 || data.stepMs > 200
      || !Number.isInteger(data.durationMs) || data.durationMs < 1000
      || !Array.isArray(data.notes) || data.notes.length < 50 || data.notes.length > 180000
      || Math.abs(data.notes.length * data.stepMs - data.durationMs) > data.stepMs * 2
      || data.notes.some(n => n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 128))
      || data.notes.filter(n => n !== null).length < 50) throw new Error('评分中心返回的谱与原媒体或原唱音轨不一致');
  // Copy only portable fields; URLs, provider cookies and private paths stay out.
  return { status: 'ready', complete: true, referenceVersion: 5, timelineVersion: data.timelineVersion,
    method: METHOD, mediaSha256: data.mediaSha256, requestedTrack, audioTrack: data.audioTrack,
    stepMs: data.stepMs, durationMs: data.durationMs, notes: [...data.notes], revision: data.revision };
}

function resultData(value) {
  if (!value || !/^[A-Za-z0-9_-]{8,80}$/.test(value.id) || !DIGEST.test(value.mediaSha256)
      || !Number.isInteger(value.requestedTrack) || value.requestedTrack < -1 || value.requestedTrack > 63
      || !Number.isInteger(value.score) || value.score < 0 || value.score > 100 || typeof value.title !== 'string') return null;
  return { id: value.id, mediaSha256: value.mediaSha256, requestedTrack: value.requestedTrack,
    score: value.score, title: value.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) };
}

export class BrowserScoreHub {
  constructor({ fetch = globalThis.fetch?.bind(globalThis), storage = safeStorage(), clock = Date.now,
    onScopeChange = () => {}, onState = () => {}, autoStart = true, random = globalThis.crypto } = {}) {
    this.fetch = fetch; this.storage = storage; this.clock = clock; this.onScopeChange = onScopeChange; this.onState = onState;
    this.binding = null; this.epoch = 0; this.closed = false; this.protocolEpoch = -1; this.controllers = new Set(); this.retry = new Map();
    this.sessionId = playerSessionId(random); this.playing = false; this.stopPending = false; this.playbackBinding = null;
    this.status = { authenticated: false, connected: false, message: '正在连接评分中心', pendingResults: 0 };
    if (autoStart) this.start();
  }
  state() { return { ...this.status, binding: this.identity() }; }
  identity() { return this.binding ? { ...this.binding } : null; }
  emit() { if (!this.closed) this.onState(this.state()); }
  usable(binding) { return !this.closed && this.status.authenticated && same(binding, this.binding); }
  start() {
    if (this.timer || this.closed) return;
    this.refreshSession().then(() => this.flush()).catch(() => {});
    this.timer = setInterval(() => {
      this.refreshSession().catch(() => {});
      this.sendHeartbeat().catch(() => {}); // Independent of reference and outbox requests.
      this.flush().catch(() => {});
    }, 6000);
    this.timer.unref?.();
  }
  setBinding(binding, message) {
    if (Boolean(binding) !== Boolean(this.binding) || (binding && !same(binding, this.binding)) || Boolean(binding) !== this.status.authenticated) {
      ++this.epoch; this.protocolEpoch = -1;
      for (const controller of this.controllers) controller.abort();
      this.binding = binding ? { serverId: binding.serverId, accountId: binding.accountId } : null;
      this.status.authenticated = Boolean(binding);
      this.status.pendingResults = 0;
      // A playing page can connect after audio started. Heartbeats follow the
      // current authenticated page; completed takes keep their frozen binding.
      this.playbackBinding = this.identity();
      this.stopPending = false;
      this.onScopeChange(this.identity());
    }
    this.status.connected = Boolean(binding); this.status.message = message; this.emit();
  }
  async request(path, { binding = null, signal, method = 'GET', body, checkEpoch = true } = {}) {
    if (this.closed || typeof this.fetch !== 'function') throw new Error('评分中心暂不可连接');
    if (!/^\/v[12]\/[A-Za-z0-9_/-]+$/.test(path)) throw new Error('评分接口无效');
    if (binding && !this.usable(binding)) throw abortError();
    const epoch = this.epoch, controller = new AbortController(), headers = { Accept: 'application/json' };
    this.controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 8000); timeout.unref?.();
    if (binding) { headers['X-Scorehub-Expected-Server-Id'] = binding.serverId; headers['X-Scorehub-Expected-Account-Id'] = binding.accountId; }
    if (method !== 'GET') { headers['X-Scorehub-Request'] = '1'; headers['Content-Type'] = 'application/json'; }
    try {
      const response = await this.fetch('/app/kge-score/api' + path, { method, headers, credentials: 'same-origin',
        redirect: 'error', cache: 'no-store', signal: controller.signal, ...(body == null ? {} : { body: JSON.stringify(body) }) });
      if (this.closed || (checkEpoch && epoch !== this.epoch) || controller.signal.aborted) throw abortError();
      if (!response.ok) {
        if ([401, 403, 409].includes(response.status) || (response.status === 404 && path === '/v1/session')) this.setBinding(null, response.status === 409 ? '评分账号已变化，请重新连接' : '请从飞牛入口重新登录评分中心');
        const error = new Error(response.status === 404 ? '当前未安装兼容的评分中心' : '评分中心暂无法完成请求'); error.status = response.status; throw error;
      }
      let data;
      if (typeof response.text === 'function') { const text = await response.text(); if (text.length > 8 * 1024 * 1024) throw new Error('评分参考过大'); data = JSON.parse(text); }
      else data = await response.json();
      if (this.closed || (checkEpoch && epoch !== this.epoch) || controller.signal.aborted) throw abortError();
      return data;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }
  async refreshSession() {
    if (this.closed) return null;
    if (this.sessionRequest) return this.sessionRequest;
    this.sessionRequest = (async () => {
      try {
        const data = await this.request('/v1/session');
        if (data?.authenticated !== true || data.nasGateway !== true || data.devMode !== false || data.browserScopeProtocol !== 1 || !validBinding(data)) {
          this.setBinding(null, '请从飞牛入口登录评分中心'); return null;
        }
        this.setBinding(data, '已连接 NAS 评分中心'); return this.identity();
      } catch (error) {
        if (!this.closed && error.name !== 'AbortError') { this.status.connected = false; this.status.message = error.message; this.emit(); }
        return null;
      } finally { this.sessionRequest = null; }
    })();
    return this.sessionRequest;
  }
  async ensureProtocol(binding, signal) {
    const epoch = this.epoch; if (this.protocolEpoch === epoch) return;
    const data = await this.request('/v2/score-cache/status', { binding, signal });
    if (data?.protocol !== 1 || data.browserScopeProtocol !== 1 || data.durable !== true || data.accountScoped !== true || !same(data, binding)) {
      this.setBinding(null, '评分中心协议或账号范围不兼容'); throw new Error('评分中心协议或账号范围不兼容');
    }
    if (epoch !== this.epoch) throw abortError(); this.protocolEpoch = epoch;
  }
  async fetchReference(identity, { binding = this.identity(), signal } = {}) {
    if (!this.usable(binding)) return null;
    await this.ensureProtocol(binding, signal);
    for (const track of [-1, identity.audioTrack]) {
      const data = await this.request('/v2/score-cache/' + identity.mediaSha256 + '/' + track, { binding, signal });
      if (data?.status === 'missing') continue;
      const reference = validateReference(data, identity, track);
      return { ...reference, hubBinding: { ...binding } };
    }
    return null;
  }
  setPlaying(playing, binding = this.identity()) {
    if (this.playing && !playing) this.stopPending = true;
    this.playing = Boolean(playing); this.playbackBinding = validBinding(binding) ? { ...binding } : null;
    this.sendHeartbeat().catch(() => {});
  }
  async sendHeartbeat() {
    const binding = this.playbackBinding;
    if (this.heartbeatRequest || !this.sessionId || !this.usable(binding) || (!this.playing && !this.stopPending)) return;
    const playing = this.playing;
    this.heartbeatRequest = true;
    try {
      await this.request('/v1/playback', { binding, method: 'POST', body: { playing, playerSessionId: this.sessionId } });
      if (!playing && same(binding, this.playbackBinding)) this.stopPending = false;
    } finally { this.heartbeatRequest = false; if (playing !== this.playing) this.sendHeartbeat().catch(() => {}); }
  }
  outboxKey(binding, id) { return OUTBOX + binding.serverId + ':' + binding.accountId + ':' + id; }
  queueResult(value, binding) {
    const data = resultData(value); if (!data || !validBinding(binding) || !this.storage) return false;
    const key = this.outboxKey(binding, data.id), row = { version: 1, binding: { serverId: binding.serverId, accountId: binding.accountId }, result: data };
    try {
      const previous = this.storage.getItem(key);
      if (previous && previous !== JSON.stringify(row)) return false;
      this.storage.setItem(key, JSON.stringify(row));
      if (this.storage.getItem(key) !== JSON.stringify(row)) return false;
    } catch { this.status.message = '浏览器无法保存成绩待办，请检查本机存储空间'; this.emit(); return false; }
    this.flush().catch(() => {}); return true;
  }
  pending(binding) {
    const rows = []; if (!this.storage || !validBinding(binding)) return rows;
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i); if (!key?.startsWith(OUTBOX + binding.serverId + ':' + binding.accountId + ':')) continue;
        try {
          const row = JSON.parse(this.storage.getItem(key));
          if (row?.version === 1 && same(row.binding, binding) && resultData(row.result)
              && this.outboxKey(binding, row.result.id) === key) rows.push({ key, row });
        } catch {} // Preserve unrecognized records, never send them under another account.
      }
    } catch {}
    return rows;
  }
  async flush() {
    if (this.flushing || !this.usable(this.binding)) return;
    const binding = this.identity(); this.flushing = true;
    try {
      await this.ensureProtocol(binding);
      const rows = this.pending(binding); this.status.pendingResults = rows.length; this.emit();
      for (const { key, row } of rows.filter(({ key }) => (this.retry.get(key) || 0) <= this.clock()).slice(0, 5)) {
        if (!this.usable(binding)) break;
        try {
          const ack = await this.request('/v1/results', { binding, method: 'POST', body: row.result });
          if (!same(ack, binding) || !['saved', 'unchanged'].includes(ack.status) || ack.id !== row.result.id
              || !Object.entries(row.result).every(([field, value]) => ack.result?.[field] === value)) throw new Error('成绩尚未获得同账号确认');
          // Another tab can already have removed this same id after an idempotent ACK.
          if (this.storage.getItem(key) === JSON.stringify(row)) this.storage.removeItem(key);
          this.retry.delete(key);
        } catch (error) {
          this.retry.set(key, this.clock() + 30000);
          if (error.name !== 'AbortError') { this.status.message = '演唱成绩已保留，将在原账号连接后重试'; this.emit(); }
        }
      }
      if (this.usable(binding)) { this.status.pendingResults = this.pending(binding).length; this.emit(); }
    } finally { this.flushing = false; }
  }
  close() {
    if (this.closed) return;
    const binding = this.playbackBinding;
    if ((this.playing || this.stopPending) && this.sessionId && this.usable(binding)) this.fetch('/app/kge-score/api/v1/playback', { method: 'POST',
      credentials: 'same-origin', redirect: 'error', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Scorehub-Request': '1',
        'X-Scorehub-Expected-Server-Id': binding.serverId, 'X-Scorehub-Expected-Account-Id': binding.accountId },
      body: JSON.stringify({ playing: false, playerSessionId: this.sessionId }) }).catch(() => {});
    this.closed = true; clearInterval(this.timer); ++this.epoch;
    for (const controller of this.controllers) controller.abort(); this.controllers.clear();
  }
}
