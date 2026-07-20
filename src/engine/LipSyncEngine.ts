/**
 * LipSyncEngine
 * ─────────────
 * Converts phoneme data from ElevenLabs / Deepgram into CC4
 * viseme shape key weights, driven frame-by-frame.
 *
 * Two modes:
 *   1. OFFLINE (prototype) — simulated viseme weights from text analysis
 *   2. ONLINE  (Phase 2)  — real phoneme timestamps from ElevenLabs
 *
 * CC4 Viseme → Phoneme mapping:
 *   V_Open        → A, Ah, Aa, Ae (open mouth)
 *   V_Explosive   → B, P, T, D, K, G (plosives)
 *   V_Dental_Lip  → F, V (labiodental)
 *   V_Tight_O     → O, Oh, Ow, Oo, W
 *   V_Tight       → Oh (tight round)
 *   V_Wide        → E, Ee, Ih, Iy (wide mouth)
 *   V_Affricate   → Ch, J, Sh, Zh, S, Z
 *   V_Lip_Open    → M, Mb, N, Ng (lip closure before open)
 *
 * Usage:
 *   const engine = new LipSyncEngine(setViseme);
 *   engine.speakText("Hello, how are you?");   // prototype mode
 *   engine.stop();
 */

import { VisemeWeights } from '../components/AvatarRenderer';

type SetVisemeFn = (weights: VisemeWeights) => void;

// ── Phoneme → CC4 viseme key mapping ─────────────────────────────────────
const PHONEME_TO_VISEME: Record<string, keyof VisemeWeights> = {
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
  // Nasals / lip closure
  'M': 'V_Lip_Open', 'N': 'V_Lip_Open', 'NG': 'V_Lip_Open',
  // Liquids and glides (approximate)
  'L': 'V_Wide', 'R': 'V_Tight', 'Y': 'V_Wide',
  'HH': 'V_Open',
  // Silence
  'SIL': null, 'SP': null,
};

// ── Prototype: simple character-based viseme approximation ────────────────
const CHAR_VISEME: Array<[RegExp, keyof VisemeWeights]> = [
  [/[aeiou]/i,               'V_Open'      ],
  [/[mbp]/i,                 'V_Lip_Open'  ],
  [/[fv]/i,                  'V_Dental_Lip'],
  [/[sz]/i,                  'V_Affricate' ],
  [/[ou]/i,                  'V_Tight_O'   ],
  [/[eiy]/i,                 'V_Wide'      ],
  [/[tdkgcqx]/i,             'V_Explosive' ],
];

// ── LipSyncEngine class ───────────────────────────────────────────────────
export class LipSyncEngine {
  private setViseme:   SetVisemeFn;
  private rafId:       number | null = null;
  private schedule:    Array<{ time: number; weights: VisemeWeights }> = [];
  private startTime:   number = 0;
  private isRunning:   boolean = false;

  constructor(setViseme: SetVisemeFn) {
    this.setViseme = setViseme;
  }

  // ── PROTOTYPE MODE: animate visemes from plain text ─────────────────
  speakText(text: string, durationMs: number = text.length * 55) {
    this.stop();
    const frames = this.buildFramesFromText(text, durationMs);
    this.playFrames(frames);
  }

  // ── ONLINE MODE: play from ElevenLabs phoneme timestamps ─────────────
  //  phonemes: [{ phoneme: 'AH', startTime: 0.0, endTime: 0.08 }, ...]
  speakPhonemes(phonemes: Array<{ phoneme: string; startTime: number; endTime: number }>) {
    this.stop();
    const frames: Array<{ time: number; weights: VisemeWeights }> = [];

    phonemes.forEach(({ phoneme, startTime, endTime }) => {
      const visemeKey = PHONEME_TO_VISEME[phoneme.toUpperCase()];
      const midTime   = (startTime + endTime) / 2;

      // Ramp up at start
      frames.push({ time: startTime * 1000, weights: this.singleViseme(visemeKey, 0.2) });
      // Peak at middle
      frames.push({ time: midTime   * 1000, weights: this.singleViseme(visemeKey, 0.9) });
      // Ramp down at end
      frames.push({ time: endTime   * 1000, weights: this.singleViseme(visemeKey, 0.1) });
    });

    // Final silence
    frames.push({ time: (phonemes.at(-1)?.endTime ?? 0) * 1000 + 80, weights: {} });
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

  // ── Internal: build viseme schedule from text characters ─────────────
  private buildFramesFromText(
    text: string,
    totalMs: number
  ): Array<{ time: number; weights: VisemeWeights }> {
    const chars    = text.replace(/\s+/g, ' ').split('');
    const msPerChar = totalMs / chars.length;
    const frames: Array<{ time: number; weights: VisemeWeights }> = [];
    let t = 0;

    chars.forEach(char => {
      const visemeKey = this.charToViseme(char);
      if (visemeKey) {
        // Ramp up
        frames.push({ time: t,               weights: this.singleViseme(visemeKey, 0.3) });
        frames.push({ time: t + msPerChar*0.4, weights: this.singleViseme(visemeKey, 0.85) });
        frames.push({ time: t + msPerChar*0.7, weights: this.singleViseme(visemeKey, 0.6) });
      } else {
        // Space / punctuation — close mouth
        frames.push({ time: t, weights: {} });
      }
      t += msPerChar;
    });

    frames.push({ time: totalMs, weights: {} });
    return frames;
  }

  // ── Internal: frame player ─────────────────────────────────────────────
  private playFrames(frames: Array<{ time: number; weights: VisemeWeights }>) {
    if (frames.length === 0) return;
    this.schedule  = frames;
    this.startTime = performance.now();
    this.isRunning = true;
    let frameIdx   = 0;

    const tick = () => {
      if (!this.isRunning) return;
      const elapsed = performance.now() - this.startTime;

      // Advance through scheduled frames
      while (frameIdx < this.schedule.length - 1 &&
             this.schedule[frameIdx + 1].time <= elapsed) {
        frameIdx++;
      }

      if (frameIdx >= this.schedule.length - 1) {
        // Finished
        this.setViseme({});
        this.isRunning = false;
        return;
      }

      this.setViseme(this.schedule[frameIdx].weights);
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  private singleViseme(key: keyof VisemeWeights | null | undefined, weight: number): VisemeWeights {
    if (!key) return {};
    return { [key]: weight } as VisemeWeights;
  }

  private charToViseme(char: string): keyof VisemeWeights | null {
    for (const [pattern, key] of CHAR_VISEME) {
      if (pattern.test(char)) return key;
    }
    return null;
  }
}

// ── React hook wrapping the engine ────────────────────────────────────────
import { useRef, useCallback } from 'react';
import { useSessionStore } from '../store/sessionStore';

export function useLipSync() {
  const setViseme = useSessionStore(s => s.setViseme);
  const engine    = useRef<LipSyncEngine | null>(null);

  if (!engine.current) {
    engine.current = new LipSyncEngine(setViseme);
  }

  const speak = useCallback((text: string, durationMs?: number) => {
    engine.current?.speakText(text, durationMs);
  }, [setViseme]);

  const speakPhonemes = useCallback(
    (phonemes: Array<{ phoneme: string; startTime: number; endTime: number }>) => {
      engine.current?.speakPhonemes(phonemes);
    },
    [setViseme]
  );

  const stopSpeaking = useCallback(() => {
    engine.current?.stop();
  }, []);

  return { speak, speakPhonemes, stopSpeaking };
}