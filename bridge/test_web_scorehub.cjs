'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const hubURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-scorehub.js'), 'utf8'));
const audioURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-audio.js'), 'utf8'));
const playerURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-player.js'), 'utf8').replace("'./web-audio.js'", JSON.stringify(audioURL)).replace("'./web-scorehub.js'", JSON.stringify(hubURL)));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
class Storage {
  constructor() { this.rows = new Map(); }
  get length() { return this.rows.size; }
  key(i) { return [...this.rows.keys()][i] ?? null; }
  getItem(key) { return this.rows.get(key) ?? null; }
  setItem(key, value) { this.rows.set(key, value); }
  removeItem(key) { this.rows.delete(key); }
}
class Media extends EventTarget {
  constructor() { super(); this.currentTime = 0; this.duration = 10; this.paused = true; this.playbackRate = 1; this.volume = 1; this.src = ''; this.muted = false; this.ended = false; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  canPlayType() { return ''; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  async play() { this.ended = false; this.paused = false; this.dispatchEvent(new Event('playing')); }
  end() { this.currentTime = this.duration; this.ended = true; this.dispatchEvent(new Event('ended')); }
}

async function main() {
  const { BrowserScoreHub, playerSessionId, referenceIdentity, validateReference } = await import(hubURL);
  let checks = 0;
  const eq = (actual, expected, message) => { assert.equal(actual, expected, message); ++checks; };
  const deep = (actual, expected, message) => { assert.deepEqual(actual, expected, message); ++checks; };
  const binding = { serverId: 'a'.repeat(32), accountId: 'nas:1000' }, other = { ...binding, accountId: 'nas:1001' };
  const identity = { mediaSha256: 'b'.repeat(64), mediaBytes: 10000, audioTrack: 1 };
  const reference = { status: 'ready', complete: true, referenceVersion: 5, timelineVersion: 2,
    method: 'demucs-htdemucs/torchcrepe-full/acoustic-v1', ...identity, requestedTrack: -1,
    stepMs: 40, durationMs: 10000, notes: Array(250).fill(69), revision: 'c'.repeat(64),
    url: 'private source should be omitted', cookies: 'not a credential fixture' };
  const session = value => ({ ...value, authenticated: true, nasGateway: true, devMode: false, browserScopeProtocol: 1 });
  const response = (data, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(data) });
  const storage = new Storage(), requests = [], playback = new Map(); let current = binding, ackMode = 'saved', heldReference = null, unavailable = false, pendingAt = 0;
  let randomCounter = 0;
  const random = { getRandomValues(bytes) { bytes.fill(++randomCounter); return bytes; } };
  const transport = async (url, options) => {
    requests.push({ url, options });
    if (unavailable) throw new Error('offline fixture');
    if (url.endsWith('/v1/session')) return response(session(current));
    const headers = options.headers;
    if (headers['X-Scorehub-Expected-Server-Id'] !== current.serverId || headers['X-Scorehub-Expected-Account-Id'] !== current.accountId) return response({}, 409);
    if (url.endsWith('/status')) return response({ ...current, protocol: 1, durable: true, accountScoped: true, browserScopeProtocol: 1 });
    if (url.includes('/v2/score-cache/')) {
      if (heldReference) return heldReference.promise;
      return response(url.endsWith('/-1') ? reference : { status: 'missing' });
    }
    const value = JSON.parse(options.body);
    if (url.endsWith('/playback')) { if (value.playing) playback.set(value.playerSessionId, true); else playback.delete(value.playerSessionId); return response({ status: 'saved' }); }
    if (url.endsWith('/results')) {
      if (ackMode === 'error') throw new Error('offline fixture');
      return response({ ...current, accountId: ackMode === 'wrong-account' ? other.accountId : current.accountId,
        status: ackMode === 'unconfirmed' ? 'pending' : ackMode === 'unchanged' ? 'unchanged' : 'saved',
        id: ackMode === 'wrong-id' ? 'another_record' : value.id,
        result: { ...value, score: ackMode === 'wrong-score' ? value.score - 1 : value.score,
          mediaSha256: ackMode === 'wrong-digest' ? 'd'.repeat(64) : value.mediaSha256,
          requestedTrack: ackMode === 'wrong-track' ? 0 : ackMode === 'missing-field' ? undefined : value.requestedTrack } });
    }
    throw new Error('Unexpected fixture route');
  };
  const hub = new BrowserScoreHub({ fetch: transport, storage, random, autoStart: false, clock: () => pendingAt });
  eq(/^[A-Za-z0-9_-]{16,64}$/.test(hub.sessionId), true, 'ordinary HTTP uses getRandomValues without randomUUID');
  eq(playerSessionId({}), null, 'lack of entropy never breaks module initialization or playback');
  await hub.refreshSession(); deep(hub.identity(), binding); eq(hub.state().authenticated, true);
  await hub.sendHeartbeat(); eq(requests.some(row => row.url.endsWith('/playback')), false, 'idle page does not repeatedly send stop heartbeats');
  eq(requests[0].options.credentials, 'same-origin'); eq(requests[0].options.redirect, 'error'); eq(requests[0].options.headers.Authorization, undefined);
  const readyIdentity = { status: 'ready', source: 'original-file-sha256', mediaSha256: identity.mediaSha256, mediaBytes: identity.mediaBytes, originalAudioTrack: 1 };
  deep(referenceIdentity(readyIdentity), identity);
  eq(referenceIdentity({ ...readyIdentity, originalAudioTrack: null }), null, 'unknown original roles are not guessed');
  eq(referenceIdentity({ ...readyIdentity, source: 'transcoded' }), null);
  const fetched = await hub.fetchReference(identity); deep(fetched.hubBinding, binding); eq(fetched.url, undefined); eq(fetched.cookies, undefined);
  for (const mutate of [{ mediaSha256: 'd'.repeat(64) }, { audioTrack: 0 }, { requestedTrack: 0 }, { complete: false }, { timelineVersion: 1 }, { revision: '' }, { durationMs: 20000 }, { notes: Array(250).fill(null) }]) {
    assert.throws(() => validateReference({ ...reference, ...mutate }, identity, -1)); ++checks;
  }
  const lookup = requests.find(row => row.url.includes('/score-cache/') && row.url.endsWith('/-1'));
  eq(lookup.options.headers['X-Scorehub-Expected-Account-Id'], binding.accountId); eq(lookup.options.headers['X-Scorehub-Expected-Server-Id'], binding.serverId);
  const oldFetch = deferred(); heldReference = oldFetch;
  const reading = hub.fetchReference(identity); await flush(); current = other; await hub.refreshSession(); oldFetch.resolve(response(reference));
  await assert.rejects(reading, error => error.name === 'AbortError'); ++checks; heldReference = null;
  deep(hub.identity(), other); current = binding; await hub.refreshSession();
  const result = { id: 'take_00000001', mediaSha256: identity.mediaSha256, requestedTrack: -1, title: '真实演唱 fixture', score: 88, cookies: 'discard this field', mediaUrl: 'discard this field' };
  ackMode = 'error'; eq(hub.queueResult(result, binding), true); await flush(); eq(hub.pending(binding).length, 1);
  eq(JSON.stringify([...storage.rows.values()]).includes('cookies'), false); eq(JSON.stringify([...storage.rows.values()]).includes('mediaUrl'), false);
  eq(hub.queueResult(result, binding), true, 'same id and payload is durably accepted');
  eq(hub.queueResult({ ...result, score: 87 }, binding), false, 'same id must not silently replace an earlier result');
  eq(hub.queueResult({ ...result, score: null }, binding), false);
  current = other; await hub.refreshSession(); pendingAt += 30001; await hub.flush(); eq(hub.pending(binding).length, 1); eq(hub.pending(other).length, 0);
  eq(requests.filter(row => row.url.endsWith('/results') && row.options.headers['X-Scorehub-Expected-Account-Id'] === other.accountId).length, 0, 'account A result cannot be readdressed to B');
  current = binding; await hub.refreshSession();
  for (const invalid of ['wrong-account', 'wrong-id', 'wrong-score', 'wrong-digest', 'wrong-track', 'missing-field', 'unconfirmed']) {
    ackMode = invalid; pendingAt += 30001; await hub.flush(); eq(hub.pending(binding).length, 1, 'inexact ACK keeps outbox');
  }
  ackMode = 'unchanged'; pendingAt += 30001; await hub.flush(); eq(hub.pending(binding).length, 0, 'exact id/account/payload unchanged ACK completes durable handoff');
  // Each record has its own storage key: concurrent tabs cannot overwrite lists.
  ackMode = 'error'; hub.queueResult({ ...result, id: 'take_00000002' }, binding); await flush();
  const tab2 = new BrowserScoreHub({ fetch: transport, storage, random, autoStart: false }); await tab2.refreshSession();
  eq(tab2.pending(binding).length, 1, 'a fresh page restores bound pending results without changing account');
  tab2.queueResult({ ...result, id: 'take_00000003' }, binding); await flush(); eq(hub.pending(binding).length, 2);
  hub.setPlaying(true); tab2.setPlaying(true); await flush(); eq(playback.size, 2); assert.notEqual(hub.sessionId, tab2.sessionId); ++checks;
  hub.setPlaying(false); await flush(); eq(playback.size, 1, 'stopping one tab preserves the other playback TTL');
  // Pending uploads cannot occupy or prevent the independent heartbeat request.
  const blocked = deferred(), slow = new BrowserScoreHub({ random, storage: new Storage(), autoStart: false,
    fetch: async (url, options) => url.endsWith('/results') ? blocked.promise : transport(url, options) });
  await slow.refreshSession(); slow.queueResult({ ...result, id: 'take_blocked01' }, binding); await flush();
  slow.setPlaying(true); await flush(); eq(playback.has(slow.sessionId), true);
  blocked.resolve(response({ ...binding, status: 'saved', id: 'take_blocked01', result: { id: 'take_blocked01', mediaSha256: result.mediaSha256, requestedTrack: result.requestedTrack, title: result.title, score: result.score } })); await flush();
  const incapable = new BrowserScoreHub({ random, autoStart: false, fetch: async () => response({ ...session(binding), browserScopeProtocol: undefined }) });
  await incapable.refreshSession(); eq(incapable.identity(), null, 'old hub ignoring expected scope headers is refused');
  const badProtocol = new BrowserScoreHub({ random, autoStart: false, fetch: async url => response(url.endsWith('/session') ? session(binding) : { ...binding, protocol: 1, durable: true, accountScoped: true }) });
  await badProtocol.refreshSession(); await assert.rejects(badProtocol.fetchReference(identity), /协议/); ++checks;
  // Valid identity is retained for bound offline outbox, but 401 is authoritative.
  unavailable = true; await hub.refreshSession(); deep(hub.identity(), binding); unavailable = false;
  const revoked = new BrowserScoreHub({ random, autoStart: false, fetch: async url => url.endsWith('/session') ? response(session(binding)) : response({}, 401) });
  await revoked.refreshSession(); await assert.rejects(revoked.fetchReference(identity)); ++checks; eq(revoked.identity(), null);
  // Real player + consumer, synthetic pitch observations only; no microphone
  // permission, playback device or measured singer is claimed by these tests.
  const { KaraokePlayer } = await import(playerURL);
  global.location = { origin: 'http://nas.fixture', pathname: '/app/feiniu-karaoke/sing' };
  const playerStorage = new Storage(), bridgeRequests = [], playerHub = new BrowserScoreHub({ fetch: transport, storage: playerStorage, random, autoStart: false });
  await playerHub.refreshSession(); ackMode = 'error';
  const bridgeApi = async (url, options) => {
    bridgeRequests.push({ url, options });
    if (url.startsWith('/api/lyrics/')) return {};
    if (url.startsWith('/api/v2/score-identity/')) return options?.method === 'DELETE' ? {} : readyIdentity;
    if (url.startsWith('/api/v2/playback/')) return { mediaKind: 'audio', transport: 'progressive', playUrl: '/stream/1', durationMs: 10000, audioTracks: [] };
    throw Error('Unexpected bridge fixture route');
  };
  const media = new Media(), player = new KaraokePlayer({ media, api: bridgeApi, scoreHub: playerHub });
  player.state.micEnabled = true; player.setScoring(true); await player.load({ id: 1, title: '本机真实媒体 fixture' }); await flush();
  eq(player.state.scoreStatus, 'ready'); eq(player.state.score, null, 'reference availability never invents a score');
  const sing = pitch => { for (let i = 0; i < 250; i++) { media.currentTime = i * .04; player.observeMic({ pitch, level: pitch === null ? 0 : .5, delayMs: 0 }); } };
  sing(69); media.end(); await flush(); eq(playerHub.pending(binding).length, 1, 'full ended measured take is durably queued');
  const firstId = playerHub.pending(binding)[0].row.result.id;
  media.dispatchEvent(new Event('ended')); await flush(); eq(playerHub.pending(binding).length, 1, 'duplicate media end cannot create a second record');
  await player.replay(); media.dispatchEvent(new Event('seeked')); sing(69); media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'repeat is a distinct completed take');
  assert.notEqual(playerHub.pending(binding)[1].row.result.id, firstId); ++checks;
  await player.replay(); sing(null); media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'silent microphone is not an uploaded score');
  await player.replay(); sing(69); player.audio.callbacks.onMicEnded(); media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'interrupted microphone is partial even with an earlier score');
  player.state.micEnabled = true; await player.replay(); sing(69); player.seek(5); media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'seeked take cannot be reported as a complete song');
  await player.replay(); sing(69); player.setScoring(false); media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'disabled scoring cannot submit an earlier score');
  player.setScoring(true); await flush(); await player.replay();
  for (let i = 10; i < 250; i++) { media.currentTime = i * .04; player.observeMic({ pitch: 69, level: .5, delayMs: 0 }); }
  media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'missing the beginning is not a complete timeline'); eq(player.state.score.partial, true);
  await player.replay(); for (let i = 0; i < 80; i++) { media.currentTime = i * .04; player.observeMic({ pitch: 69, level: .5, delayMs: 0 }); }
  media.end(); await flush(); eq(playerHub.pending(binding).length, 2, 'an earlier score without the ending cannot be uploaded');
  await player.replay(); sing(69); media.error = { code: 4 }; media.dispatchEvent(new Event('error')); media.end(); await flush();
  eq(playerHub.pending(binding).length, 2, 'failed media is not a complete take'); eq(playerHub.playing, false, 'failed media stops renewal of playback heartbeats'); media.error = null;
  await player.replay(); sing(69); current = other; await playerHub.refreshSession(); await flush();
  eq(player.state.score, null, 'account switch removes current remote performance'); eq(player.reference?.hubBinding.accountId, other.accountId);
  media.end(); await flush(); eq(playerHub.pending(other).length, 0, 'old take is never re-bound to new account'); eq(playerHub.pending(binding).length, 2);
  eq(bridgeRequests.some(row => row.url.startsWith('/api/score/')), false, 'no old global scoring generation fallback');
  eq(bridgeRequests.some(row => row.url.includes('/queue') || row.url.includes('/ws')), false, 'independent karaoke cannot write the TV queue');
  await player.destroy(); current = binding;
  global.isSecureContext = false;
  const readOnlyHub = new BrowserScoreHub({ fetch: transport, storage: new Storage(), random, autoStart: false }); await readOnlyHub.refreshSession();
  const readOnlyMedia = new Media(), readOnly = new KaraokePlayer({ media: readOnlyMedia, api: bridgeApi, scoreHub: readOnlyHub });
  readOnly.setScoring(true); await readOnly.load({ id: 1, title: 'HTTP 只读谱 fixture' }); await flush();
  eq(readOnly.state.scoreStatus, 'ready', 'ordinary HTTP can consume a score reference without microphone'); eq(readOnly.state.micEnabled, false); eq(readOnly.state.score, null);
  eq(readOnly.state.scoreMessage.includes('HTTPS'), true); await assert.rejects(readOnly.setMicrophone(true), /HTTPS/); ++checks;
  readOnlyMedia.end(); await flush(); eq(readOnlyHub.pending(binding).length, 0, 'HTTP never invents or submits singing'); await readOnly.destroy(); delete global.isSecureContext;
  for (const client of [hub, tab2, slow, incapable, badProtocol, revoked]) client.close(); await flush(); eq(playback.size, 0);
  eq(requests.some(row => row.url.includes('/api/score/') || row.url.includes('/api/queue') || row.url.includes('/ws')), false);
  process.stdout.write(`web scorehub: ${checks} checks passed\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
