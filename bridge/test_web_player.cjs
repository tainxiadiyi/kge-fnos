'use strict';
// Real mathematical parity and asynchronous media lifecycle checks, no dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const audioURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-audio.js'), 'utf8'));
const hubURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-scorehub.js'), 'utf8'));
const playerURL = dataURL(fs.readFileSync(path.join(__dirname, 'web-player.js'), 'utf8').replace("'./web-audio.js'", JSON.stringify(audioURL)).replace("'./web-scorehub.js'", JSON.stringify(hubURL)));

class Media extends EventTarget {
  constructor() { super(); this.currentTime = 0; this.duration = 10; this.paused = true; this.playbackRate = 1; this.volume = 1; this.src = ''; this.muted = false; this.preservesPitch = true; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  canPlayType() { return ''; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  const { KaraokeAudio, parseLyrics, lyricIndex, lyricHighlight, mono8k, detectPitch, PerformanceScore, voicePreset, VOICE_PARAMETERS } = await import(audioURL);
  const { KaraokePlayer, scopedMediaUrl } = await import(playerURL);
  let checks = 0;
  const lyrics = parseLyrics('\uFEFF[ar:歌手]\n[offset:500]\n[00:01.00][00:04.0] <00:01.00>你<00:02.00>好\n[00:07.000]尾句\n[00:79.00]无效');
  assert.deepEqual(lyrics.cues.map(cue => [cue.time, cue.text]), [[500, '你好'], [3500, '你好'], [6500, '尾句']]);
  assert.equal(lyrics.cues[1].words[1].time, 4500);
  assert.equal(lyricIndex(lyrics.cues, 499), -1); assert.equal(lyricIndex(lyrics.cues, 3500), 1);
  assert.equal(lyricHighlight(lyrics.cues, 0, 1000, 10000), .5); checks += 5;
  assert.equal(parseLyrics('普通歌词\n第二句').plain, '普通歌词\n第二句'); checks++;

  for (const [frequency, midi] of [[110, 45], [220, 57], [440, 69], [659.255, 76]]) {
    const signal = Float32Array.from({ length: 1024 }, (_, i) => .15 * Math.sin(2 * Math.PI * frequency * i / 8000));
    assert.ok(Math.abs(detectPitch(signal) - midi) < .35, `pitch ${frequency}`); checks++;
  }
  let noiseSeed = 13579;
  const noise = Float32Array.from({ length: 1024 }, () => { noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) | 0; return noiseSeed / 2147483648 * .08; });
  assert.equal(detectPitch(new Float32Array(1024)), null); assert.equal(detectPitch(noise), null);
  assert.equal(detectPitch(new Float32Array(128)), null); checks += 3;
  for (const rate of [44100, 48000]) {
    const signal = Float32Array.from({ length: 4096 }, (_, i) => .15 * Math.sin(2 * Math.PI * 440 * i / rate));
    assert.ok(Math.abs(detectPitch(mono8k(signal, rate)) - 69) < .3); checks++;
  }
  function steady(pitch, missing = 0) { const score = new PerformanceScore({ notes: Array(250).fill(69), stepMs: 40 }); for (let i = 0; i < 250; i++) score.observe(i * 40, i < missing ? null : pitch); return score.result(); }
  assert.equal(steady(69).score, 100); assert.equal(steady(81).score, 100);
  assert.equal(steady(null).score, null); assert.ok(steady(70).score < steady(69).score); assert.ok(steady(70).pitch < 60);
  assert.equal(steady(69, 125).coverage, 50); assert.ok(steady(69, 125).score < 80); checks += 7;
  const oneFrame = new PerformanceScore({ notes: Array(250).fill(69), stepMs: 40 }); for (let i = 0; i < 300; i++) oneFrame.observe(40, 69); assert.equal(oneFrame.result().score, null); checks++;
  const repeat = new PerformanceScore({ notes: Array(500).fill(69), stepMs: 40 }); for (let i = 0; i < 100; i++) repeat.observe(i * 40, 69); const frames = repeat.result().frames; for (let i = 0; i < 100; i++) repeat.observe(i * 40, 69);
  assert.equal(repeat.result().frames, frames); assert.equal(repeat.partial, true); checks += 2;
  const sentence = new PerformanceScore({ notes: Array(250).fill(69), stepMs: 40 }); for (let i = 0; i < 250; i++) sentence.observe(i * 40, i < 125 ? 69 : 72);
  assert.ok(sentence.result(0, 5000).score > 95); assert.ok(sentence.result(5000, 10000).score < 50); checks += 2;
  assert.throws(() => new PerformanceScore({ notes: [NaN], stepMs: 40 })); assert.throws(() => new PerformanceScore({ notes: [69], stepMs: -1 })); checks += 2;
  const melody = Array.from({ length: 300 }, (_, i) => i % 100 >= 10 && i % 100 < 80 ? 69 : null);
  function rhythm(delay) { const score = new PerformanceScore({ notes: melody, stepMs: 40 }); for (let i = 0; i < 300; i++) score.observe(i * 40, (i - delay) % 100 >= 10 && (i - delay) % 100 < 80 ? 69 : null); return score.result().rhythm; }
  assert.ok(rhythm(0) > rhythm(6)); checks++;
  assert.equal(VOICE_PARAMETERS.length, 18); assert.deepEqual(voicePreset('cartoon').values.slice(0, 4), [7, 5, 8, 1.2]); assert.equal(voicePreset('electro').values[12], 100); assert.equal(voicePreset('dog').values[17], -3); checks += 4;
  const staged = new KaraokeAudio(new Media()); staged.resetCachedSettings({pitch:5,bands:Array(10).fill(3),effect:'cartoon',micVolume:.6});
  assert.equal(staged.context, null, 'account preference restoration must not start an AudioContext'); assert.equal(staged.pitch, 5); assert.equal(staged.effect, 'cartoon'); checks += 3;
  const cancelledPreference = deferred(); staged.ensure = () => cancelledPreference.promise;
  const oldEffect = staged.setEffect('web-hall'); staged.resetCachedSettings({pitch:0,effect:'original'}); cancelledPreference.resolve(); await assert.rejects(oldEffect, {name:'AbortError'}); checks++;
  assert.equal(staged.pitch, 0); assert.equal(staged.effect, 'original'); assert.equal(staged.bands.every(value=>value===0),true); checks+=3;
  staged.resetCachedSettings({effect:'constructor'}); assert.equal(staged.effect,'original'); checks++;
  const effects = new KaraokeAudio(new Media()); effects.native = true; assert.equal(effects.getEffects().length, 23); checks++;
  for (const effect of effects.getEffects()) { const preset = voicePreset(effect.id); assert.equal(preset.values.length, 18); assert.ok(preset.values.every((value, i) => value >= VOICE_PARAMETERS[i].min && value <= VOICE_PARAMETERS[i].max)); checks += 2; }

  const context = { origin: 'https://nas.example', pathname: '/app/feiniu-karaoke/sing' };
  assert.equal(scopedMediaUrl('/stream/7', context), 'https://nas.example/app/feiniu-karaoke/stream/7');
  assert.equal(scopedMediaUrl('/app/feiniu-karaoke/stream/7', context), 'https://nas.example/app/feiniu-karaoke/stream/7');
  assert.throws(() => scopedMediaUrl('https://other.example/stream/7', context)); assert.throws(() => scopedMediaUrl('https://username:password@nas.example/stream/7', context)); checks += 4;
  global.location = context;
  const requests = [], errors = [], descriptors = new Map();
  const binding = { serverId: 'a'.repeat(32), accountId: 'nas:1000' };
  const scoreHub = () => ({ sessionId: 'f'.repeat(32), start() {}, close() {}, setPlaying() {}, identity: () => ({ ...binding }), usable: () => true, refreshSession: async () => ({ ...binding }),
    fetchReference: async identity => { const url = '/hub/score/' + parseInt(identity.mediaSha256, 16); requests.push({ url }); const pending = deferred(); descriptors.set(url, pending); return pending.promise; }, queueResult: () => true });
  const api = async (url, options) => {
    requests.push({ url, options });
    if (url.startsWith('/api/lyrics/')) return { content: '[00:00.00]第一句\n[00:02.00]第二句' };
    if (url.startsWith('/api/v2/score-identity/')) { if (options.method === 'DELETE') return {}; const id = Number(url.split('/').at(-1)); return { status: 'ready', source: 'original-file-sha256', mediaSha256: id.toString(16).padStart(64, '0'), mediaBytes: 10000, originalAudioTrack: 0 }; }
    const pending = deferred(); descriptors.set(url, pending); return pending.promise;
  };
  let ended = 0; const media = new Media(), states = [], player = new KaraokePlayer({ media, api, scoreHub: scoreHub(), onState: value => states.push(value), onError: error => errors.push(error), onEnded: () => ended++ });
  const first = player.load({ id: 1, title: '旧歌' }); await flush(); const second = player.load({ id: 2, title: '新歌' }); await flush();
  assert.equal(requests.find(request => request.url === '/api/v2/playback/1').options.signal.aborted, true); checks++;
  descriptors.get('/api/v2/playback/2').resolve({ mediaKind: 'mv', transport: 'progressive', playUrl: '/stream/2', audioTracks: [{ index: 0, name: '音轨 1' }, { index: 1, name: '音轨 2' }] }); await second;
  descriptors.get('/api/v2/playback/1').resolve({ mediaKind: 'audio', transport: 'progressive', playUrl: '/stream/1' }); await first;
  assert.equal(media.src, 'https://nas.example/app/feiniu-karaoke/stream/2'); assert.equal(player.state.song.id, 2); assert.equal(player.state.playing, true); checks += 3;
  assert.equal(requests.some(request => request.url.startsWith('/api/score/')), false, 'loading alone cannot start reference generation');
  assert.equal(requests.some(request => /queue|\/ws|control/.test(request.url)), false, 'local player cannot control server shared playback'); checks += 2;
  assert.equal(player.state.capabilities.original, false, 'unlabelled embedded tracks are never guessed'); await assert.rejects(player.setOriginal(false)); checks += 2;
  media.currentTime = 3; media.dispatchEvent(new Event('timeupdate')); assert.equal(player.state.currentLyric, 1); checks++;
  player.state.musicLatencyMs = 1500; player.updateTime(); assert.equal(player.state.currentLyric, 0); player.state.musicLatencyMs = 0; player.updateTime(); checks++;
  player.seek(99); assert.equal(media.currentTime, 10); player.setVolume(2); assert.equal(media.volume, 1); player.setRate(1.3); assert.equal(media.playbackRate, 1.3); assert.equal(media.preservesPitch, true); checks += 4;
  player.pause(); assert.equal(player.state.playing, false); await player.resume(); assert.equal(player.state.playing, true); checks += 2;
  player.state.micEnabled = true; player.setScoring(true); await flush();
  assert.equal(requests.filter(request => request.url === '/hub/score/2').length, 1); checks++;
  const third = player.load({ id: 3, title: '下一首' }); await flush();
  descriptors.get('/hub/score/2').resolve({ status: 'ready', notes: Array(250).fill(69), stepMs: 40, hubBinding: binding }); await flush();
  assert.equal(player.reference, null, 'stale score response cannot attach to a new song'); checks++;
  descriptors.get('/api/v2/playback/3').resolve({ mediaKind: 'audio', transport: 'progressive', playUrl: '/stream/3' }); await third; await flush();
  descriptors.get('/hub/score/3').resolve({ status: 'ready', notes: Array(250).fill(69), stepMs: 40, hubBinding: binding }); await flush();
  assert.equal(player.state.scoreStatus, 'ready'); assert.equal(player.state.capabilities.original, false, 'remote spectrum does not manufacture an accompaniment source'); assert.equal(player.state.score, null, 'reference availability cannot invent a singing score'); checks += 3;
  assert.equal(player.state.melody.stepMs, 40); assert.equal(player.state.melody.notes.length, 250); checks += 2;
  for (let i = 0; i < 80; i++) { media.currentTime = i * .04; player.observeMic({ pitch: 69, level: .5, delayMs: 0 }); }
  assert.equal(player.state.score.score, 100); assert.equal(player.actualPitchAt(40), 69); assert.equal(player.state.currentLineScore.score, 100); checks += 3;
  assert.equal(player.state.takeCounter, 0); await player.replay(); assert.equal(player.state.takeCounter, 1); assert.equal(player.state.score, null); assert.equal(player.actualPitchAt(40), null); assert.equal(player.state.currentLineScore, null); checks += 5;
  media.dispatchEvent(new Event('ended')); assert.equal(ended, 1); checks++;
  media.dispatchEvent(new Event('ended')); assert.equal(ended, 1, 'duplicate ended cannot advance a local queue twice'); checks++;
  player.seek(0); media.ended = false; media.dispatchEvent(new Event('ended')); assert.equal(ended, 1, 'old source ended arriving after a new seek cannot skip the next song'); checks++;
  media.ended = true; media.dispatchEvent(new Event('ended')); assert.equal(ended, 2); checks++;
  await player.destroy(); assert.equal(media.src, ''); assert.equal(player.destroyed, true); checks += 2;
  assert.equal(errors.length, 0); checks++;

  class Hls {
    static Events = { ERROR: 'error', AUDIO_TRACKS_UPDATED: 'tracks' };
    static isSupported() { return true; }
    constructor(options) { this.options = options; this.audioTracks = [{ name: 'a' }, { name: 'b' }]; this.handlers = new Map(); Hls.instances.push(this); }
    on(name, callback) { this.handlers.set(name, callback); }
    attachMedia(media) { this.media = media; }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyed = true; }
  }
  Hls.instances = []; global.Hls = Hls;
  const hlsMedia = new Media(); hlsMedia.canPlayType = () => 'maybe';
  const hlsPlayer = new KaraokePlayer({ media: hlsMedia, scoreHub: scoreHub(), api: async url => url.startsWith('/api/lyrics/') ? {} : ({ mediaKind: 'mv', transport: 'hls', playUrl: '/mv/4/master.m3u8', audioTracks: [{ index: 0 }, { index: 1 }] }) });
  await hlsPlayer.load({ id: 4 }); const hls = Hls.instances.at(-1);
  assert.equal(hls.url, 'https://nas.example/app/feiniu-karaoke/mv/4/master.m3u8'); checks++;
  const xhr = {}; hls.options.xhrSetup(xhr, 'index_audio0.m3u8'); assert.equal(xhr.withCredentials, true); assert.throws(() => hls.options.xhrSetup({}, 'https://external.example/media.ts')); checks += 2;
  await hlsPlayer.setAudioTrack(1); assert.equal(hls.audioTrack, 1); assert.equal(hlsPlayer.state.capabilities.original, false); checks += 2;
  await hlsPlayer.destroy(); assert.equal(hls.destroyed, true); checks++; delete global.Hls;

