/**
 * LipSyncEngine
 * ─────────────
 * Converts phoneme / character timing data into CC4 viseme shape key
 * weights, driven frame-by-frame.
 *
 * Three modes:
 *   1. speakText       — simulated visemes from plain text (prototype)
 *   2. speakCharacters — per-character timings (e.g. an alignment array from a TTS API)
 *   3. speakPhonemes   — ARPAbet phoneme timestamps
 *
 * CC4 Viseme → sound mapping used here (verify visually: drive each viseme to 1 and look):
 *   V_Open        → A, Ah, Aa, Ae (open mouth)
 *   V_Explosive   → B, P, T, D, K, G (plosives)
 *   V_Dental_Lip  → F, V (labiodental)
 *   V_Tight_O     → O, Oh, Ow, Oo, W
 *   V_Tight       → R, Uh (tight round)
 *   V_Wide        → E, Ee, Ih, Iy, L, Y (wide mouth)
 *   V_Affricate   → Ch, J, Sh, Zh, S, Z
 *   V_Lip_Open    → M, N, Ng
 *
 * Usage:
 *   const { speak, stopSpeaking } = useLipSync();
 *   speak("Hello, how are you?");
 */
 
import { useEffect, useRef, useCallback } from 'react';
import type { VisemeWeights } from '../components/AvatarRenderer';
import { useSessionStore } from '../store/sessionStore';
 
type SetVisemeFn = (weights: VisemeWeights) => void;
type Frame = { time: number; weights: VisemeWeights };
 
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
  // Plosives
  'B': 'V_Explosive', 'P': 'V_Explosive', 'T': 'V_Explosive',
  'D': 'V_Explosive', 'K': 'V_Explosive', 'G': 'V_Explosive',
  // Labiodentals
  'F': 'V_Dental_Lip', 'V': 'V_Dental_Lip',
  // Affricates and sibilants
  'CH': 'V_Affricate', 'JH': 'V_Affricate', 'SH': 'V_Affricate',
  'ZH': 'V_Affricate', 'S':  'V_Affricate', 'Z':  'V_Affricate',
  'TH': 'V_Affricate', 'DH': 'V_Affricate',
  // Nasals
  'M': 'V_Lip_Open', 'N': 'V_Lip_Open', 'NG': 'V_Lip_Open',
  // Liquids and glides (approximate)
  'L': 'V_Wide', 'R': 'V_Tight', 'Y': 'V_Wide',
  'HH': 'V_Open',
  // Silence
  'SIL': null, 'SP': null,
};
 
// ── Character → viseme (order matters: first match wins) ──────────────────
// Kept consistent with the phoneme table above.
const CHAR_VISEME: Array<[RegExp, string]> = [
  [/[a]/i,           'V_Open'       ],
  [/[ouw]/i,         'V_Tight_O'    ],
  [/[eiyl]/i,        'V_Wide'       ],
  [/[r]/i,           'V_Tight'      ],
  [/[mn]/i,          'V_Lip_Open'   ],
  [/[fv]/i,          'V_Dental_Lip' ],
  [/[sz]/i,          'V_Affricate'  ],
  [/[bpdtkgcqx]/i,   'V_Explosive'  ],
];
 
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
  speakText(text: string, durationMs: number = text.length * 55) {
    this.stop();
    const chars     = text.replace(/\s+/g, ' ').split('');
    if (chars.length === 0) return;
    const msPerChar = durationMs / chars.length;
    const frames: Frame[] = [];
 
    chars.forEach((char, i) => {
      this.pushCharFrames(frames, char, i * msPerChar, msPerChar);
    });
    frames.push({ time: durationMs, weights: {} });
    this.playFrames(frames);
  }
 
  // ── Mode 2: per-character timings (seconds), e.g. from a TTS alignment ─
  speakCharacters(chars: string[], startsSec: number[], endsSec: number[]) {
    this.stop();
    if (chars.length === 0) return;
    const frames: Frame[] = [];
 
    chars.forEach((char, i) => {
      const start = (startsSec[i] ?? 0) * 1000;
      const dur   = Math.max(0, ((endsSec[i] ?? startsSec[i] ?? 0) - (startsSec[i] ?? 0)) * 1000);
      this.pushCharFrames(frames, char, start, dur);
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
 
  // ── Internal: ramp frames for one character ───────────────────────────
  private pushCharFrames(frames: Frame[], char: string, startMs: number, durMs: number) {
    const key = this.charToViseme(char);
    if (key) {
      frames.push({ time: startMs,              weights: this.singleViseme(key, 0.3)  });
      frames.push({ time: startMs + durMs * 0.4, weights: this.singleViseme(key, 0.85) });
      frames.push({ time: startMs + durMs * 0.7, weights: this.singleViseme(key, 0.6)  });
    } else {
      // Space / punctuation: close the mouth
      frames.push({ time: startMs, weights: {} });
    }
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
 
  private charToViseme(char: string): string | null {
    for (const [pattern, key] of CHAR_VISEME) {
      if (pattern.test(char)) return key;
    }
    return null;
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
    engine.current?.speakText(text, durationMs);
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
 