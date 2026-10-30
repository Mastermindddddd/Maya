/**
 * ExpressionClassifier
 * ────────────────────
 * Turns MediaPipe FaceLandmarker blendshapes (52 ARKit-style scores, 0–1) into a
 * StudentEmotion reading. Rule-based, no training needed:
 *
 *   excited    — smiling, cheeks raised, eyes open wide
 *   frustrated — brows pulled down, lips pressed or corners down, nose wrinkled
 *   confused   — one brow up more than the other, mouth pulled to one side or pursed,
 *                head tilted; brows down a little
 *
 * Faces differ at rest (some brows sit low, some mouths turn down), so every score is
 * measured against the student's own resting face. That baseline is learned quickly
 * over the first readings and then drifts slowly, but only while they look neutral,
 * so it never adapts to a mood that lasts.
 *
 * The weights are a starting point: tune them against real students (see `scores`).
 * Once training/train.py has produced assets/emotion-model.json, the trained model
 * replaces the rules (see `decide`); classes it wasn't trained on still use the rules.
 */

import type { EmotionReading, StudentEmotion } from './emotion';
import { EMOTION_MODEL, EmotionModel, predictProbabilities } from './emotionModel';

export type Blendshapes = Record<string, number>;
export type FaceSample  = { blendshapes: Blendshapes; roll: number };  // roll: head tilt in radians

const WARMUP_SAMPLES   = 4;     // first readings (~8 s) set the resting face
const WARMUP_RATE      = 0.35;
const DRIFT_RATE       = 0.03;  // afterwards the baseline follows slowly (~1 min)
const NEUTRAL_SCORE    = 0.15;  // below this the face counts as neutral
const FULL_SCORE       = 0.6;   // score that maps to full confidence

export type EmotionScores = Record<Exclude<StudentEmotion, 'neutral'>, number>;

export class ExpressionClassifier {
  private baseline: Blendshapes = {};
  private baseRoll = 0;
  private samples = 0;
  lastScores: EmotionScores = { excited: 0, frustrated: 0, confused: 0 };

  constructor(private model: EmotionModel | null = EMOTION_MODEL) {}

  /** The resting face the readings are currently compared with (saved with check-ins) */
  snapshot() {
    return { baseline: { ...this.baseline }, baseRoll: this.baseRoll, warm: this.samples < WARMUP_SAMPLES };
  }

  reset() {
    this.baseline = {};
    this.baseRoll = 0;
    this.samples = 0;
  }

  classify(face: FaceSample | null): EmotionReading {
    // No face in view: nothing to react to
    if (!face) return { emotion: 'neutral', confidence: 0 };

    const warming = this.samples < WARMUP_SAMPLES;
    const reading = this.decide(face);
    const neutral = reading.emotion === 'neutral';

    // Learn the resting face: fast at first, then slowly and only while neutral
    if (warming || neutral) this.learn(face, warming ? WARMUP_RATE : DRIFT_RATE);
    this.samples++;

    return warming ? { emotion: 'neutral', confidence: 0.7 } : reading;
  }

  /** One reading, relative to the current resting face: trained model if there is one, else rules */
  private decide(face: FaceSample): EmotionReading {
    const scores = this.scores(face);
    this.lastScores = scores;
    const [ruleEmotion, score] = (Object.entries(scores) as [StudentEmotion, number][])
      .reduce((best, e) => (e[1] > best[1] ? e : best));
    const rules: EmotionReading = score < NEUTRAL_SCORE
      ? { emotion: 'neutral', confidence: 0.7 }
      : { emotion: ruleEmotion, confidence: Math.min(1, score / FULL_SCORE) };

    const model = this.model;
    if (!model) return rules;
    // Emotions the model was never trained on (DAiSEE has no "excited") still come from the rules
    if (rules.emotion !== 'neutral' && !model.classes.includes(rules.emotion) &&
        rules.confidence >= (model.minProbability ?? 0.45)) {
      return rules;
    }
    const x = model.features.map(name => name === 'roll'
      ? face.roll - this.baseRoll
      : (face.blendshapes[name] ?? 0) - (this.baseline[name] ?? 0));
    const p = predictProbabilities(model, x);
    const k = p.indexOf(Math.max(...p));
    // Not sure enough to react: treat as neutral (the threshold is chosen in training)
    if (model.classes[k] === 'neutral' || p[k] < (model.minProbability ?? 0.45)) return { emotion: 'neutral', confidence: 0.7 };
    return { emotion: model.classes[k], confidence: p[k] };
  }

  /** Raw scores per emotion, relative to the resting face */
  scores({ blendshapes: b, roll }: FaceSample): EmotionScores {
    const base = this.baseline;
    const f    = (name: string) => Math.max(0, (b[name] ?? 0) - (base[name] ?? 0));
    const pair = (name: string) => (f(`${name}Left`) + f(`${name}Right`)) / 2;

    const smile     = pair('mouthSmile');
    const cheek     = pair('cheekSquint');
    const eyeWide   = pair('eyeWide');
    const browDown  = pair('browDown');
    const press     = pair('mouthPress');
    const frown     = pair('mouthFrown');
    const sneer     = pair('noseSneer');
    const asymNow   = Math.abs((b.browOuterUpLeft ?? 0) - (b.browOuterUpRight ?? 0));
    const asymRest  = Math.abs((base.browOuterUpLeft ?? 0) - (base.browOuterUpRight ?? 0));
    const browAsym  = Math.max(0, asymNow - asymRest);
    const mouthSide = Math.max(f('mouthLeft'), f('mouthRight'));
    const pucker    = f('mouthPucker');
    const tilt      = Math.abs(roll - this.baseRoll);

    return {
      excited:    1.6 * smile + 0.5 * cheek + 0.3 * eyeWide,
      frustrated: 1.3 * browDown + 0.9 * press + 0.8 * frown + 0.6 * sneer - 1.0 * smile,
      confused:   1.4 * browAsym + 0.6 * browDown + 0.8 * mouthSide + 0.5 * pucker + 1.5 * tilt
                  - 0.8 * smile - 0.5 * press,
    };
  }

  private learn({ blendshapes, roll }: FaceSample, rate: number) {
    for (const [name, value] of Object.entries(blendshapes)) {
      const current = this.baseline[name];
      this.baseline[name] = current === undefined ? value : current + (value - current) * rate;
    }
    this.baseRoll = this.samples === 0 ? roll : this.baseRoll + (roll - this.baseRoll) * rate;
  }
}
