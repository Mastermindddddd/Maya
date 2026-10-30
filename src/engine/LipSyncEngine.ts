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

const textUnits = (text: string): Unit[] => {
  const spoken = text.toLowerCase().replace(/[+=×÷²³%0-9]/g, ch => SPOKEN[ch] ?? ' ');
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

  constructor(setViseme: SetVisemeFn) {
    this.setViseme = setViseme;
  }

  // ── Mode 1: animate visemes from plain text ──────────────────────────
  // Returns how long the speech lasts (ms). Pass durationMs to fit it to a known audio length.
  speakText(text: string, durationMs?: number): number {
    this.stop();
    const units = textUnits(text);
    if (units.length === 0) return 0;
    const natural = units.reduce((sum, u) => sum + u.ms, 0);
    const scale   = durationMs ? durationMs / natural : 1;
    const frames: Frame[] = [];
    let t = 0;
    for (const u of units) {
      frames.push({ time: t, weights: this.singleViseme(u.key, u.weight) });
      t += u.ms * scale;
    }
    frames.push({ time: t, weights: {} });
    this.playFrames(frames);
    return t;
  }

  // ── Mode 2: per-character timings (seconds), e.g. from a TTS alignment ─
  speakCharacters(chars: string[], startsSec: number[], endsSec: number[]) {
    this.stop();
    if (chars.length === 0) return;
    const frames: Frame[] = [];

    chars.forEach((char, i) => {
      const start = (startsSec[i] ?? 0) * 1000;
      const shape = charShape(char);
      // Spaces/punctuation and B/P/M all close the mouth
      frames.push({ time: start, weights: shape ? this.singleViseme(shape[0], shape[1]) : {} });
    });

    const lastEnd = (endsSec[endsSec.length - 1] ?? 0) * 1000;
    frames.push({ time: lastEnd + 80, weights: {} });
    this.playFrames(frames);
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
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.isRunning = false;
    this.setViseme({});
  }

  // ── Internal: frame player ─────────────────────────────────────────────
  private playFrames(frames: Frame[]) {
    if (frames.length === 0) return;
    // Frames must be in time order
    this.schedule  = [...frames].sort((a, b) => a.time - b.time);
    this.startTime = performance.now();
    this.isRunning = true;
    let frameIdx    = 0;
    let lastApplied = -1;
    const lastIdx   = this.schedule.length - 1;

    const tick = () => {
      if (!this.isRunning) return;
      const elapsed = performance.now() - this.startTime;

      while (frameIdx < lastIdx && this.schedule[frameIdx + 1].time <= elapsed) {
        frameIdx++;
      }

      if (frameIdx >= lastIdx) {
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

  const speak = useCallback((text: string, durationMs?: number) => {
    return engine.current?.speakText(text, durationMs) ?? 0;
  }, []);

  const speakCharacters = useCallback(
    (chars: string[], startsSec: number[], endsSec: number[]) => {
      engine.current?.speakCharacters(chars, startsSec, endsSec);
    },
    [],
  );

  const speakPhonemes = useCallback(
    (phonemes: Array<{ phoneme: string; startTime: number; endTime: number }>) => {
      engine.current?.speakPhonemes(phonemes);
    },
    [],
  );

  const stopSpeaking = useCallback(() => {
    engine.current?.stop();
  }, []);

  return { speak, speakCharacters, speakPhonemes, stopSpeaking };
}
