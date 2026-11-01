/**
 * VoiceBridge — Maya's ears and mouth in one hidden WebView
 * ─────────────────────────────────────────────────────────
 * Ears (only while hands-free is on): Silero VAD (@ricky0123/vad-web + onnxruntime-web) on the
 *   phone. Every ~32 ms frame's speech probability and loudness goes to TurnDetector
 *   (engine/turnDetector.ts), which decides turns. No audio leaves the phone.
 * Mouth: streams Maya's lines from the voice server (/stream: raw audio + timings, as they're
 *   generated) and plays them with Web Audio as soon as 200 ms is buffered. Short fillers
 *   ("Mm, okay.") are preloaded so they can play the instant a student's turn ends.
 *   Playing her voice in the same page that listens lets the phone's echo cancellation remove
 *   it from the microphone, so she's less likely to hear herself.
 *
 * Why a WebView: Expo Go's audio player waits for seconds of audio before it starts; Web Audio
 * can start on the first fraction of a second.
 *
 * First hands-free use downloads the VAD engine (~11 MB) and model (~2.3 MB); the WebView caches them.
 */

import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { TurnDetector, TurnEvent } from '../engine/turnDetector';

const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

// ── Page that runs in the WebView ──────────────────────────────────────────
export const BRIDGE_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#000">
<script>
const post = m => window.ReactNativeWebView.postMessage(JSON.stringify(m));
let ctx = null;
const audio = () => {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};

// ── Mouth: streamed playback ──
const RATE = 22050;          // the voice server streams 16-bit PCM at 22,050 Hz
const START_AFTER = 0.2;     // seconds of audio buffered before a line starts
const GAP = 0.12;            // pause between a filler and the reply that follows it
const lines = new Map();     // lines loading or playing
const fillers = new Map();   // preloaded fillers: id -> { chunks, aligned }
let busyUntil = 0;           // when the voice is free again (audio-clock time)

const toFloat = b64 => {
  const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 32768) v -= 65536;
    out[i] = v / 32768;
  }
  return out;
};
const newLine = id => {
  const l = { id, chunks: [], aligned: [], buffered: 0, done: false, wanted: false, started: false,
              ended: false, startAt: 0, next: 0, played: 0, timeline: [], sources: [], controller: new AbortController() };
  lines.set(id, l);
  return l;
};
// Where in the line we are (ms), from what was actually scheduled — stays right even if
// a late piece left a gap
const position = l => {
  const now = audio().currentTime;
  if (now < l.startAt) return (now - l.startAt) * 1000;
  let pos = 0;
  for (const seg of l.timeline) {
    if (now < seg.at) break;
    pos = (seg.offset + Math.min(now - seg.at, seg.dur)) * 1000;
  }
  return pos;
};
const piece = (l, raw) => {
  if (!raw.trim()) return;
  const j = JSON.parse(raw);
  if (j.a) {
    const pcm = toFloat(j.a);
    if (pcm.length) {
      const b = audio().createBuffer(1, pcm.length, RATE);
      b.copyToChannel(pcm, 0);
      l.chunks.push(b);
      l.buffered += b.duration;
    }
  }
  if (j.c && j.c.length) {
    l.aligned.push([j.c, j.s, j.e]);
    if (l.started) post({ type: 'align', id: l.id, c: j.c, s: j.s, e: j.e });
  }
  play(l);
};
const play = l => {
  if (!l.wanted || l.ended) return;
  const c = audio();
  if (!l.started) {
    if (l.buffered < START_AFTER && !l.done) return;
    l.started = true;
    l.startAt = Math.max(c.currentTime + 0.03, busyUntil > c.currentTime ? busyUntil + GAP : 0);
    l.next = l.startAt;
    post({ type: 'start', id: l.id, inMs: Math.round((l.startAt - c.currentTime) * 1000) });
    for (const [cs, s, e] of l.aligned) post({ type: 'align', id: l.id, c: cs, s, e });
  }
  while (l.chunks.length) {
    const b = l.chunks.shift();
    const src = c.createBufferSource();
    src.buffer = b;
    src.connect(c.destination);
    const at = Math.max(l.next, c.currentTime + 0.01);
    src.start(at);
    l.timeline.push({ at, offset: l.played, dur: b.duration });
    l.played += b.duration;
    l.next = at + b.duration;
    l.sources.push(src);
  }
  busyUntil = Math.max(busyUntil, l.next);
  if (l.done && !l.endTimer) {
    l.endTimer = setTimeout(() => { l.ended = true; lines.delete(l.id); post({ type: 'end', id: l.id }); },
                            Math.max(0, (l.next - c.currentTime) * 1000));
  }
};
const load = async (l, url, text, reaction) => {
  try {
    const res = await fetch(url + '/stream', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, reaction }), signal: l.controller.signal,
    });
    if (!res.ok) {
      let why = String(res.status);
      try { why += ' ' + (await res.json()).error; } catch (e) {}
      throw new Error(why);
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) { piece(l, buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    piece(l, buf);
    l.done = true;
    play(l);
    return true;
  } catch (err) {
    lines.delete(l.id);
    if (err.name !== 'AbortError') post({ type: 'audio-error', id: l.id, message: String(err.message || err) });
    return false;
  }
};
const stopAll = () => {
  for (const l of lines.values()) {
    l.controller.abort();
    for (const s of l.sources) { try { s.stop(); } catch (e) {} }
    clearTimeout(l.endTimer);
    if (l.started && !l.ended) post({ type: 'end', id: l.id, stopped: true });
  }
  lines.clear();
  busyUntil = 0;
};
setInterval(() => {
  for (const l of lines.values()) if (l.started && !l.ended) post({ type: 'pos', id: l.id, ms: Math.round(position(l)) });
}, 50);

