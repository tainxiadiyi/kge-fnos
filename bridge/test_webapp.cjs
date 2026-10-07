'use strict';
// Exercise the actual UI module and player against a small DOM fixture.
// This checks state boundaries; it does not replace browser/device acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = new Map(); this.handlers = new Map(); this.value = ''; this.open = false; this.textContent = ''; this.style = {setProperty() {}}; this.classList = {add() {}, toggle() {}}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, callback) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(callback); }
  removeEventListener(name, callback) { this.handlers.set(name, (this.handlers.get(name) || []).filter(value => value !== callback)); }
  dispatchEvent(event) { for (const callback of this.handlers.get(event.type) || []) callback(event); }
  async trigger(name) { for (const callback of this.handlers.get(name) || []) await callback({type: name}); }
  get options() { return this.children; }
  getContext() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() {}
}
class Media extends Element {
  constructor() { super('video'); this.paused = true; this.currentTime = 0; this.duration = 30; this.volume = 1; this.playbackRate = 1; this.src = ''; this.actualStarts = 0; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  canPlayType() { return ''; }
  pause() { this.paused = true; this.dispatchEvent({type: 'pause'}); }
  async play() { this.paused = false; ++this.actualStarts; this.dispatchEvent({type: 'playing'}); }
}

async function main() {
  let checks = 0;
  const eq = (actual, expected, message) => { assert.equal(actual, expected, message); ++checks; };
  const deep = (actual, expected, message) => { assert.deepEqual(actual, expected, message); ++checks; };
  const elements = new Map(), created = [], media = new Media(), badges = [new Element(), new Element()], microphoneButton = new Element();
  elements.set('media', media);
  global.location = {pathname: '/app/feiniu-karaoke/sing', origin: 'http://nas.fixture'};
  global.window = {innerWidth: 420, innerHeight: 920, addEventListener() {}, removeEventListener() {}};
  global.document = {
    hidden: false, activeElement: null, addEventListener() {}, removeEventListener() {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement(tag) { const value = new Element(tag); created.push(value); return value; },
    createTextNode(value) { return {textContent: value}; },
    querySelector(selector) { return selector === '.sing-mic' ? microphoneButton : null; },
    querySelectorAll(selector) { return selector === '.float-queue,.sing-queue' ? badges : []; },
  };
  const stored = new Map();
  global.localStorage = {getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value)};
  let entropy = 0, createdUrls = 0;
  Object.defineProperty(global, 'crypto', {configurable: true, value: {getRandomValues(bytes) { bytes.fill(++entropy); return bytes; }}});
  global.isSecureContext = false;
  const revoked = [];
  URL.revokeObjectURL = value => revoked.push(value);
  URL.createObjectURL = () => 'blob:fixture-' + (++createdUrls);
  let delayedPlayback;
  global.fetch = async address => {
    const value = String(address);
    let body = {};
    if (value.includes('/api/v2/playback/')) {
      if (value.endsWith('/101') && delayedPlayback) return delayedPlayback.promise;
      body = {mediaKind: 'audio', transport: 'progressive', playUrl: '/stream/' + value.split('/').at(-1), audioTracks: []};
    } else if (value.includes('/api/lyrics/')) body = {content: '[00:00.00]合成测试歌词'};
    else if (value.includes('/api/songs?')) body = {items: [], total: 0};
    return {ok: true, status: 200, json: async () => body};
  };
  const audioURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-audio.js'), 'utf8'));
  const hubURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-scorehub.js'), 'utf8'));
  const playerURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-player.js'), 'utf8').replace("'./web-audio.js'", JSON.stringify(audioURL)).replace("'./web-scorehub.js'", JSON.stringify(hubURL)));
  let source = fs.readFileSync(path.join(__dirname, 'webapp.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'singing.html'), 'utf8');
  eq(/<script[^>]+src=["'][^"']*hls\.min\.js/i.test(html), false, 'home does not block on the HLS library');
  for (const module of ['webapp.js', 'web-player.js', 'web-audio.js']) eq(html.includes(`rel="modulepreload" href="./player-assets/${module}"`), true);
  eq(html.includes('正在加载本机演唱界面'), true, 'the HTML shell remains readable before JavaScript');
  eq(html.includes('href="?reload=1"'), true, 'HTML reload works without JavaScript');
  eq(/<nav[^>]+id="navigation"[\s\S]*?<button[^>]+disabled/.test(html), true, 'initial navigation honestly waits for JavaScript');
  assert.equal((source.match(/renderPage\(\);resize\(\);start\(\);/g) || []).length, 1);
  source = source.replace("'./web-player.js'", JSON.stringify(playerURL)).replace(/import\.meta\.url/g, "'http://nas.fixture/app/feiniu-karaoke/player-assets/webapp.js'").replace('renderPage();resize();start();', '');
  source += '\nexport {state,player,objectUrls,lyricFiles,recordedPlays,settledScores,enqueue,play,advance,clearQueue,showAudio,settleScore,resize,buildSingingControls};\nexport function inspectApp(){return {storageKey,settingsState,playingKey,playingQueueId,playSerial,scopeSerial};}\n';
  source += '\nexport {start,navigate,node,asset,originalAsset};\n';
  const app = await import(dataURL(source));

  eq(app.makeRecordId({randomUUID: () => 'native-record', getRandomValues: () => {throw Error('must prefer UUID');}}), 'native-record');
  eq(app.makeRecordId({getRandomValues: bytes => bytes.fill(15)}), '0f'.repeat(16), 'HTTP does not require randomUUID');
  eq(app.makeRecordId({randomUUID: () => {throw Error('blocked');}, getRandomValues: bytes => bytes.fill(2)}), '02'.repeat(16));
  const fallbackA = app.makeRecordId(null), fallbackB = app.makeRecordId({getRandomValues: () => {throw Error('blocked');}});
  eq(fallbackA.startsWith('record-'), true); eq(fallbackA !== fallbackB, true);
  const defaultsA = app.defaultSettings(), defaultsB = app.defaultSettings(); defaultsA.eq.bass = 4; defaultsA.bands[0] = 4;
  eq(defaultsB.eq.bass, 0); eq(defaultsB.bands[0], 0);
  eq(app.needsSavedAudio(defaultsB), false); eq(app.needsSavedAudio({...defaultsB, pitch: 3}), true);

  stored.set('feiniu-karaoke:web:account-a', JSON.stringify({version: 1, queue: [{id: 100, title: '旧账号待唱'}],
    favorites: [{id: 100}], history: [{id: 100}], local: [{id: 'local:old', local: true, fileName: 'old.wav'}],
    settings: {volume: .3, rate: 1.2, pitch: 7, effect: 'cartoon', bands: Array(10).fill(4), preamp: 3, scoring: true, monitoring: true, deviceId: 'old-device'}}));
  await app.switchCatalogScope({catalogScope: 'account-a'}); app.applyScopeSettings(); app.state.ready = true; app.state.page = 'songs';
  eq(app.player.audio.context, null, 'scope activation cannot create an AudioContext');
  eq(app.player.audio.pitch, 7); eq(app.player.audio.effect, 'cartoon'); eq(app.player.state.scoreEnabled, true);
  eq(typeof app.state.queue[0].queueId, 'string');
  app.objectUrls.set('local:old', 'blob:old-account'); app.lyricFiles.set('local:old', '旧歌词');
  app.recordedPlays.add('old-play'); app.settledScores.add('old-score');
  const controller = new AbortController(); app.state.abort = controller;
  let stoppedTracks = 0; app.player.audio.stream = {getTracks: () => [{stop() {++stoppedTracks;}}]}; app.player.audio.monitor = true; app.player.state.micEnabled = true;
  delayedPlayback = deferred(); const oldPlay = app.play({id: 101, queueId: 'old-pending', title: '旧请求'});
  await Promise.resolve();
  stored.set('feiniu-karaoke:web:account-b', JSON.stringify({version: 1, queue: [{id: 2, title: '新账号首歌'}], settings: {pitch: 0, scoring: false}}));
  await app.switchCatalogScope({catalogScope: 'account-b'}); app.applyScopeSettings(); app.state.ready = true;
  eq(stoppedTracks, 1); eq(app.player.state.micEnabled, false); eq(app.player.state.monitoring, false); eq(app.player.state.scoreEnabled, false);
  eq(controller.signal.aborted, true); deep(revoked, ['blob:old-account']); eq(app.objectUrls.size, 0); eq(app.lyricFiles.size, 0);
  eq(app.recordedPlays.size, 0); eq(app.settledScores.size, 0); eq(app.state.favorites.length, 0); eq(app.state.history.length, 0);
  eq(app.inspectApp().playingQueueId, ''); eq(app.inspectApp().playingKey, '');
  eq(app.player.audio.pitch, 0); deep(app.player.audio.bands, Array(10).fill(0)); eq(app.player.audio.preamp, 0); eq(app.player.audio.effect, 'original');
  eq(app.inspectApp().settingsState.deviceId, ''); eq(app.inspectApp().settingsState.monitoring, false); eq(media.volume, .8);
  delayedPlayback.resolve({ok: true, status: 200, json: async () => ({mediaKind: 'audio', transport: 'progressive', playUrl: '/stream/101'})});
  await oldPlay; eq(app.player.state.song, null, 'old playback cannot reattach after a scope switch'); eq(app.inspectApp().playingQueueId, '');
  const scopeBefore = app.inspectApp().scopeSerial;
  eq(await app.switchCatalogScope({catalogScope: 'account-b'}), false); eq(app.inspectApp().scopeSerial, scopeBefore);

  await app.enqueue({id: 3, title: '新增歌曲'});
  eq(app.player.state.song.id, 2, 'clicking after refresh starts the restored first item'); eq(media.actualStarts, 1);
  eq(badges[0].textContent, '已点 2'); eq(badges[1].textContent, '已点 2');
  app.player.pause(); await app.enqueue({id: 4, title: '暂停时新增'});
  eq(media.actualStarts, 1, 'a paused loaded song is not interrupted'); eq(media.paused, true);
  await app.advance(); eq(app.state.queue.length, 2); eq(badges[0].textContent, '已点 2');
  await app.clearQueue(); eq(app.state.queue.length, 0); eq(badges[0].textContent, '已点 0'); eq(app.player.state.song, null); eq(app.inspectApp().playingQueueId, '');

  const picker = elements.get('localFiles'), file = {name: 'local.wav', type: 'audio/wav', size: 5, lastModified: 123};
  picker.files = [file]; await picker.trigger('change'); eq(createdUrls, 1);
  const localId = app.state.local[0].id; await app.enqueue(app.state.local[0]); eq(media.src, 'blob:fixture-1');
  picker.files = [file]; await picker.trigger('change'); eq(createdUrls, 1); eq(app.state.local[0].id, localId); eq(revoked.includes('blob:fixture-1'), false);
  picker.files = [{...file, size: 6}]; await picker.trigger('change'); eq(createdUrls, 2); eq(app.state.local.length, 2); eq(app.state.local[1].id !== localId, true); eq(media.src, 'blob:fixture-1');
  const lateLyrics = deferred(); picker.files = [{name: 'local.lrc', text: () => lateLyrics.promise}]; const selecting = picker.trigger('change');
  await app.switchCatalogScope({catalogScope: 'account-c'}); app.applyScopeSettings(); lateLyrics.resolve('[00:01]旧账号晚到歌词'); await selecting;
  eq(app.state.local.length, 0); eq(app.lyricFiles.size, 0); eq(app.objectUrls.size, 0);

  stored.set('feiniu-karaoke:web:account-d', JSON.stringify({version: 1, settings: {pitch: 4, bands: Array(10).fill(2)}}));
  await app.switchCatalogScope({catalogScope: 'account-d'}); app.applyScopeSettings(); app.state.ready = true; app.state.page = 'songs';
  eq(app.player.audio.context, null);
  let prepared = 0; const originalPrepare = app.player.prepareAudio;
  app.player.prepareAudio = async () => {eq(media.paused, false, 'saved DSP initializes after user playback starts'); ++prepared;};
  await app.enqueue({id: 8, title: '恢复调音'}); eq(prepared, 1); eq(app.player.audio.pitch, 4);
  app.player.prepareAudio = originalPrepare;
  app.player.state.tracks = [{name: '音轨一'}, {name: '音轨二'}]; app.player.state.availableAudioTracks = []; app.player.state.selectedTrack = 0; app.player.emit();
  await app.showAudio();
  const trackSelect = created.findLast(value => value.getAttribute('aria-label') === 'MV 音轨'); assert.ok(trackSelect);
  trackSelect.value = '1'; await trackSelect.onchange(); eq(trackSelect.value, '0', 'failed selection rolls back to the actual track');

  app.player.state.score = {score: 80, grade: 'A'}; app.player.emit(); app.settleScore(app.player.snapshot(), '歌曲结束'); app.settleScore(app.player.snapshot(), '歌曲结束');
  eq(app.state.results.length, 1); await app.player.replay(); app.player.state.score = {score: 90, grade: 'S'}; app.player.emit(); app.settleScore(app.player.snapshot(), '歌曲结束');
  eq(app.state.results.length, 2, 'a replay has its own score settlement');
  app.state.full = true; window.innerWidth = 840; window.innerHeight = 400; app.resize(); eq(microphoneButton.textContent, '麦克风');
  await app.advance(); eq(elements.get('singingControls').children.find(value => value.className === 'glass sing-mic').textContent, '麦克风', 'queue exhaustion rebuild preserves the landscape label');
  window.innerWidth = 420; window.innerHeight = 900; app.resize(); eq(microphoneButton.textContent, '话筒');
  app.buildSingingControls(); eq(elements.get('singingControls').children.find(value => value.className === 'glass sing-mic').textContent, '话筒', 'portrait rebuild uses the Android portrait label');

  const thumb = app.node('img'); thumb.src = app.asset('pc_logo');
  eq(thumb.src.includes('/images/thumbs/'), true); eq(thumb.loading, 'lazy'); eq(thumb.decoding, 'async');
  thumb.dispatchEvent({type: 'error'}); eq(thumb.src, app.originalAsset('pc_logo'));
  eq(thumb.handlers.get('error').length, 0, 'thumbnail failure falls back only once');
  eq(app.asset('pc_logo'), app.originalAsset('pc_logo'), 'rerender cannot repeatedly retry a failed thumbnail');
  app.state.full = true; eq(app.asset('pc_home_stage'), app.originalAsset('pc_home_stage'));
  app.state.full = false; eq(app.asset('pc_home_stage').includes('/images/thumbs/'), true);

  const textTree = element => (element.textContent || '') + ' ' + (element.children || []).map(textTree).join(' ');
  const findTree = (element, predicate) => predicate(element) ? element : (element.children || []).map(child => findTree(child, predicate)).find(Boolean);
  const oldFetch = global.fetch, sessionDelay = deferred(), connectionRequests = [];
  app.state.page = 'home'; app.state.ready = true;
  app.state.history = [{id: 700, title: 'PRIVATE SYNTHETIC HISTORY'}];
  app.state.queue = [{id: 700, title: 'PRIVATE SYNTHETIC QUEUE'}];
  app.state.favorites = [{id: 700, title: 'PRIVATE SYNTHETIC FAVORITE'}];
  global.fetch = async address => {connectionRequests.push(String(address)); return sessionDelay.promise;};
  const pendingStart = app.start();
  eq(app.state.ready, false); eq(elements.get('navigation').children.length, 4, 'navigation survives authentication latency');
  eq(textTree(elements.get('page')).includes('PRIVATE SYNTHETIC'), false, 'unverified scope never displays saved history');
  eq(connectionRequests.length, 1);
  sessionDelay.resolve({ok: false, status: 503, json: async () => ({error: '合成测试：会话暂不可用'})});
  await pendingStart;
  eq(app.state.ready, false); eq(app.state.connecting, false); eq(app.state.connectionError.includes('会话暂不可用'), true);
  eq(elements.get('navigation').children.length, 4, 'session failure preserves navigation');
  await app.navigate('queue'); eq(textTree(elements.get('catalogBody')).includes('PRIVATE SYNTHETIC'), false);
  eq(textTree(elements.get('catalogBody')).includes('重新连接'), true, 'unverified queue provides reconnect feedback');

  global.fetch = async address => ({ok: !String(address).includes('/api/web/context'), status: String(address).includes('/api/web/context') ? 403 : 200,
    json: async () => String(address).includes('/api/web/context') ? {error: '合成测试：上下文暂不可用'} : {authed: true}});
  await app.start(); eq(app.state.ready, false); eq(app.state.connectionError.includes('上下文暂不可用'), true);
  await app.navigate('favorites'); eq(textTree(elements.get('catalogBody')).includes('PRIVATE SYNTHETIC'), false);
  eq(textTree(elements.get('catalogBody')).includes('重新连接'), true, 'context failure never falls through to private collections');
  await app.navigate('home');
  const reconnect = findTree(elements.get('page'), element => element.tagName === 'button' && element.textContent === '重新连接');
  assert.ok(reconnect); ++checks;
  global.fetch = async address => ({ok: true, status: 200, json: async () => String(address).includes('/api/web/context') ? {catalogScope: 'verified-retry-scope'} : {authed: true}});
  const startsBeforeRetry = media.actualStarts;
  await reconnect.trigger('click');
  eq(app.state.ready, true); eq(app.state.connectionError, ''); eq(app.state.context.catalogScope, 'verified-retry-scope');
  eq(app.state.history.length, 0); eq(app.state.queue.length, 0); eq(app.state.favorites.length, 0);
  eq(media.actualStarts, startsBeforeRetry, 'reconnecting does not start a song or microphone'); eq(app.player.audio.context, null);
  global.fetch = async address => String(address).includes('/api/tv-auth/session') || String(address).includes('/api/web/context') ?
    {ok: true, status: 200, json: async () => String(address).includes('/api/web/context') ? {catalogScope: 'verified-retry-scope'} : {authed: true}} : oldFetch(address);
  await app.enqueue({id: 810, title: 'SYNTHETIC CONTINUOUS SONG'});
  media.currentTime = 17; app.player.updateTime();
  const continuousSong = app.player.state.song, continuousQueue = JSON.stringify(app.state.queue), continuousHistory = JSON.stringify(app.state.history);
  const continuousStarts = media.actualStarts, savedBeforeReconnect = stored.get(app.inspectApp().storageKey);
  await app.start();
  eq(media.paused, false); eq(media.currentTime, 17); eq(media.actualStarts, continuousStarts);
  eq(app.player.state.song, continuousSong); eq(JSON.stringify(app.state.queue), continuousQueue); eq(JSON.stringify(app.state.history), continuousHistory);
  eq(stored.get(app.inspectApp().storageKey), savedBeforeReconnect, 'successful same-scope reconnect does not overwrite saved records');
  global.fetch = async () => ({ok: false, status: 503, json: async () => ({error: '合成测试：临时连接失败'})});
  await app.start();
  eq(app.state.ready, false); eq(media.paused, false); eq(media.currentTime, 17); eq(media.actualStarts, continuousStarts);
  eq(JSON.stringify(app.state.queue), continuousQueue); eq(JSON.stringify(app.state.history), continuousHistory);
  eq(stored.get(app.inspectApp().storageKey), savedBeforeReconnect, 'failed reconnect preserves current-scope storage');
  global.fetch = async address => String(address).includes('/api/tv-auth/session') || String(address).includes('/api/web/context') ?
    {ok: true, status: 200, json: async () => String(address).includes('/api/web/context') ? {catalogScope: 'verified-retry-scope'} : {authed: true}} : oldFetch(address);
  await app.start();
  eq(app.state.ready, true); eq(media.paused, false); eq(media.currentTime, 17); eq(media.actualStarts, continuousStarts);
  eq(app.player.state.song, continuousSong); eq(JSON.stringify(app.state.queue), continuousQueue); eq(JSON.stringify(app.state.history), continuousHistory);
  global.fetch = async address => String(address).includes('/api/songs?') ? {ok: false, status: 503, json: async () => ({error: '合成测试：曲库暂不可用'})} : oldFetch(address);
  await assert.rejects(app.navigate('songs'), /曲库暂不可用/); ++checks;
  eq(textTree(elements.get('catalogBody')).includes('曲库暂不可用'), true);
  eq(textTree(elements.get('catalogBody')).includes('重新加载'), true, 'catalog failure has an actionable retry');
  eq(elements.get('navigation').children.length, 4); eq(app.state.ready, true);
  global.fetch = async address => String(address).includes('/api/tv-auth/session') || String(address).includes('/api/web/context') ?
    {ok: true, status: 200, json: async () => String(address).includes('/api/web/context') ? {catalogScope: 'verified-retry-scope'} : {authed: true}} :
    {ok: false, status: 503, json: async () => ({error: '合成测试：启动后曲库暂不可用'})};
  await app.start();
  eq(app.state.ready, true, 'a catalog failure after context verification does not revoke local scope');
  eq(media.paused, false); eq(media.currentTime, 17); eq(JSON.stringify(app.state.queue), continuousQueue);
  eq(textTree(elements.get('catalogBody')).includes('启动后曲库暂不可用'), true);
  await app.navigate('queue');
  eq(app.state.ready, true); eq(textTree(elements.get('catalogBody')).includes('SYNTHETIC CONTINUOUS SONG'), true, 'local queue remains usable when the catalog API is offline');
  global.fetch = oldFetch;
  await app.player.destroy();
  process.stdout.write(`web app: ${checks} checks passed\n`);
}
main().catch(error => {console.error(String(error.stack || error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[loaded module]')); process.exitCode = 1;});
