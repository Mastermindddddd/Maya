// Maya's voice server — runs on your laptop, between the app and ElevenLabs.
//
//   node voice/server.mjs
//
// The app sends the text Maya should say; this server calls ElevenLabs with your API key
// (which therefore never goes inside the app) and returns the audio plus per-character
// timings for lip sync.
//
// Credits are precious, so:
//   • every generated line is saved in voice/cache/ — the same line never costs twice
//   • at most DAILY_CHAR_LIMIT new characters per day (default 1,500); past that the server
//     answers 429 and the app carries on with silent lip sync
//   • lines longer than MAX_TEXT characters are refused
//
// Two ways to get a line:
//   POST /speak   the whole line at once (mp3 + timings) — used when streaming isn't available
//   POST /stream  streamed as it's generated: newline-separated JSON, one piece of raw audio
//                 (16-bit PCM, 22,050 Hz) + its character timings per line, so the app can start
//                 playing after ~200 ms. Uses VOICE.streamModel (fast "Flash" model).
//
// Settings come from voice/maya-voice.json (voice + base settings) and voice/.env:
//   ELEVENLABS_API_KEY=sk_…      required
//   DAILY_CHAR_LIMIT=1500        optional
//   PORT=8787                    optional

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.VOICE_CACHE_DIR ?? path.join(HERE, 'cache');  // overridable for testing
const USAGE = path.join(CACHE, 'usage.json');

const env = Object.fromEntries((fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = process.env.ELEVENLABS_API_KEY ?? env.ELEVENLABS_API_KEY;
const API = process.env.ELEVENLABS_API_BASE ?? 'https://api.elevenlabs.io/v1';  // overridable for testing
const PORT = +(process.env.PORT ?? env.PORT ?? 8787);
const DAILY_CHAR_LIMIT = +(process.env.DAILY_CHAR_LIMIT ?? env.DAILY_CHAR_LIMIT ?? 1500);
const MAX_TEXT = 600;
const VOICE = JSON.parse(fs.readFileSync(path.join(HERE, 'maya-voice.json'), 'utf8'));
if (!KEY) { console.error('No ELEVENLABS_API_KEY in voice/.env'); process.exit(1); }
fs.mkdirSync(CACHE, { recursive: true });

// Delivery per reaction (see REACTIONS in src/engine/emotion.ts): speed relative to the base
// voice, and steadier (higher stability) when being gentle
const STYLES = {
  neutral:     { speed: 1.0,  stability: 0 },
  encouraging: { speed: 0.92, stability: +0.1 },
  questioning: { speed: 0.96, stability: 0 },
  affirming:   { speed: 1.05, stability: -0.05 },
};
const settingsFor = reaction => {
  const s = STYLES[reaction] ?? STYLES.neutral, base = VOICE.settings;
  const clamp = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
  return { ...base, speed: clamp(base.speed * s.speed, 0.7, 1.2), stability: clamp(base.stability + s.stability, 0, 1) };
};

// ── Daily budget ───────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const readUsage = () => { try { const u = JSON.parse(fs.readFileSync(USAGE, 'utf8')); return u.date === today() ? u : { date: today(), chars: 0 }; } catch { return { date: today(), chars: 0 }; } };
const addUsage = n => { const u = readUsage(); u.chars += n; fs.writeFileSync(USAGE, JSON.stringify(u)); return u; };

// ── ElevenLabs ─────────────────────────────────────────────────────────────
async function generate(text, settings) {
  const res = await fetch(`${API}/text-to-speech/${VOICE.voiceId}/with-timestamps?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: VOICE.model, voice_settings: settings }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    let why = body.slice(0, 200);
    try { const j = JSON.parse(body); why = j.detail?.message ?? j.detail?.status ?? why; } catch {}
    throw Object.assign(new Error(why), { status: res.status });
  }
  const j = await res.json();
  return {
    audioBase64: j.audio_base64,
    characters: j.alignment.characters,
    starts: j.alignment.character_start_times_seconds,
    ends: j.alignment.character_end_times_seconds,
  };
}

// ── Streaming ──────────────────────────────────────────────────────────────
const STREAM_FORMAT = 'pcm_22050';
const STREAM_RATE = 22050;
const STREAM_MODEL = VOICE.streamModel ?? VOICE.model;

async function stream(res, text, reaction) {
  const settings = settingsFor(reaction);
  const id = crypto.createHash('sha256').update(JSON.stringify([VOICE.voiceId, STREAM_MODEL, settings, STREAM_FORMAT, text])).digest('hex').slice(0, 24);
  const file = path.join(CACHE, `${id}.ndjson`);
  const head = { ...CORS, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' };
  if (fs.existsSync(file)) {
    console.log(`[cache] "${text.slice(0, 50)}" (stream)`);
    res.writeHead(200, { ...head, 'x-cached': '1' });
    return res.end(fs.readFileSync(file));
  }
  const usage = readUsage();
  if (usage.chars + text.length > DAILY_CHAR_LIMIT) {
    console.log(`[limit] daily limit reached (${usage.chars}/${DAILY_CHAR_LIMIT}), not generating "${text.slice(0, 40)}"`);
    return send(res, 429, { error: 'daily character limit reached' });
  }

  let upstream;
  try {
    upstream = await fetch(`${API}/text-to-speech/${VOICE.voiceId}/stream/with-timestamps?output_format=${STREAM_FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: STREAM_MODEL, voice_settings: settings }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.log(`[error] ${err.message}`);
    return send(res, 502, { error: err.message });
  }
  if (!upstream.ok) {
    const body = await upstream.text();
    let why = body.slice(0, 200);
    try { const j = JSON.parse(body); why = j.detail?.message ?? j.detail?.status ?? why; } catch {}
    console.log(`[error] ${upstream.status} ${why}`);
    return send(res, [401, 402, 429].includes(upstream.status) ? upstream.status : 502, { error: why });
  }

  // Pass each piece on as it arrives (the app may hang up early; finish anyway, for the cache)
  res.writeHead(200, head);
  const lines = [];
  let offset = 0, pending = '';
  const forward = raw => {
    if (!raw.trim()) return;
    const j = JSON.parse(raw);
    const audio = j.audio_base64 ?? '';
    const a = j.alignment ?? {};
    let starts = a.character_start_times_seconds ?? [], ends = a.character_end_times_seconds ?? [];
    // Timings may be per piece rather than from the start of the line: make them absolute
    if (starts.length && offset > 0.05 && starts[0] + 0.02 < offset) {
      starts = starts.map(x => x + offset); ends = ends.map(x => x + offset);
    }
    offset += Buffer.byteLength(audio, 'base64') / 2 / STREAM_RATE;
    const line = JSON.stringify({ a: audio, c: a.characters ?? [], s: starts, e: ends });
    lines.push(line);
    if (!res.destroyed) res.write(line + '\n');
  };
  try {
    const decoder = new TextDecoder();
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = pending.indexOf('\n')) >= 0) { forward(pending.slice(0, i)); pending = pending.slice(i + 1); }
    }
    forward(pending);
  } catch (err) {
    console.log(`[error] stream broke: ${err.message}`);
    return res.end();
  }
  res.end();
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const u = addUsage(text.length);
  console.log(`[new]   "${text.slice(0, 50)}" — ${text.length} chars, streamed (${u.chars}/${DAILY_CHAR_LIMIT} today)`);
}

