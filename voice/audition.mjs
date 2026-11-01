// Voice audition for Maya — generates the same test lines with several ElevenLabs voices,
// labelled A, B, C… in random order so a listening test is blind.
//
//   node voice/audition.mjs                 dry run (free): checks the key, finds the voices, shows the cost
//   node voice/audition.mjs --go            generates the clips
//   node voice/audition.mjs --go --voices "Simone,Bella" --speed 0.9
//
// Needs voice/.env with ELEVENLABS_API_KEY=sk_…  (never commit it or put it in the app)
// Output: voice/auditions/<date-time>/ with the clips, listen.html (play + rate), and key.json
// (which letter is which voice — don't open it until the ratings are in).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.elevenlabs.io/v1';

// ── Options ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const GO = args.includes('--go');
const VOICES = opt('voices', 'Simone,Bella,Amy,Sarah').split(',').map(v => v.trim()).filter(Boolean);
const MODEL = opt('model', 'eleven_multilingual_v2');
const SETTINGS = {
  stability: +opt('stability', 0.5),          // higher = steadier and calmer, lower = more expressive
  similarity_boost: +opt('similarity', 0.75),
  style: +opt('style', 0.15),                 // a little expressiveness; high values get theatrical
  use_speaker_boost: true,
  speed: +opt('speed', 0.92),                 // slightly unhurried: patient, not slow
};

// ── Test lines: every kind of moment Maya has, with maths written as it's spoken ──
const LINES = [
  ['greeting',      "Hi! I'm Maya, your tutor. What would you like to work on today?"],
  ['explain',       "A quadratic equation has the form a x squared, plus b x, plus c, equals zero. Let's start with a simple one: x squared equals nine."],
  ['steps',         'First, we take the square root of both sides. That gives us x equals three, or x equals minus three. Two answers, because minus three squared is also nine.'],
  ['correct-gently', "Not quite, but you're close. Let's look at the second step together, and check the sign."],
  ['encourage',     "This one is genuinely tricky, and lots of students find it hard at first. Let's slow down and take it one small step at a time."],
  ['rephrase',      'Let me put that another way. What do you think happens to the minus sign when we move it to the other side?'],
  ['celebrate',     "Yes, that's it! You spotted that both sides had to change. That's exactly the kind of thinking that solves these."],
  ['check',         "Does that make sense so far? It's completely fine if not. We can look at it again."],
  ['numbers',       'So for two x plus six equals fourteen, we subtract six from both sides to get two x equals eight. Then we divide by two, so x equals four.'],
  ['wrap-up',       'Good work today. You went from stuck to solving these on your own. Want to try one more before we finish?'],
];

// ── Helpers ────────────────────────────────────────────────────────────────
function apiKey() {
  const file = path.join(HERE, '.env');
  const line = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('ELEVENLABS_API_KEY='));
  const key = line && line.slice('ELEVENLABS_API_KEY='.length).trim();
  if (!key) { console.error(`No ELEVENLABS_API_KEY in ${file}`); process.exit(1); }
  return key;
}
const KEY = apiKey();

async function call(url, init = {}, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'xi-api-key': KEY, ...init.headers }, signal: AbortSignal.timeout(60_000) });
      if (res.ok || res.status < 500 || i >= attempts) return res;
    } catch (err) {
      if (i >= attempts) throw err;
    }
    await new Promise(r => setTimeout(r, 2000 * i));
  }
}
const errorText = async res => { const t = await res.text(); try { const j = JSON.parse(t); return j.detail?.message ?? j.detail?.status ?? JSON.stringify(j.detail ?? j); } catch { return t.slice(0, 200); } };
const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);

// ── Main ───────────────────────────────────────────────────────────────────
const voicesRes = await call(`${API}/voices`);
if (!voicesRes.ok) { console.error(`Couldn't list voices (${voicesRes.status}): ${await errorText(voicesRes)}`); process.exit(1); }
const all = (await voicesRes.json()).voices;
const chosen = VOICES.map(name => ({ name, voice: all.find(v => v.name.toLowerCase().startsWith(name.toLowerCase())) }));
for (const c of chosen) console.log(c.voice ? `  ✓ ${c.voice.name}` : `  ✗ "${c.name}" not found in My Voices`);
const found = chosen.filter(c => c.voice);
if (!found.length) process.exit(1);

