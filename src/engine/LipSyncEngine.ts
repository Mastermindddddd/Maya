/**
 * LipSyncEngine
 * ─────────────
 * Converts text / character / phoneme timing data into CC4 viseme shape key
 * weights, driven frame-by-frame. The renderer opens the jaw from these weights
 * too (see JAW_OPEN in AvatarRenderer), so the mouth moves even without shape keys.
 *
 * Three modes:
 *   1. speakText       — simulated visemes from plain text (until TTS is wired up)
 *   2. speakCharacters — per-character timings (e.g. an alignment array from a TTS API)
 *   3. speakPhonemes   — ARPAbet phoneme timestamps
 *
 * CC4 Viseme → sound mapping used here (verify visually: drive each viseme to 1 and look):
 *   V_Open        → A, Ah, Aa, Ae (open mouth)
 *   V_Explosive   → T, D, K, G, N, L (tongue consonants: jaw slightly open)
 *   V_Dental_Lip  → F, V (labiodental)
 *   V_Tight_O     → O, Oh, Ow, Oo, W
 *   V_Tight       → R, Uh (tight round)
 *   V_Wide        → E, Ee, Ih, Iy, Y (wide mouth)
 *   V_Affricate   → Ch, J, Sh, Zh, S, Z, Th
 *   (none)        → B, P, M: lips fully closed — the clearest sync cue, so never skipped
 *
 * Usage:
 *   const { speak, stopSpeaking } = useLipSync();
 *   const durationMs = speak("Hello, how are you?");
 */

import { useEffect, useRef, useCallback } from 'react';
import type { VisemeWeights } from '../components/AvatarRenderer';
import type { SpeechStyle } from './emotion';
import { useSessionStore } from '../store/sessionStore';

type SetVisemeFn = (weights: VisemeWeights) => void;
type Frame = { time: number; weights: VisemeWeights };
// One mouth shape held for `ms`; key null = lips closed
type Unit = { key: string | null; weight: number; ms: number; vowel: boolean };

// ── Phoneme → CC4 viseme key mapping (ARPAbet, stress digits stripped) ───
const PHONEME_TO_VISEME: Record<string, string | null> = {
  // Open vowels
  'AA': 'V_Open', 'AH': 'V_Open', 'AE': 'V_Open', 'AW': 'V_Open',
  // Wide vowels
  'EH': 'V_Wide', 'EY': 'V_Wide', 'IH': 'V_Wide', 'IY': 'V_Wide',
  'AY': 'V_Wide',
  // Rounded vowels
  'OW': 'V_Tight_O', 'UW': 'V_Tight_O', 'W':  'V_Tight_O', 'OY': 'V_Tight_O',
  'AO': 'V_Tight',   'UH': 'V_Tight',
  // Lips closed
  'B': null, 'P': null, 'M': null,
  // Tongue consonants
  'T': 'V_Explosive', 'D': 'V_Explosive', 'K': 'V_Explosive', 'G': 'V_Explosive',
  'N': 'V_Explosive', 'NG': 'V_Explosive', 'L': 'V_Explosive',
  // Labiodentals
  'F': 'V_Dental_Lip', 'V': 'V_Dental_Lip',
  // Affricates and sibilants
  'CH': 'V_Affricate', 'JH': 'V_Affricate', 'SH': 'V_Affricate',
  'ZH': 'V_Affricate', 'S':  'V_Affricate', 'Z':  'V_Affricate',
  'TH': 'V_Affricate', 'DH': 'V_Affricate',
  // Glides
  'R': 'V_Tight', 'Y': 'V_Wide',
  'HH': 'V_Open',
  // Silence
  'SIL': null, 'SP': null,
};