// ── HTTP ───────────────────────────────────────────────────────────────────
// The app's audio WebView calls /stream directly, so allow cross-origin and private-network requests
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-private-network': 'true',
};
const send = (res, status, body) => {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const u = readUsage();
    return send(res, 200, { ok: true, voice: VOICE.name, usedToday: u.chars, dailyLimit: DAILY_CHAR_LIMIT });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST' || (req.url !== '/speak' && req.url !== '/stream')) return send(res, 404, { error: 'not found' });

  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 10_000) return send(res, 413, { error: 'too large' }); }
  let text, reaction;
  try { ({ text, reaction = 'neutral' } = JSON.parse(body)); } catch { return send(res, 400, { error: 'bad JSON' }); }
  text = String(text ?? '').trim();
  if (!text) return send(res, 400, { error: 'no text' });
  if (text.length > MAX_TEXT) return send(res, 413, { error: `text longer than ${MAX_TEXT} characters` });
  if (req.url === '/stream') return stream(res, text, reaction);

  const settings = settingsFor(reaction);
  const id = crypto.createHash('sha256').update(JSON.stringify([VOICE.voiceId, VOICE.model, settings, text])).digest('hex').slice(0, 24);
  const file = path.join(CACHE, `${id}.json`);
  if (fs.existsSync(file)) {
    console.log(`[cache] "${text.slice(0, 50)}"`);
    return send(res, 200, { ...JSON.parse(fs.readFileSync(file, 'utf8')), cached: true });
  }

  const usage = readUsage();
  if (usage.chars + text.length > DAILY_CHAR_LIMIT) {
    console.log(`[limit] daily limit reached (${usage.chars}/${DAILY_CHAR_LIMIT}), not generating "${text.slice(0, 40)}"`);
    return send(res, 429, { error: 'daily character limit reached' });
  }
  try {
    const result = await generate(text, settings);
    fs.writeFileSync(file, JSON.stringify(result));
    const u = addUsage(text.length);
    console.log(`[new]   "${text.slice(0, 50)}" — ${text.length} chars (${u.chars}/${DAILY_CHAR_LIMIT} today)`);
    send(res, 200, { ...result, cached: false });
  } catch (err) {
    console.log(`[error] ${err.status ?? ''} ${err.message}`);
    send(res, err.status === 401 || err.status === 402 || err.status === 429 ? err.status : 502, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const u = readUsage();
  console.log(`Maya's voice (${VOICE.name}; streaming with ${STREAM_MODEL}) on port ${PORT} — ${u.chars}/${DAILY_CHAR_LIMIT} new characters used today`);
  console.log('Leave this running while you use the app. Ctrl+C to stop.');
});