const chars = LINES.reduce((n, [, t]) => n + t.length, 0) * found.length;
const sub = await call(`${API}/user/subscription`);
const left = sub.ok ? (s => s.character_limit - s.character_count)(await sub.json()) : null;
console.log(`\n${found.length} voices × ${LINES.length} lines = ${chars} characters (≈ ${chars} credits with ${MODEL})` +
            (left !== null ? `; you have ${left} credits left this month.` : '.'));
console.log('Settings:', JSON.stringify(SETTINGS));
if (left !== null && chars > left) { console.error('Not enough credits — use fewer voices (--voices "A,B").'); process.exit(1); }
if (!GO) { console.log('\nDry run — nothing generated. Add --go to generate the clips.'); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const out = path.join(HERE, 'auditions', stamp);
fs.mkdirSync(out, { recursive: true });
const letters = 'ABCDEFGH';
const lineup = shuffle(found).map((c, i) => ({ letter: letters[i], name: c.voice.name, id: c.voice.voice_id }));
const clips = [];

for (const v of lineup) {
  console.log(`\nVoice ${v.letter}:`);
  for (const [n, [label, text]] of LINES.entries()) {
    const file = `${v.letter}-${String(n + 1).padStart(2, '0')}-${label}.mp3`;
    let res = await call(`${API}/text-to-speech/${v.id}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: SETTINGS }),
    });
    if (!res.ok) {
      const why = await errorText(res);
      console.log(`  ✗ ${file}: ${res.status} ${why}`);
      if (res.status === 401 || res.status === 402 || /paid|plan|quota|credits/i.test(why)) {
        console.log('    (skipping the rest of this voice)'); break;
      }
      continue;
    }
    fs.writeFileSync(path.join(out, file), Buffer.from(await res.arrayBuffer()));
    clips.push({ file, letter: v.letter, line: n + 1, label, text });
    console.log(`  ✓ ${file}`);
  }
}

fs.writeFileSync(path.join(out, 'key.json'), JSON.stringify({ model: MODEL, settings: SETTINGS, voices: lineup }, null, 1));

// listen.html: play every clip and rate it; ratings download as a CSV
const QUALITIES = ['warm', 'patient', 'upbeat', 'clear', 'talks down to me'];
const byLine = LINES.map((_, n) => clips.filter(c => c.line === n + 1));
fs.writeFileSync(path.join(out, 'listen.html'), `<!doctype html><meta charset="utf-8"><title>Maya voice test</title>
<style>body{font:15px system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#222}
h2{font-size:15px;margin:28px 0 6px}p.t{color:#555;margin:0 0 10px}.clip{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #eee}
.clip b{width:22px}select{font:inherit}button{font:inherit;padding:8px 14px;margin-top:24px}</style>
<h1>Maya voice test</h1>
<p>Listen to each clip and rate it from 1 (not at all) to 5 (very). Rate how it <i>sounds</i>, not what it says.
Voices are labelled with letters only. Name: <input id="rater" placeholder="your name or initials"></p>
${byLine.map((group, n) => group.length ? `<h2>${n + 1}. ${LINES[n][0]}</h2><p class="t">“${LINES[n][1]}”</p>` +
  group.map(c => `<div class="clip" data-file="${c.file}"><b>${c.letter}</b><audio controls preload="none" src="${c.file}"></audio>` +
    QUALITIES.map(q => `<label>${q} <select data-q="${q}"><option></option>${[1, 2, 3, 4, 5].map(x => `<option>${x}</option>`).join('')}</select></label>`).join('') +
    '</div>').join('') : '').join('')}
<p><label>Comments <input id="notes" size="60"></label></p>
<button onclick="save()">Download my ratings (CSV)</button>
<script>
function save() {
  const rater = document.getElementById('rater').value.trim() || 'anonymous';
  const rows = [['rater', 'clip', ${QUALITIES.map(q => `'${q}'`).join(', ')}, 'comments']];
  for (const div of document.querySelectorAll('.clip')) {
    rows.push([rater, div.dataset.file, ...[...div.querySelectorAll('select')].map(s => s.value), document.getElementById('notes').value]);
  }
  const csv = rows.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'ratings-' + rater.replace(/\\W+/g, '_') + '.csv';
  a.click();
}
</script>`);

console.log(`\n${clips.length} clips saved in ${out}`);
console.log(`Open listen.html there in a browser to listen and rate. key.json says which letter is which voice.`);