  const localRequests = [], localPlayer = new KaraokePlayer({ media: new Media(), scoreHub: scoreHub(), api: async url => localRequests.push(url) });
  await localPlayer.load({ objectUrl: 'blob:local-music', mimeType: 'audio/wav', lyricsContent: '[00:01.00]本机歌词' }); assert.equal(localPlayer.state.lyrics[0].text, '本机歌词'); assert.equal(localRequests.length, 0); checks += 2;
  localPlayer.state.micEnabled = true; localPlayer.setScoring(true); await flush(); assert.equal(localPlayer.state.scoreStatus, 'unavailable'); assert.equal(localRequests.length, 0); checks += 2; await localPlayer.destroy();

  class AudioNode {
    constructor() { this.connections = []; this.gain = this.frequency = this.Q = this.threshold = this.ratio = this.attack = this.release = { value: 0, setTargetAtTime(value) { this.value = value; } }; this.fftSize = 4096; }
    connect(target) { this.connections.push(target); } disconnect() { this.connections = []; }
    getFloatTimeDomainData(target) { for (let i = 0; i < target.length; i++) target[i] = .1 * Math.sin(2 * Math.PI * 440 * i / 48000); }
  }
  class AudioContext {
    constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = new AudioNode(); }
    createGain() { return new AudioNode(); } createBiquadFilter() { return new AudioNode(); } createMediaElementSource() { return new AudioNode(); }
    createMediaStreamSource() { return new AudioNode(); } createAnalyser() { return new AudioNode(); } createDynamicsCompressor() { return new AudioNode(); }
    async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
  }
  class Track extends EventTarget { stop() { this.stopped = true; } }
  const track = new Track(), stream = { getTracks: () => [track], getAudioTracks: () => [track] }, micFrames = [];
  global.AudioContext = AudioContext; global.isSecureContext = true;
  const permission = deferred(); Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => permission.promise } } });
  const microphone = new KaraokeAudio(new Media(), { onFrame: frame => micFrames.push(frame) });
  const enabling = microphone.setMicrophone(true); await flush(); await microphone.setMicrophone(false); permission.resolve(stream); await enabling;
  assert.equal(track.stopped, true, 'microphone permission completing after disable must stop every track'); assert.equal(microphone.stream, null); checks += 2;
  const track2 = new Track(), stream2 = { getTracks: () => [track2], getAudioTracks: () => [track2] }; navigator.mediaDevices.getUserMedia = async () => stream2;
  const result = await microphone.setMicrophone(true); assert.deepEqual(result, { enabled: true, monitoring: false }); checks++;
  await new Promise(resolve => setTimeout(resolve, 55)); assert.ok(micFrames.length && Math.abs(micFrames[0].pitch - 69) < .3); assert.equal(microphone.monitor, false); checks += 2;
  await assert.rejects(microphone.setEffect('cartoon'), /尚未/); checks++;
  await microphone.destroy(); assert.equal(track2.stopped, true); assert.equal(microphone.context.state, 'closed'); checks += 2;
  const capabilities = [], nativeErrors = [], recovery = new KaraokeAudio(new Media(), { onCapabilities: value => capabilities.push(value), onError: value => nativeErrors.push(value) });
  await recovery.ensure(); const nativeMusic = new AudioNode(), nativeVoice = new AudioNode(), disposed = [];
  for (const [index, node] of [nativeMusic, nativeVoice].entries()) node.port = { onmessage: null, postMessage: value => disposed.push([index, value.type]) };
  recovery.nativeMusic = nativeMusic; recovery.nativeVoice = nativeVoice; recovery.native = true; recovery.pitch = 12; recovery.effect = 'cartoon'; recovery.reconnectMusic();
  recovery.disableNative(new Error('fixture processor failed'));
  assert.equal(recovery.source.connections[0], recovery.filters[0], 'failed native processing must reconnect live music to browser EQ'); assert.equal(recovery.musicGain.connections[0], recovery.context.destination); checks += 2;
  assert.equal(recovery.native, false); assert.equal(recovery.pitch, 0); assert.equal(recovery.effect, 'original'); assert.deepEqual(disposed, [[0, 'dispose'], [1, 'dispose']]); checks += 4;
  assert.equal(capabilities.at(-1).pitch, false); assert.equal(nativeErrors.length, 1); await recovery.destroy(); checks += 2;
  let captured = 0;
  class DeniedAudioContext extends AudioContext { constructor() { super(); this.state = 'suspended'; } async resume() { throw Error('audio permission fixture'); } createMediaElementSource() { captured++; return super.createMediaElementSource(); } }
  global.AudioContext = DeniedAudioContext;
  const denied = new KaraokeAudio(new Media()); await assert.rejects(denied.ensure(), /permission/); assert.equal(captured, 0, 'failed resume cannot capture and silence an independently playing media element'); assert.equal(denied.source, undefined); await denied.destroy(); checks += 3;
  global.isSecureContext = false; const insecure = new KaraokeAudio(new Media()); await assert.rejects(insecure.setMicrophone(true), /HTTPS/); checks++;
  delete global.AudioContext; delete global.isSecureContext; delete global.navigator;
  process.stdout.write(`web player: ${checks} checks passed\n`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