// ── Text → mouth shapes ───────────────────────────────────────────────────
// Letter pairs first (first match wins), then single letters. [key, weight, ms]
type Shape = [string | null, number, number];
const VOWEL_MS = 110, CONSONANT_MS = 58, CLOSED_MS = 75;
const DIGRAPHS: Record<string, Shape> = {
  th: ['V_Affricate', 0.55, CONSONANT_MS], sh: ['V_Affricate', 0.65, 80], ch: ['V_Affricate', 0.65, 80],
  ph: ['V_Dental_Lip', 0.7, CONSONANT_MS], wh: ['V_Tight_O', 0.6, CONSONANT_MS], ck: ['V_Explosive', 0.45, CONSONANT_MS],
  ng: ['V_Explosive', 0.35, CONSONANT_MS], qu: ['V_Tight_O', 0.6, 90],
  oo: ['V_Tight_O', 0.95, VOWEL_MS + 30], ou: ['V_Tight_O', 0.85, VOWEL_MS + 20], ow: ['V_Tight_O', 0.85, VOWEL_MS + 20],
  ee: ['V_Wide', 0.9, VOWEL_MS + 20], ea: ['V_Wide', 0.9, VOWEL_MS + 20], ie: ['V_Wide', 0.85, VOWEL_MS],
  ai: ['V_Wide', 0.85, VOWEL_MS + 20], ay: ['V_Wide', 0.85, VOWEL_MS + 20],
  au: ['V_Open', 0.9, VOWEL_MS + 20], aw: ['V_Open', 0.9, VOWEL_MS + 20], oi: ['V_Tight_O', 0.8, VOWEL_MS + 30],
};
const LETTERS: Record<string, Shape> = {
  a: ['V_Open', 1, VOWEL_MS], e: ['V_Wide', 0.8, VOWEL_MS - 15], i: ['V_Wide', 0.75, VOWEL_MS - 20],
  o: ['V_Tight_O', 0.9, VOWEL_MS], u: ['V_Tight', 0.8, VOWEL_MS - 15], y: ['V_Wide', 0.7, VOWEL_MS - 20],
  b: [null, 0, CLOSED_MS], p: [null, 0, CLOSED_MS], m: [null, 0, CLOSED_MS],
  f: ['V_Dental_Lip', 0.75, 75], v: ['V_Dental_Lip', 0.7, 70],
  s: ['V_Affricate', 0.6, 75], z: ['V_Affricate', 0.6, 70], c: ['V_Explosive', 0.45, CONSONANT_MS],
  j: ['V_Affricate', 0.65, 75], x: ['V_Affricate', 0.55, 90],
  t: ['V_Explosive', 0.45, CONSONANT_MS], d: ['V_Explosive', 0.45, CONSONANT_MS], n: ['V_Explosive', 0.35, CONSONANT_MS],
  l: ['V_Explosive', 0.4, CONSONANT_MS], k: ['V_Explosive', 0.45, CONSONANT_MS], g: ['V_Explosive', 0.45, CONSONANT_MS],
  q: ['V_Explosive', 0.45, CONSONANT_MS], r: ['V_Tight', 0.6, 70], w: ['V_Tight_O', 0.7, 70], h: ['V_Open', 0.3, 55],
};
const VOWELS = /[aeiouy]/;
// Pauses (lips closed) after punctuation, in ms
const PAUSES: Record<string, number> = { ',': 200, ';': 250, ':': 250, '—': 220, '-': 0, '.': 380, '?': 380, '!': 380 };
// Spoken forms of symbols and digits, so maths reads like it sounds
const SPOKEN: Record<string, string> = {
  '+': ' plus ', '=': ' equals ', '×': ' times ', '÷': ' divided by ', '²': ' squared ', '³': ' cubed ', '%': ' percent ',
  '0': ' zero ', '1': ' one ', '2': ' two ', '3': ' three ', '4': ' four ', '5': ' five ',
  '6': ' six ', '7': ' seven ', '8': ' eight ', '9': ' nine ',
};