// ── Ears: Silero VAD (only while listening) ──
const REASONS = {
  NotAllowedError:  'microphone permission was refused',
  NotReadableError: 'another app is using the microphone',
  NotFoundError:    'no microphone was found',
  TimeoutError:     "the microphone didn't start within 15 seconds",
};
const loadScript = src => new Promise((resolve, reject) => {
  if (document.querySelector('script[src="' + src + '"]')) return resolve();
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('could not download ' + src.split('/').pop()));
  document.head.appendChild(s);
});
let vadInstance = null, micStream = null, listenRun = 0;
const startListening = async () => {
  const run = ++listenRun;
  try {
    post({ type: 'status', status: 'mic' });
    // Echo cancellation and noise suppression on; automatic gain OFF, so loudness stays
    // meaningful (the turn detector tells the student from a TV by how loud they are)
    const getStream = window.__testStream || (() => navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    }));
    const stream = await Promise.race([
      getStream(),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 15000)),
    ]);
    if (run !== listenRun) { stream.getTracks().forEach(t => t.stop()); return; }
    micStream = stream;
    post({ type: 'status', status: 'model' });
    await loadScript('${ORT_BASE}ort.wasm.min.js');
    await loadScript('${VAD_BASE}bundle.min.js');
    const v = await vad.MicVAD.new({
      model: 'v5',
      baseAssetPath: '${VAD_BASE}',
      onnxWASMBasePath: '${ORT_BASE}',
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async s => s,
      // Turns are decided by the app (TurnDetector); the page only reports every frame
      onFrameProcessed: (probs, frame) => {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const db = 10 * Math.log10(sum / frame.length + 1e-10);
        post({ type: 'f', p: Math.round(probs.isSpeech * 1000) / 1000, db: Math.round(db * 10) / 10, t: Math.round(performance.now()) });
      },
      onSpeechEnd: () => {},  // (step 3: this audio goes to speech-to-text)
    });
    if (run !== listenRun) { v.destroy(); return; }
    vadInstance = v;
    v.start();
    post({ type: 'status', status: 'on' });
  } catch (err) {
    if (run === listenRun) post({ type: 'error', message: REASONS[err && err.name] || String(err && err.message || err) });
  }
};
const stopListening = () => {
  listenRun++;
  if (vadInstance) { try { vadInstance.destroy(); } catch (e) {} vadInstance = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  post({ type: 'status', status: 'off' });
};

// ── Commands from the app ──
window.__cmd = cmd => {
  switch (cmd.cmd) {
    case 'say': { const l = newLine(cmd.id); l.wanted = true; load(l, cmd.url, cmd.text, cmd.reaction); break; }
    case 'preload': {
      const l = newLine('preload:' + cmd.id);
      load(l, cmd.url, cmd.text, cmd.reaction).then(ok => {
        lines.delete(l.id);
        if (!ok) return;
        fillers.set(cmd.id, { chunks: l.chunks, aligned: l.aligned });
        post({ type: 'preloaded', id: cmd.id });
      });
      break;
    }
    case 'filler': {
      const f = fillers.get(cmd.filler);
      if (!f) { post({ type: 'audio-error', id: cmd.id, message: 'filler not loaded' }); break; }
      const l = newLine(cmd.id);
      l.chunks = f.chunks.slice(); l.aligned = f.aligned;
      l.buffered = f.chunks.reduce((s, b) => s + b.duration, 0);
      l.done = true; l.wanted = true;
      play(l);
      break;
    }
    case 'stop': stopAll(); break;
    case 'listen': cmd.on ? startListening() : stopListening(); break;
  }
};
audio();
post({ type: 'ready' });
</script></body></html>`;

// ── App side ───────────────────────────────────────────────────────────────
export type ListenerStatus = 'off' | 'mic' | 'model' | 'on' | 'error';
export type ListenerInfo = { status: ListenerStatus; error?: string; level?: number };

/** What happens to one line Maya says, as it plays */
export type LineEvents = {
  onStart?: (inMs: number) => void;                                  // audio starts in `inMs`
  onAlign?: (chars: string[], starts: number[], ends: number[]) => void;
  onPosition?: (ms: number) => void;                                 // playback position, every 50 ms
  onEnd?: (stopped: boolean) => void;
  onError?: (message: string) => void;
};

export class VoiceBridge {
  private web: WebView | null = null;
  private detector = new TurnDetector(e => this.onEvent?.(e));
  private lastInfoAt = 0;
  private lines = new Map<string, LineEvents>();
  private loadedFillers = new Set<string>();
  private nextId = 0;
  private queued: object[] = [];  // commands sent before the page was ready
  ready = false;
  info: ListenerInfo = { status: 'off' };
  onEvent?: (event: TurnEvent) => void;
  onInfo?: (info: ListenerInfo) => void;
  onReady?: () => void;

  attach(web: WebView | null) {
    this.web = web;
    if (!web) { this.ready = false; this.lines.clear(); this.loadedFillers.clear(); this.queued = []; }
  }

  private send(cmd: object) {
    if (!this.ready || !this.web) { this.queued.push(cmd); return; }
    // JSON is valid JavaScript, so the command can be passed as a literal
    this.web.injectJavaScript(`window.__cmd && window.__cmd(${JSON.stringify(cmd)}); true;`);
  }

  // ── Ears ──
  setListening(on: boolean) {
    if (!on) this.detector = new TurnDetector(e => this.onEvent?.(e));
    this.send({ cmd: 'listen', on });
  }
  setTutorSpeaking(on: boolean) { this.detector.setTutorSpeaking(on); }

  // ── Mouth ──
  /** Streams and plays a line from the voice server at `url`. Returns its id. */
  say(url: string, text: string, reaction: string, events: LineEvents): string {
    const id = `line-${++this.nextId}`;
    this.lines.set(id, events);
    this.send({ cmd: 'say', id, url, text, reaction });
    return id;
  }

  preloadFiller(url: string, id: string, text: string) {
    this.send({ cmd: 'preload', id, url, text, reaction: 'neutral' });
  }
  hasFiller(id: string) { return this.loadedFillers.has(id); }

  /** Plays a preloaded filler at once. Returns its line id, or null if it isn't loaded. */
  playFiller(filler: string, events: LineEvents): string | null {
    if (!this.loadedFillers.has(filler)) return null;
    const id = `line-${++this.nextId}`;
    this.lines.set(id, events);
    this.send({ cmd: 'filler', id, filler });
    return id;
  }

  /** Stops everything Maya is saying (and anything still loading) */
  stop() { this.send({ cmd: 'stop' }); }

  /** Called with each message from the WebView page */
  handleMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const line = msg.id ? this.lines.get(msg.id) : undefined;
    switch (msg.type) {
      case 'f':
        this.detector.push(msg);
        if (msg.t - this.lastInfoAt > 250) { this.lastInfoAt = msg.t; this.update({ level: msg.db }); }
        break;
      case 'status': this.update({ status: msg.status, error: undefined }); break;
      case 'error': this.update({ status: 'error', error: msg.message }); break;
      case 'ready': {
        this.ready = true;
        const queued = this.queued; this.queued = [];
        queued.forEach(cmd => this.send(cmd));
        this.onReady?.();
        break;
      }
      case 'preloaded': this.loadedFillers.add(msg.id); break;
      case 'start': line?.onStart?.(msg.inMs); break;
      case 'align': line?.onAlign?.(msg.c, msg.s, msg.e); break;
      case 'pos': line?.onPosition?.(msg.ms); break;
      case 'end': line?.onEnd?.(!!msg.stopped); this.lines.delete(msg.id); break;
      case 'audio-error': line?.onError?.(msg.message); this.lines.delete(msg.id); break;
    }
  }

  private update(patch: Partial<ListenerInfo>) {
    this.info = { ...this.info, ...patch };
    this.onInfo?.(this.info);
  }
}

// ── Component ──────────────────────────────────────────────────────────────
export default function VoiceBridgeView({ bridge }: { bridge: VoiceBridge }) {
  const ref = useRef<WebView>(null);
  useEffect(() => () => bridge.attach(null), [bridge]);
  return (
    // Tiny but on screen: some Android WebViews pause timers in views that aren't visible
    <View style={s.host} pointerEvents="none">
      <WebView
        ref={web => { (ref as React.MutableRefObject<WebView | null>).current = web; bridge.attach(web); }}
        // http://localhost still counts as secure (so the microphone works), and unlike https it
        // may fetch from the voice server on your laptop, which is plain http
        source={{ html: BRIDGE_PAGE, baseUrl: 'http://localhost/' }}
        originWhitelist={['*']}
        javaScriptEnabled
        mixedContentMode="always"
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mediaCapturePermissionGrantType="grant"
        onMessage={(e: WebViewMessageEvent) => bridge.handleMessage(e.nativeEvent.data)}
        onError={e => bridge.handleMessage(JSON.stringify({ type: 'error', message: e.nativeEvent.description }))}
        style={s.webview}
      />
    </View>
  );
}

const s = StyleSheet.create({
  host:    { position: 'absolute', left: 0, bottom: 0, width: 2, height: 2, opacity: 0.01, overflow: 'hidden' },
  webview: { width: 2, height: 2, backgroundColor: 'transparent' },
});
