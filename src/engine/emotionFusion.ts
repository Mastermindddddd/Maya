/**
 * Emotion fusion — face + context → one reading every 2 s
 * ───────────────────────────────────────────────────────
 * The face is only trusted for emotions it has proven it can detect:
 *   • with no trained model: smiles (excited) only — the rules aren't reliable for
 *     frustration or confusion (on DAiSEE they were right ~1 time in 6)
 *   • with a trained model: each emotion whose measured precision (how often Maya is
 *     right when she reacts) is at least FACE_MIN_PRECISION
 * Context evidence (contextSignals.ts) is always trusted. When face and context agree,
 * the evidence is stronger than either alone.
 *
 * FusedEmotionDetector is an EmotionDetector, so it plugs into useEmotionReactions.
 */

import { DETECT_INTERVAL_MS, EmotionDetector, EmotionReading } from './emotion';
import { EMOTION_MODEL, EmotionModel } from './emotionModel';
import type { ContextEvidence, Emotion } from './contextSignals';

const FACE_MIN_PRECISION = 0.5;
const FACE_MAX_AGE_MS    = 5000;  // ignore face readings older than this (camera paused, no face)
const AGREEMENT_BONUS    = 0.3;

export type FaceTrust = Record<Emotion, number>;

/** How much to trust the face for each emotion, from the trained model's evaluation */
export function faceTrust(model: EmotionModel | null): FaceTrust {
  if (!model?.trained || !Array.isArray(model.classes)) return { excited: 1, frustrated: 0, confused: 0 };
  const precision = (model as EmotionModel & { evaluation?: { precision?: Record<string, number> } })
    .evaluation?.precision ?? {};
  const trusted = (e: Emotion) => (precision[e] ?? 0) >= FACE_MIN_PRECISION ? 1 : 0;
  return {
    // Emotions the model wasn't trained on come from the rules: only smiles are trusted
    excited:    model.classes.includes('excited') ? trusted('excited') : 1,
    frustrated: trusted('frustrated'),
    confused:   trusted('confused'),
  };
}
export const FACE_TRUST = faceTrust(EMOTION_MODEL);
export const TRUST_ALL: FaceTrust = { excited: 1, frustrated: 1, confused: 1 };  // test chips

export type FusionInfo = { emotion: Emotion | null; score: number; reason: string };

export class FusedEmotionDetector implements EmotionDetector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private face: { reading: EmotionReading; at: number } | null = null;
  onInfo?: (info: FusionInfo) => void;

  constructor(
    private faceSource: EmotionDetector | null,
    private context: ContextEvidence,
    private trust: FaceTrust = FACE_TRUST,
    private now: () => number = Date.now,
  ) {}

  start(onReading: (reading: EmotionReading) => void) {
    this.stop();
    this.faceSource?.start(reading => { this.face = { reading, at: this.now() }; });
    this.timer = setInterval(() => onReading(this.read()), DETECT_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.faceSource?.stop();
    this.face = null;
  }

  /** One combined reading (also used directly in tests) */
  read(): EmotionReading {
    const ctx = this.context.current();
    const face = this.face && this.now() - this.face.at <= FACE_MAX_AGE_MS ? this.face.reading : null;
    let best: { emotion: Emotion; score: number; reason: string } | null = null;
    for (const emotion of ['frustrated', 'confused', 'excited'] as Emotion[]) {
      const fromFace = face?.emotion === emotion ? face.confidence * this.trust[emotion] : 0;
      const fromContext = ctx[emotion];
      const score = Math.min(1, Math.max(fromFace, fromContext) + AGREEMENT_BONUS * Math.min(fromFace, fromContext));
      if (score > (best?.score ?? 0)) {
        const reasons = [fromContext >= 0.2 ? this.context.reasonFor(emotion) : '', fromFace >= 0.2 ? `face looks ${emotion}` : ''];
        best = { emotion, score, reason: reasons.filter(Boolean).join(' + ') };
      }
    }
    this.onInfo?.(best ? { ...best } : { emotion: null, score: 0, reason: '' });
    return best ? { emotion: best.emotion, confidence: best.score } : { emotion: 'neutral', confidence: 0.7 };
  }
}