// Splits a word into mouth-shape units
const wordUnits = (word: string): Unit[] => {
  // A final silent 'e' ("make", "time") isn't spoken
  const w = word.length > 2 && word.endsWith('e') && !VOWELS.test(word[word.length - 2]) ? word.slice(0, -1) : word;
  const units: Unit[] = [];
  for (let i = 0; i < w.length; ) {
    const pair  = DIGRAPHS[w.slice(i, i + 2)];
    const shape = pair ?? LETTERS[w[i]];
    const vowel = VOWELS.test(w[i]);
    i += pair ? 2 : 1;
    if (!shape) continue;
    const [key, weight, ms] = shape;
    const prev = units[units.length - 1];
    // Vowel runs are one syllable; doubled consonants ("ll", "ss") are one sound
    if (prev && prev.vowel === vowel && (vowel || prev.key === key)) { prev.ms += ms * 0.4; continue; }
    units.push({ key, weight, ms, vowel });
  }
  return units;
};

/** Text as it should be spoken: maths symbols and digits as words ("x²" → "x squared").
 *  Used for lip sync and sent to the TTS voice, so both say the same thing. */
export const spokenText = (text: string) => text
  // "ax² + bx" is "a x squared plus b x", not the word "ax"
  .replace(/\b([a-z])([xyz])(?=[²³]|\s*[+=×÷−-])/g, '$1 $2')
  // "2x" is "two x"
  .replace(/(\d)([a-z])\b/g, '$1 $2')
  // a minus sign before a number or variable ("x = -3"), but not a dash between words
  .replace(/(^|[\s(=])[-−](?=\s?[\dxyz(])/g, '$1 minus ')
  // whole numbers as words ("14" → "fourteen"), so the voice and the mouth see the same words;
  // thousands separators first ("1,000" is one number)
  .replace(/(\d),(?=\d{3}\b)/g, '$1')
  .replace(/\d+(?:\.\d+)?/g, numberWords)
  .replace(/[+=×÷²³%]/g, ch => SPOKEN[ch] ?? ' ')
  .replace(/\s+([,.;:?!])/g, '$1')
  .replace(/\s{2,}/g, ' ').trim();

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function integerWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' and ' + integerWords(n % 100) : '');
  if (n < 1_000_000) return integerWords(Math.floor(n / 1000)) + ' thousand' +
    (n % 1000 ? (n % 1000 < 100 ? ' and ' : ' ') + integerWords(n % 1000) : '');
  return String(n).split('').map(d => ONES[+d]).join(' ');  // very long numbers: digit by digit
}

/** "14" → "fourteen", "3.5" → "three point five" */
function numberWords(num: string): string {
  const [whole, decimals] = num.split('.');
  const words = integerWords(parseInt(whole, 10));
  return ` ${decimals ? `${words} point ${decimals.split('').map(d => ONES[+d]).join(' ')}` : words} `;
}

