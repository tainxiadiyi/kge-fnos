import { KaraokeAudio, PerformanceScore, VOICE_PARAMETERS, clamp, parseLyrics, lyricIndex, lyricHighlight } from './web-audio.js';
import { BrowserScoreHub, referenceIdentity } from './web-scorehub.js';

/** Descriptors must point to this NAS; authentication is never sent to providers. */
export function scopedMediaUrl(value, context = globalThis.location) {
  if (typeof value !== 'string' || !value || !context?.origin) throw new Error('播放地址无效');
  const origin = context.origin, pathname = context.pathname || '/';
  const prefix = pathname.match(/^(.*)\/(?:player-assets|sing|m|sources)(?:\/|$)/)?.[1] || (pathname.startsWith('/app/') ? pathname.replace(/\/$/, '') : '');
  const url = new URL(value, origin + '/');
  if (url.origin !== origin || url.username || url.password || !/^https?:$/.test(url.protocol)) throw new Error('播放地址必须由当前 NAS 提供');
  if (prefix && !url.pathname.startsWith(prefix + '/') && url.pathname !== prefix) url.pathname = prefix + url.pathname;
  return url.href;
}

const noop = () => {};
let hlsLibrary = null;
export async function loadHlsLibrary() {
  if (globalThis.Hls) return globalThis.Hls;
  if (!globalThis.document?.createElement) throw new Error('当前环境无法加载 HLS 播放器');
  if (!hlsLibrary) hlsLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = new URL('./vendor/hls.min.js', import.meta.url).href; script.async = true;
    const timeout = setTimeout(() => { script.remove(); hlsLibrary = null; reject(new Error('本机 HLS 播放器加载超时')); }, 15000);
    script.onload = () => { clearTimeout(timeout); if (globalThis.Hls) resolve(globalThis.Hls); else { hlsLibrary = null; reject(new Error('本机 HLS 播放器未能初始化')); } };
    script.onerror = () => { clearTimeout(timeout); script.remove(); hlsLibrary = null; reject(new Error('本机 HLS 播放器加载失败，请检查 NAS 连接')); };
    document.head.append(script);
  });
  return hlsLibrary;
}
export class KaraokePlayer {
  constructor({ media, api, scoreHub = null, onState = noop, onEnded = noop, onError = noop }) {
    if (!media || typeof api !== 'function') throw new Error('播放器需要媒体元素和 NAS 接口');
    this.media = media; this.api = api; this.onState = onState; this.onEnded = onEnded; this.onError = onError;
    this.generation = 0; this.endedGeneration = -1; this.destroyed = false; this.hls = null; this.descriptor = null; this.scoreEnabled = false; this.scoreModel = null; this.reference = null; this.scoreGeneration = 0; this.listeners = [];
    this.state = { song: null, takeCounter: 0, playing: false, loading: false, position: 0, duration: 0, original: true, volume: 1, rate: 1, lyrics: [], plainLyrics: '', currentLyric: -1, lyricHighlight: 0, lyricsOffset: 0, pitch: 0, detectedPitch: null, score: null, melody: null, currentLineScore: null, scoreStatus: 'disabled', scoreEnabled: false, scoreMessage: '', micEnabled: false, micLevel: 0, monitoring: false, tracks: [], selectedTrack: 0, effect: 'original', voiceParameters: VOICE_PARAMETERS.map(value => value.initial), eq: { bass: 0, mid: 0, treble: 0 }, eqBands: Array(10).fill(0), capabilities: { microphone: Boolean(globalThis.navigator?.mediaDevices?.getUserMedia), secureContext: globalThis.isSecureContext !== false, equalizer: Boolean(globalThis.AudioContext || globalThis.webkitAudioContext), voiceEffects: Boolean(globalThis.AudioContext || globalThis.webkitAudioContext), nativeDsp: false, pitch: false, original: false, scoring: false } };
    this.scoreHub = scoreHub || new BrowserScoreHub({ autoStart: false });
    this.scoreHub.onScopeChange = binding => this.hubChanged(binding);
    this.scoreHub.onState = value => { this.state.scoreHub = value; this.emit(); };
    this.audio = new KaraokeAudio(media, {
      onFrame: frame => this.observeMic(frame),
      onReady: () => { if (this.accompaniment) this.audio.connectExtra(this.accompaniment); },
      onCapabilities: capabilities => { this.state.capabilities = { ...this.state.capabilities, ...capabilities }; this.state.pitch = this.audio.pitch; this.state.effect = this.audio.effect; this.state.voiceParameters = [...this.audio.voice.values]; this.emit(); },
      onLatency: ({ role, latencyMs }) => { this.state[role === 'music' ? 'musicLatencyMs' : 'voiceLatencyMs'] = latencyMs; this.updateTime(); },
      onError: error => this.fail(error),
      onMicEnded: () => { this.state.micEnabled = false; this.state.monitoring = false; this.state.micLevel = 0; this.state.detectedPitch = null; this.interruptTake(); this.stopScorePoll(); this.cancelScoreIdentity(); this.emit(); }
    });
    media.playsInline = true; media.preload = 'metadata';
    const listen = (target, name, handler) => { target.addEventListener(name, handler); this.listeners.push(() => target.removeEventListener(name, handler)); };
    listen(media, 'timeupdate', () => this.updateTime());
    listen(media, 'durationchange', () => this.updateTime());
    listen(media, 'loadedmetadata', () => { this.state.loading = false; this.updateTime(); });
    listen(media, 'playing', () => { this.state.playing = true; this.state.loading = false; this.beginTake(); this.scoreHub.setPlaying(true); this.syncAccompaniment(true); this.emit(); });
    listen(media, 'pause', () => { this.state.playing = false; this.scoreHub.setPlaying(false); this.accompaniment?.pause(); this.scoreModel?.breakContinuity(); this.emit(); });
    listen(media, 'waiting', () => { if (this.state.song) { this.state.loading = true; this.emit(); } });
    listen(media, 'seeked', () => { if (!this.restartSeek) this.interruptTake(); this.restartSeek = false; this.syncAccompaniment(this.state.playing); this.updateTime(); });
    listen(media, 'ratechange', () => { this.state.rate = media.playbackRate; if (this.accompaniment) this.accompaniment.playbackRate = media.playbackRate; this.emit(); });
    listen(media, 'ended', () => { if (!this.state.song || media.ended === false || this.endedGeneration === this.generation) return; this.endedGeneration = this.generation; this.state.playing = false; this.scoreHub.setPlaying(false); this.accompaniment?.pause(); this.state.score = this.scoreModel?.result() || null; this.finishTake(); this.updateTime(); this.onEnded(this.snapshot()); });
    listen(media, 'error', () => { if (!media.error || !this.state.song || this.destroyed) return; if (!this.fallbackAttempted && this.descriptor?.fallbackUrl) { this.tryFallback(); return; } this.pause(); this.interruptTake(); this.state.loading = false; this.fail(new Error(media.error.code === 4 ? '当前浏览器无法播放这首歌，请尝试兼容播放或其他浏览器' : '媒体播放失败，请检查 NAS 连接和歌曲文件')); });
    if (globalThis.document) listen(document, 'visibilitychange', () => { if (document.hidden) { this.audio.stopMicrophone(); this.state.micEnabled = false; this.state.monitoring = false; this.state.micLevel = 0; this.state.detectedPitch = null; this.interruptTake(); this.stopScorePoll(); this.cancelScoreIdentity(); this.emit(); } else this.scoreHub.refreshSession(); });
    if (globalThis.window) listen(window, 'pagehide', () => this.destroy());
    this.emit(); this.scoreHub.start();
  }
  newTake() { this.take = { id: this.scoreHub.sessionId ? this.scoreHub.sessionId + '_' + this.generation + '_' + this.state.takeCounter : null, started: false, binding: null, partial: false, frameDelayMs: 0 }; }
  beginTake() { if (!this.take || this.take.started) return; this.take.started = true; this.take.binding = this.scoreHub.identity(); this.take.partial = !this.scoreEnabled || !this.state.micEnabled || this.media.currentTime > .2; }
  interruptTake() { if (this.take?.started) this.take.partial = true; this.scoreModel?.breakContinuity(true); }
  hubChanged() {
    if (this.destroyed) return;
    this.interruptTake(); this.stopScorePoll(); this.cancelScoreIdentity(); this.reference = null; this.scoreModel = null;
    Object.assign(this.state, { score: null, melody: null, currentLineScore: null, referencePitch: null, pitchCents: null });
    if (this.scoreEnabled && this.state.song) this.prepareScore(); else this.emit();
  }
  finishTake() {
    const result = this.state.score, model = this.scoreModel, reference = this.reference, take = this.take;
    // Allow only the small measured DSP/window delay at the final frame. A
    // reference fetched several seconds into a song is never a complete take.
    const tailTolerance = Math.max(200, Math.min(1000, (this.state.musicLatencyMs || 0) + (take?.frameDelayMs || 0) + (model?.stepMs || 40) * 3));
    const timelineComplete = model && reference && model.firstPosition >= 0 && model.firstPosition <= 200
      && model.lastPosition >= reference.durationMs - tailTolerance
      && Math.abs(this.state.duration * 1000 - reference.durationMs) <= Math.max(250, reference.durationMs * .03);
    if (result && (take?.partial || !timelineComplete)) result.partial = true;
    if (!take?.started || !take.id || !take.binding || !this.scoreHub.usable(take.binding) || !reference || !model
        || !this.scoreEnabled || !this.state.micEnabled || result?.partial || !Number.isInteger(result?.score)
        || result.frames < 25 || !timelineComplete) return;
    this.state.scoreSyncStatus = this.scoreHub.queueResult({ id: take.id, mediaSha256: reference.mediaSha256,
      requestedTrack: reference.requestedTrack, title: String(this.state.song?.title || ''), score: result.score }, take.binding) ? 'queued' : 'unsaved';
  }
  snapshot() { return { ...this.state, capabilities: { ...this.state.capabilities }, eq: { ...this.state.eq }, eqBands: [...this.state.eqBands], tracks: [...this.state.tracks], voiceParameters: [...this.state.voiceParameters] }; }
  emit() { if (!this.destroyed) this.onState(this.snapshot()); }
  fail(error) { if (!this.destroyed && error?.name !== 'AbortError') { this.state.error = error.message || String(error); this.emit(); this.onError(this.state.error, error); } }
  localUrl(value) { return scopedMediaUrl(value); }
  stopScorePoll() { ++this.scoreGeneration; clearTimeout(this.scoreTimer); this.scoreTimer = null; this.scoreAbort?.abort(); this.scoreAbort = null; }
  cancelScoreIdentity() {
    const id = this.scoreIdentitySongId; this.scoreIdentitySongId = null; if (id == null) return;
    this.identityCancellation = Promise.resolve(this.identityCancellation).catch(noop).then(() => this.api('/api/v2/score-identity/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'X-Karaoke-Request': '1' } })).catch(noop);
  }
  clearMedia() {
    this.audio.resetMusic();
    this.hls?.destroy(); this.hls = null; this.media.pause(); this.media.removeAttribute('src'); this.media.load();
    this.accompaniment?.pause(); this.accompaniment?.removeAttribute('src'); this.accompaniment?.load(); this.media.muted = false;
  }
  async load(song) {
    this.cancelScoreIdentity(); const generation = ++this.generation; this.loadAbort?.abort(); this.loadAbort = new AbortController(); this.stopScorePoll(); this.clearMedia();
    this.descriptor = null; this.scoreModel = null; this.reference = null; this.fallbackAttempted = false;
    Object.assign(this.state, { song, takeCounter: 0, playing: false, loading: true, position: 0, duration: 0, original: true, lyrics: [], plainLyrics: '', currentLyric: -1, lyricHighlight: 0, detectedPitch: null, score: null, melody: null, currentLineScore: null, scoreStatus: this.scoreEnabled ? 'waiting' : 'disabled', scoreMessage: '', error: '', tracks: [], availableAudioTracks: [], selectedTrack: 0 });
    this.state.scoreSyncStatus = ''; this.restartSeek = false; this.newTake();
    this.state.capabilities.original = false; this.state.capabilities.audioTrackSelection = false; this.state.capabilities.scoring = !song?.objectUrl && song?.id != null; this.emit();
    if (!song || (!song.objectUrl && song.id == null)) { this.state.loading = false; this.emit(); return; }
    const signal = this.loadAbort.signal;
    if (song.lyricsContent) { const lyrics = parseLyrics(song.lyricsContent); this.state.lyrics = lyrics.cues; this.state.plainLyrics = lyrics.plain; this.updateTime(); }
    // Lyrics are independent of media preparation and never block starting MV.
    if (!song.objectUrl) this.api('/api/lyrics/' + encodeURIComponent(song.id), { signal }).then(data => {
      if (generation !== this.generation || this.destroyed) return;
      const lyrics = parseLyrics(data?.content || '', Number(data?.offset) || 0); this.state.lyrics = lyrics.cues; this.state.plainLyrics = lyrics.plain; this.updateTime();
    }).catch(error => { if (generation === this.generation && error.name !== 'AbortError') { this.state.lyricsMessage = '歌词暂时无法加载'; this.emit(); } });
    try {
      const descriptor = song.objectUrl ? { playUrl: song.objectUrl, transport: 'progressive', mediaKind: song.media_kind || (/^video\//.test(song.mimeType || '') ? 'mv' : 'audio'), audioTracks: [] } : await this.api('/api/v2/playback/' + encodeURIComponent(song.id), { signal });
      if (generation !== this.generation || this.destroyed) return;
      this.descriptor = descriptor;
      this.state.mediaKind = descriptor.mediaKind || song.media_kind || 'audio'; this.state.duration = Number(descriptor.durationMs || 0) / 1000;
      this.state.tracks = Array.isArray(descriptor.audioTracks) ? descriptor.audioTracks : [];
      this.state.capabilities.original = Boolean(descriptor.accompanimentUrl || this.originalTrack(false) && this.originalTrack(true)); this.emit();
      await this.attachSource(descriptor, generation, Boolean(song.objectUrl));
      if (generation !== this.generation || this.destroyed) return;
      if (this.scoreEnabled) this.prepareScore();
      await this.resume();
    } catch (error) { if (generation === this.generation) { this.state.loading = false; this.fail(error); } }
  }
  async attachSource(descriptor, generation, local = false, startPosition = 0) {
    const url = local ? descriptor.playUrl : this.localUrl(descriptor.playUrl);
    if (local && !/^blob:/.test(url)) throw new Error('本地歌曲地址无效');
    this.hls?.destroy(); this.hls = null;
    const hls = descriptor.transport === 'hls' || /\.m3u8(?:\?|$)/i.test(url), nativeHls = Boolean(this.media.canPlayType('application/vnd.apple.mpegurl'));
    const multipleTracks = (descriptor.audioTracks?.length || this.state.tracks.length || this.state.availableAudioTracks?.length || 0) > 1;
    // Some Chromium browsers claim native HLS but expose no audioTracks API.
    // Prefer MSE for multitrack karaoke so selection actually changes playback.
    let Hls = null;
    if (hls && (!nativeHls || multipleTracks)) { Hls = await loadHlsLibrary(); if (generation !== this.generation || this.destroyed) return; if (!Hls?.isSupported()) { if (nativeHls) Hls = null; else throw new Error('当前浏览器无法播放 HLS 媒体'); } }
    if (hls && Hls) {
      const instance = new Hls({ enableWorker: true, backBufferLength: 30, xhrSetup: (xhr, requestUrl) => { const request = new URL(requestUrl, url); if (request.origin !== new URL(url).origin) throw new Error('媒体请求必须由当前 NAS 提供'); xhr.withCredentials = true; } }); this.hls = instance;
      instance.on(Hls.Events.ERROR, (_, data) => { if (generation === this.generation && this.hls === instance && data.fatal) { this.pause(); this.interruptTake(); this.state.loading = false; this.fail(new Error('媒体加载失败：' + (data.details || 'HLS错误'))); } });
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, data) => { if (generation === this.generation && this.hls === instance) { this.state.availableAudioTracks = data.audioTracks.map((track, index) => ({ index, renditionIndex: index, name: track.name || '音轨 ' + (index + 1), lang: track.lang || '' })); if (!this.state.tracks.length) this.state.tracks = [...this.state.availableAudioTracks]; this.state.capabilities.audioTrackSelection = data.audioTracks.length > 1; this.emit(); } });
      instance.attachMedia(this.media); instance.loadSource(url);
    } else this.media.src = url;
    if (startPosition > 0) {
      const seek = () => { this.media.removeEventListener('loadedmetadata', seek); if (generation === this.generation && !this.destroyed) this.media.currentTime = startPosition; };
      this.media.addEventListener('loadedmetadata', seek, { once: true });
    }
    this.media.volume = this.state.volume; this.media.playbackRate = this.state.rate;
    if ('preservesPitch' in this.media) this.media.preservesPitch = true;
  }
  async tryFallback() {
    if (this.fallbackAttempted || !this.descriptor?.fallbackUrl) return;
    const generation = this.generation, position = this.media.currentTime; this.fallbackAttempted = true; this.state.loading = true; this.state.playMessage = '正在切换兼容播放'; this.emit();
    try { await this.attachSource({ ...this.descriptor, playUrl: this.descriptor.fallbackUrl, transport: 'hls' }, generation, false, position); if (generation === this.generation) await this.resume(); }
    catch (error) { if (generation === this.generation) { this.pause(); this.interruptTake(); this.state.loading = false; this.fail(error); } }
  }
  updateTime(emit = true) {
    if (!this.state.song || this.destroyed) return;
    this.state.position = Number(this.media.currentTime) || 0;
    if (Number.isFinite(this.media.duration) && this.media.duration > 0) this.state.duration = this.media.duration;
    const lyricPosition = this.state.position * 1000 - (this.state.musicLatencyMs || 0) + this.state.lyricsOffset;
    this.state.currentLyric = lyricIndex(this.state.lyrics, lyricPosition);
    this.state.lyricHighlight = lyricHighlight(this.state.lyrics, this.state.currentLyric, lyricPosition, this.state.duration * 1000 - (this.state.musicLatencyMs || 0) + this.state.lyricsOffset);
    this.updateLineScore();
    if (this.accompaniment && !this.state.original && Math.abs(this.accompaniment.currentTime - this.media.currentTime) > .2) this.accompaniment.currentTime = this.media.currentTime;
    if (emit) this.emit();
  }
  updateLineScore() {
    const cue = this.state.lyrics[this.state.currentLyric];
    if (!cue || !this.scoreModel || !this.scoreEnabled) { this.state.currentLineScore = null; return; }
    const from = Math.max(0, cue.time - this.state.lyricsOffset), to = this.state.lyrics[this.state.currentLyric + 1]?.time - this.state.lyricsOffset || this.state.duration * 1000;
    this.state.currentLineScore = { ...this.scoreModel.result(from, Math.min(to, this.state.duration * 1000)), index: this.state.currentLyric, text: cue.text, from, to };
  }
  actualPitchAt(positionMs) { return this.scoreModel?.actualAt(positionMs) ?? null; }
  pause() { this.media.pause(); this.state.playing = false; this.accompaniment?.pause(); this.emit(); }
  async resume() {
    if (this.destroyed || !this.state.song || !this.descriptor) return;
    const generation = this.generation;
    if (this.media.ended) this.endedGeneration = -1;
    try { if (this.audio.context && !['running', 'closed'].includes(this.audio.context.state)) await this.audio.context.resume(); await this.media.play(); if (generation !== this.generation) return; this.state.playing = !this.media.paused; this.state.error = ''; this.syncAccompaniment(this.state.playing); this.emit(); }
    catch (error) { if (generation !== this.generation) return; if (error.name === 'NotAllowedError') { this.state.playing = false; this.state.loading = false; this.state.playMessage = '点击播放开始演唱'; this.emit(); } else if (error.name !== 'AbortError') this.fail(error); }
  }
  toggle() { return this.state.playing ? this.pause() : this.resume(); }
  seek(seconds, { restart = false } = {}) { if (!this.state.song || !Number.isFinite(Number(seconds))) return; this.restartSeek = restart; if (!restart) this.interruptTake(); this.audio.resetMusic(); const position = clamp(seconds, 0, this.state.duration || Math.max(0, Number(seconds))); if (position < this.state.duration) this.endedGeneration = -1; this.media.currentTime = position; this.syncAccompaniment(this.state.playing); this.updateTime(); }
  replay() { if (!this.state.song) return; ++this.state.takeCounter; this.scoreModel = null; this.state.score = null; this.state.currentLineScore = null; this.seek(0, { restart: true }); this.newTake(); if (this.reference && this.scoreHub.usable(this.reference.hubBinding)) this.scoreModel = new PerformanceScore(this.reference); this.beginTake(); return this.resume(); }
  setVolume(value) { this.state.volume = clamp(value, 0, 1); this.media.volume = this.state.volume; if (this.accompaniment) this.accompaniment.volume = this.state.volume; this.emit(); }
  setRate(value) { this.state.rate = clamp(value, .5, 2); this.media.playbackRate = this.state.rate; if ('preservesPitch' in this.media) this.media.preservesPitch = true; if (this.accompaniment) { this.accompaniment.playbackRate = this.state.rate; this.accompaniment.preservesPitch = true; } this.emit(); }
  originalTrack(original) { return this.state.tracks.find(track => (track.role === (original ? 'original' : 'accompaniment')) || (track.kind === (original ? 'original' : 'accompaniment')) || (typeof track.original === 'boolean' && track.original === original)); }
  async setAudioTrack(index) {
    const track = this.state.tracks[index]; if (!track) throw new Error('音轨不存在');
    this.audio.resetMusic();
    if (track.playUrl) { const generation = this.generation, position = this.media.currentTime, playing = this.state.playing; this.media.pause(); await this.attachSource({ ...this.descriptor, playUrl: track.playUrl, transport: track.transport || this.descriptor.transport }, generation, false, position); if (playing) await this.resume(); }
    else if (this.hls) { const rendition = track.renditionIndex ?? index; if (!this.hls.audioTracks[rendition]) throw new Error('当前媒体没有这条音轨'); this.hls.audioTrack = rendition; }
    else if (this.media.audioTracks?.length > index) { for (let i = 0; i < this.media.audioTracks.length; i++) this.media.audioTracks[i].enabled = i === index; }
    else if (this.state.tracks.length > 1) throw new Error('当前浏览器未开放内嵌音轨选择，请使用 HLS 兼容播放');
    this.state.selectedTrack = index; this.state.original = track.role ? track.role === 'original' : this.state.original; this.emit();
  }
  async setOriginal(original) {
    original = Boolean(original); if (original === this.state.original) return;
    const track = this.originalTrack(original);
    if (track) { await this.setAudioTrack(this.state.tracks.indexOf(track)); this.state.original = original; this.media.muted = false; this.accompaniment?.pause(); }
    else if (!original && this.descriptor?.accompanimentUrl) {
      if (!this.accompaniment) { this.accompaniment = new Audio(); this.accompaniment.preload = 'auto'; }
      this.accompaniment.src = this.localUrl(this.descriptor.accompanimentUrl); this.accompaniment.volume = this.state.volume; this.accompaniment.playbackRate = this.state.rate;
      this.accompaniment.onloadedmetadata = () => { if (!this.state.original) this.syncAccompaniment(this.state.playing); };
      this.accompaniment.onerror = () => { this.media.muted = false; this.state.original = true; this.fail(new Error('伴奏加载失败，已恢复原音轨')); };
      this.audio.connectExtra(this.accompaniment); this.state.original = false; this.media.muted = true; this.syncAccompaniment(this.state.playing);
    } else if (original && this.accompaniment) { this.state.original = true; this.accompaniment.pause(); this.media.muted = false; }
    else throw new Error('这首歌没有明确标记的原唱 / 伴奏音轨；可在音轨列表中手动选择');
    this.emit();
  }
  syncAccompaniment(playing) {
    if (!this.accompaniment || this.state.original) return;
    if (Number.isFinite(this.accompaniment.duration)) this.accompaniment.currentTime = clamp(this.media.currentTime, 0, this.accompaniment.duration);
    this.accompaniment.playbackRate = this.state.rate;
    if (playing) this.accompaniment.play().catch(error => { if (error.name !== 'AbortError') this.fail(new Error('伴奏未能开始播放，请点击播放重试')); }); else this.accompaniment.pause();
  }
  async setPitch(value) { try { await this.audio.setPitch(value); this.state.pitch = this.audio.pitch; this.emit(); } catch (error) { this.fail(error); throw error; } }
  async setEq(settings) { await this.audio.setEq(settings); this.state.eq = { ...this.audio.eq }; this.state.eqBands = [...this.audio.bands]; if (this.accompaniment) this.audio.connectExtra(this.accompaniment); this.emit(); }
  async prepareAudio() { const context = await this.audio.ensure({ retryNative: true }); if (this.accompaniment) this.audio.connectExtra(this.accompaniment); return context; }
  setEqBands(bands, preamp = 0) { return this.setEq({ bands, preamp }); }
  resetCachedAudioSettings(settings = {}) { this.audio.resetCachedSettings(settings); this.state.pitch = this.audio.pitch; this.state.eq = { ...this.audio.eq }; this.state.eqBands = [...this.audio.bands]; this.state.effect = this.audio.effect; this.state.voiceParameters = [...this.audio.voice.values]; this.state.micVolume = this.audio.micVolume; this.emit(); }
  async setMicrophone(enabled, options = {}) {
    try { const result = await this.audio.setMicrophone(Boolean(enabled), options); this.state.micEnabled = result.enabled; this.state.monitoring = result.monitoring; if (!result.enabled) { this.state.micLevel = 0; this.state.detectedPitch = null; this.stopScorePoll(); this.interruptTake(); this.cancelScoreIdentity(); } else if (this.scoreEnabled) this.prepareScore(); this.emit(); return result; }
    catch (error) { this.state.micEnabled = false; this.state.monitoring = false; this.fail(error); throw error; }
  }
  setMicVolume(value) { this.audio.setMicVolume(value); this.state.micVolume = this.audio.micVolume; this.emit(); }
  getEffects() { return this.audio.getEffects(); }
  getVoiceParameters() { return VOICE_PARAMETERS.map(value => ({ ...value })); }
  async setEffect(id) { await this.audio.setEffect(id); this.state.effect = this.audio.effect; this.state.voiceParameters = [...this.audio.voice.values]; this.emit(); }
  async setVoiceParameters(values) { await this.audio.setVoiceParameters(values); this.state.effect = 'custom'; this.state.voiceParameters = [...this.audio.voice.values]; this.emit(); }
  setVoiceParameter(index, value) { if (!Number.isInteger(index) || !VOICE_PARAMETERS[index]) return Promise.reject(new Error('人声音效参数不存在')); const values = [...this.audio.voice.values]; values[index] = Number(value); return this.setVoiceParameters(values); }
  setLyricsOffset(ms) { this.state.lyricsOffset = clamp(ms, -30000, 30000); this.updateTime(); }
  setScoring(enabled) {
    this.scoreEnabled = Boolean(enabled); this.state.scoreEnabled = this.scoreEnabled; this.stopScorePoll();
    if (!enabled) { this.state.scoreStatus = 'disabled'; this.interruptTake(); this.cancelScoreIdentity(); }
    else if (!this.state.song) { this.state.scoreStatus = 'waiting'; this.state.scoreMessage = '选歌后读取 NAS 评分谱'; }
    else this.prepareScore(); this.emit();
  }
  async prepareScore() {
    this.stopScorePoll(); const scoreGeneration = this.scoreGeneration, generation = this.generation, song = this.state.song;
    if (!this.scoreEnabled || !song) return;
    if (song.objectUrl || song.id == null) { this.state.scoreStatus = 'unavailable'; this.state.scoreMessage = '本机文件没有 NAS 评分参考'; this.emit(); return; }
    if (this.reference && this.scoreHub.usable(this.reference.hubBinding)) { this.scoreModel ||= new PerformanceScore(this.reference); this.state.scoreStatus = 'ready'; this.emit(); return; }
    this.scoreAbort = new AbortController(); const signal = this.scoreAbort.signal;
    const current = () => generation === this.generation && scoreGeneration === this.scoreGeneration && !this.destroyed && this.scoreEnabled;
    await Promise.resolve(this.identityCancellation).catch(noop); if (!current()) return;
    let binding = this.scoreHub.identity();
    if (!binding) { await this.scoreHub.refreshSession(); if (!current()) return; binding = this.scoreHub.identity(); }
    if (!binding || !this.scoreHub.usable(binding)) { this.state.scoreStatus = 'unavailable'; this.state.scoreMessage = '评分中心未连接，请从飞牛入口登录兼容的评分中心'; this.emit(); return; }
    const poll = async () => {
      if (!current()) return;
      try {
        this.state.scoreStatus = 'preparing'; this.state.scoreMessage = '正在核对原媒体与原唱音轨'; this.emit();
        this.scoreIdentitySongId = song.id;
        const fingerprint = await this.api('/api/v2/score-identity/' + encodeURIComponent(song.id), { signal, headers: { 'X-Karaoke-Request': '1' } });
        if (!current()) return;
        const identity = referenceIdentity(fingerprint);
        if (identity) {
          const data = await this.scoreHub.fetchReference(identity, { binding, signal });
          if (!current() || !this.scoreHub.usable(binding)) return;
          if (data) {
            this.reference = data; this.scoreModel = new PerformanceScore(data);
            if (this.take?.partial || this.media.currentTime > .2) this.scoreModel.breakContinuity(true);
            this.state.scoreStatus = 'ready'; this.state.scoreMessage = '已读取 NAS 评分谱' + (!this.state.micEnabled ? (this.state.capabilities.secureContext ? '；开启麦克风后评分' : '；麦克风评分需要 HTTPS 入口') : this.scoreModel.partial ? '；重唱可完整评分' : '');
            this.state.melody = { notes: this.scoreModel.notes, stepMs: this.scoreModel.stepMs, durationMs: this.scoreModel.durationMs };
          } else { this.state.scoreStatus = 'unavailable'; this.state.scoreMessage = '当前账号尚无这份原媒体的原唱评分谱'; }
        } else if (fingerprint?.status === 'pending' || fingerprint?.status === 'busy') {
          this.scoreTimer = setTimeout(poll, clamp(fingerprint.retryAfterMs || 1000, 500, 5000)); this.scoreTimer.unref?.();
        } else { this.state.scoreStatus = 'unavailable'; this.state.scoreMessage = fingerprint?.status === 'ready' ? '这份媒体没有明确的原唱音轨，暂不能自动匹配评分谱' : (fingerprint?.message || '当前来源暂不能核对完整原媒体'); }
        this.emit();
      } catch (error) { if (!current() || error.name === 'AbortError') return; this.state.scoreStatus = 'error'; this.state.scoreMessage = '评分参考无法加载：' + (error.message || String(error)); this.emit(); }
    };
    await poll();
  }
  observeMic({ pitch, level, delayMs }) {
    if (!this.state.micEnabled || this.destroyed) return;
    this.state.detectedPitch = pitch; this.state.micLevel = level;
    this.updateTime(false);
    if (this.state.playing && this.scoreEnabled && this.scoreModel && this.scoreHub.usable(this.reference?.hubBinding)) {
      if (this.take) this.take.frameDelayMs = Math.max(this.take.frameDelayMs, clamp(delayMs, 0, 1000));
      const scoringPosition = Math.max(0, this.media.currentTime * 1000 - delayMs - (this.state.musicLatencyMs || 0));
      this.scoreModel.observe(scoringPosition, pitch);
      this.state.score = this.scoreModel.result();
      this.state.referencePitch = this.reference.notes[Math.floor(scoringPosition / this.scoreModel.stepMs)] ?? null;
      this.state.pitchCents = pitch != null && this.state.referencePitch != null ? PerformanceScore.cents(pitch, this.state.referencePitch) : null;
      this.updateLineScore();
    }
    this.emit();
  }
  async destroy() {
    if (this.destroyed) return; this.cancelScoreIdentity(); this.scoreHub.close(); this.destroyed = true; ++this.generation; this.loadAbort?.abort(); this.stopScorePoll(); this.listeners.forEach(remove => remove()); this.listeners = []; this.clearMedia(); await this.audio.destroy();
  }
}