const textUnits = (text: string): Unit[] => {
  const spoken = spokenText(text).toLowerCase();
  const units: Unit[] = [];
  let syllable = 0;
  for (const token of spoken.match(/[a-z']+|[,;:.?!—]/g) ?? []) {
    if (token in PAUSES) {
      // The syllable before a pause is drawn out, then the lips close
      const last = [...units].reverse().find(u => u.vowel);
      if (last) last.ms *= 1.3;
      if (PAUSES[token] > 0) units.push({ key: null, weight: 0, ms: PAUSES[token], vowel: false });
      continue;
    }
    for (const u of wordUnits(token.replace(/'/g, ''))) {
      // Natural variation: every other syllable a little stronger, so it isn't metronomic
      if (u.vowel) u.weight *= syllable++ % 2 === 0 ? 1 : 0.8;
      units.push(u);
    }
    units.push({ key: null, weight: 0, ms: 25, vowel: false });  // brief relax between words
  }
  return units;
};

// Single character → shape, for per-character TTS timings
const charShape = (char: string): Shape | null => LETTERS[char.toLowerCase()] ?? null;

// ── LipSyncEngine class ───────────────────────────────────────────────────
export class LipSyncEngine {
  private setViseme:   SetVisemeFn;
  private rafId:       number | null = null;
  private schedule:    Frame[] = [];
  private startTime:   number = 0;
  private isRunning:   boolean = false;
  private run:         number = 0;   // bumps on every stop, so a stopped stream ignores late timings

  constructor(setViseme: SetVisemeFn) {
    this.setViseme = setViseme;
  }

  // ── Mode 1: animate visemes from plain text ──────────────────────────
  // Returns how long the speech lasts (ms). Pass durationMs to fit it to a known audio length.
  // style.rate < 1 speaks slower; style.intensity < 1 moves the mouth less (a softer tone).
  speakText(text: string, durationMs?: number, style: SpeechStyle = { rate: 1, intensity: 1 }): number {
    this.stop();
    const units = textUnits(text);
    if (units.length === 0) return 0;
    const natural = units.reduce((sum, u) => sum + u.ms, 0);
    const scale   = durationMs ? durationMs / natural : 1 / style.rate;
    const frames: Frame[] = [];
    let t = 0;
    for (const u of units) {
      frames.push({ time: t, weights: this.singleViseme(u.key, Math.min(1, u.weight * style.intensity)) });
      t += u.ms * scale;
    }
    frames.push({ time: t, weights: {} });
    this.playFrames(frames);
    return t;
  }

  // ── Mode 2: per-character timings (seconds), e.g. from a TTS alignment ─
  // `clock` (ms) lets the mouth follow the audio's playback position instead of wall time.
  speakCharacters(chars: string[], startsSec: number[], endsSec: number[],
                  intensity = 1, clock?: () => number) {
    this.stop();
    if (chars.length === 0) return;
    const frames = this.charFrames(chars, startsSec, endsSec, intensity);
    const lastEnd = (endsSec[endsSec.length - 1] ?? 0) * 1000;
    frames.push({ time: lastEnd + 80, weights: {} });
    this.playFrames(frames, clock);
  }

  /** Lip sync for audio that's still arriving (streamed voice): `add` timings as pieces come
   *  in, then `end` when the audio is complete. Until then the mouth holds its last shape. */
  speakCharacterStream(intensity = 1, clock?: () => number) {
    this.stop();
    const run = this.run;
    let open = true, lastEnd = 0;
    this.playFrames([{ time: 0, weights: {} }], clock, () => open);
    return {
      add: (chars: string[], startsSec: number[], endsSec: number[]) => {
        if (run !== this.run || !chars.length) return;
        this.schedule.push(...this.charFrames(chars, startsSec, endsSec, intensity));
        lastEnd = Math.max(lastEnd, (endsSec[endsSec.length - 1] ?? 0) * 1000);
      },
      end: () => {
        if (run !== this.run) return;
        this.schedule.push({ time: lastEnd + 80, weights: {} });
        open = false;
      },
    };
  }

  // Mouth-shape frames from per-character timings (seconds)
  private charFrames(chars: string[], startsSec: number[], endsSec: number[], intensity: number): Frame[] {
    const frames: Frame[] = [];
    const text = chars.join('').toLowerCase();

    for (let i = 0; i < chars.length; ) {
      const start = (startsSec[i] ?? 0) * 1000;
      const pair  = DIGRAPHS[text.slice(i, i + 2)];
      const char  = text[i];
      i += pair ? 2 : 1;
      if (char === ' ') {
        // Word gaps in fluent speech are a few ms: only relax the mouth on a real pause
        const gap = ((startsSec[i] ?? endsSec[i - 1] ?? 0) - (startsSec[i - 1] ?? 0)) * 1000;
        if (gap > 120) frames.push({ time: start, weights: {} });
        continue;
      }
      const shape = pair ?? charShape(char);
      // Punctuation and B/P/M close the mouth
      frames.push({ time: start, weights: shape ? this.singleViseme(shape[0], Math.min(1, shape[1] * intensity)) : {} });
    }
    return frames;
  }

  // ── Mode 3: ARPAbet phoneme timestamps ───────────────────────────────
  //  phonemes: [{ phoneme: 'AH', startTime: 0.0, endTime: 0.08 }, ...]  (seconds)
  speakPhonemes(phonemes: Array<{ phoneme: string; startTime: number; endTime: number }>) {
    this.stop();
    if (phonemes.length === 0) return;
    const frames: Frame[] = [];

    phonemes.forEach(({ phoneme, startTime, endTime }) => {
      // CMU-style phonemes carry stress digits (AH0, IY1): strip them
      const key     = PHONEME_TO_VISEME[phoneme.toUpperCase().replace(/[0-9]/g, '')];
      const midTime = (startTime + endTime) / 2;

      frames.push({ time: startTime * 1000, weights: this.singleViseme(key, 0.2) });  // ramp up
      frames.push({ time: midTime   * 1000, weights: this.singleViseme(key, 0.9) });  // peak
      frames.push({ time: endTime   * 1000, weights: this.singleViseme(key, 0.1) });  // ramp down
    });

    const lastEnd = phonemes[phonemes.length - 1].endTime;
    frames.push({ time: lastEnd * 1000 + 80, weights: {} });
    this.playFrames(frames);
  }

  // ── Stop all lip sync ─────────────────────────────────────────────────
  stop() {
    this.run++;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.isRunning = false;
    this.setViseme({});
  }

  // ── Internal: frame player ─────────────────────────────────────────────
  // `open`: more frames may still be added (streaming); don't finish at the last one yet
  private playFrames(frames: Frame[], clock?: () => number, open: () => boolean = () => false) {
    if (frames.length === 0) return;
    // Frames must be in time order
    this.schedule  = [...frames].sort((a, b) => a.time - b.time);
    this.startTime = performance.now();
    this.isRunning = true;
    let frameIdx    = 0;
    let lastApplied = -1;

    const tick = () => {
      if (!this.isRunning) return;
      const elapsed = clock ? clock() : performance.now() - this.startTime;
      const lastIdx = this.schedule.length - 1;

      while (frameIdx < lastIdx && this.schedule[frameIdx + 1].time <= elapsed) {
        frameIdx++;
      }

      if (frameIdx >= lastIdx && !open()) {
        // Finished
        this.setViseme({});
        this.isRunning = false;
        this.rafId = null;
        return;
      }

      // Only push to the store when the viseme actually changes
      if (frameIdx !== lastApplied) {
        this.setViseme(this.schedule[frameIdx].weights);
        lastApplied = frameIdx;
      }
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  private singleViseme(key: string | null | undefined, weight: number): VisemeWeights {
    if (!key) return {};
    return { [key]: weight };
  }
}

// ── React hook wrapping the engine ────────────────────────────────────────
export function useLipSync() {
  const setViseme = useSessionStore(s => s.setViseme);
  const engine    = useRef<LipSyncEngine | null>(null);

  if (!engine.current) {
    engine.current = new LipSyncEngine(setViseme);
  }

  // Stop the loop if the screen using this hook unmounts
  useEffect(() => () => engine.current?.stop(), []);

  const speak = useCallback((text: string, durationMs?: number, style?: SpeechStyle) => {
    return engine.current?.speakText(text, durationMs, style) ?? 0;
  }, []);

  const speakCharacters = useCallback(
    (chars: string[], startsSec: number[], endsSec: number[], intensity?: number, clock?: () => number) => {
      engine.current?.speakCharacters(chars, startsSec, endsSec, intensity, clock);
    },
    [],
  );

  const speakPhonemes = useCallback(
    (phonemes: Array<{ phoneme: string; startTime: number; endTime: number }>) => {
      engine.current?.speakPhonemes(phonemes);
    },
    [],
  );

  const speakCharacterStream = useCallback((intensity?: number, clock?: () => number) => {
    return engine.current!.speakCharacterStream(intensity, clock);
  }, []);

  const stopSpeaking = useCallback(() => {
    engine.current?.stop();
  }, []);

  return { speak, speakCharacters, speakCharacterStream, speakPhonemes, stopSpeaking };
}
