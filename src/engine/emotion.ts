/**
 * Student emotion → tutor reaction
 * ────────────────────────────────
 *   detector (every 2 s) → EmotionStateMachine → TutorReaction → avatar
 *
 * The detector is pluggable (EmotionDetector). The state machine only switches when a
 * reading repeats, holds each reaction for a while, and needs a run of calm readings
 * before relaxing, so one odd frame never makes Maya change face.
 *
 * Each reaction sets three things:
 *   expression — blend shapes added on top of the phase expression (AvatarRenderer)
 *   posture    — lean forward / head tilt, in degrees (AvatarRenderer life rig)
 *   speech     — pace and mouth intensity (LipSyncEngine; later the TTS voice settings)
 */

import type { ExpressionWeights } from '../components/AvatarRenderer';

export type StudentEmotion = 'neutral' | 'frustrated' | 'confused' | 'excited';
export type TutorReaction  = 'neutral' | 'encouraging' | 'questioning' | 'affirming';

export const REACTION_FOR: Record<StudentEmotion, TutorReaction> = {
  neutral:    'neutral',
  frustrated: 'encouraging',
  confused:   'questioning',
  excited:    'affirming',
};

export type SpeechStyle = { rate: number; intensity: number };

export const REACTIONS: Record<TutorReaction, {
  expression: ExpressionWeights;
  lean:       number;  // degrees forward
  tilt:       number;  // degrees, head to one side
  speech:     SpeechStyle;
}> = {
  neutral: { expression: {}, lean: 0, tilt: 0, speech: { rate: 1, intensity: 1 } },
  // Frustrated → warm, gentle: soft smile, sympathetic inner brows; slower, softer speech
  encouraging: {
    expression: {
      Mouth_Smile_L: 0.35, Mouth_Smile_R: 0.35,
      Brow_Raise_Inner_L: 0.35, Brow_Raise_Inner_R: 0.35,
      Eye_Squint_L: 0.15, Eye_Squint_R: 0.15,
    },
    lean: 2, tilt: 3,
    speech: { rate: 0.85, intensity: 0.8 },
  },
  // Confused → lean in with a questioning look: one brow up, the other slightly drawn
  questioning: {
    expression: {
      Brow_Raise_Outer_L: 0.6, Brow_Raise_Inner_L: 0.35, Brow_Raise_Inner_R: 0.15,
      Brow_Compress_R: 0.2, Mouth_Smile_L: 0.1,
    },
    lean: 7, tilt: 6,
    speech: { rate: 0.92, intensity: 0.95 },
  },
  // Excited / correct → bright smile with raised cheeks, plus a nod (see useEmotionReactions)
  affirming: {
    expression: {
      Mouth_Smile_L: 0.8, Mouth_Smile_R: 0.8,
      Cheek_Raise_L: 0.55, Cheek_Raise_R: 0.55,
      Brow_Raise_Outer_L: 0.35, Brow_Raise_Outer_R: 0.35,
      Eye_Squint_L: 0.25, Eye_Squint_R: 0.25,
    },
    lean: 0, tilt: 0,
    speech: { rate: 1.08, intensity: 1.1 },
  },
};

// ── Detector interface ─────────────────────────────────────────────────────
export const DETECT_INTERVAL_MS = 2000;

export type EmotionReading = { emotion: StudentEmotion; confidence: number };

/** Produces a reading about every DETECT_INTERVAL_MS until stopped. */
export interface EmotionDetector {
  start(onReading: (reading: EmotionReading) => void): void | Promise<void>;
  stop(): void;
}

/** Test detector: reports whatever emotion was last set (the debug chips drive it). */
export class ManualEmotionDetector implements EmotionDetector {
  private emotion: StudentEmotion = 'neutral';
  private timer: ReturnType<typeof setInterval> | null = null;

  set(emotion: StudentEmotion) { this.emotion = emotion; }

  start(onReading: (reading: EmotionReading) => void) {
    this.stop();
    this.timer = setInterval(() => onReading({ emotion: this.emotion, confidence: 0.7 }), DETECT_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ── State machine ──────────────────────────────────────────────────────────
const MIN_CONFIDENCE     = 0.45;  // below this a reading counts as neutral
const INSTANT_CONFIDENCE = 0.85;  // a reading this sure switches without waiting for a repeat
const CONFIRM_READINGS   = 2;     // same emotion twice in a row (~4 s) to react
const RELAX_READINGS     = 3;     // calm three times in a row (~6 s) to go back to neutral
const MIN_HOLD_MS        = 6000;  // keep a reaction at least this long

export class EmotionStateMachine {
  private reaction: TutorReaction = 'neutral';
  private since = -Infinity;
  private candidate: StudentEmotion | null = null;
  private streak = 0;

  constructor(
    private onChange: (reaction: TutorReaction, emotion: StudentEmotion) => void,
    private now: () => number = Date.now,
  ) {}

  get current() { return this.reaction; }

  push({ emotion, confidence }: EmotionReading) {
    const e = confidence >= MIN_CONFIDENCE ? emotion : 'neutral';
    if (e === this.candidate) this.streak++;
    else { this.candidate = e; this.streak = 1; }

    const target = REACTION_FOR[e];
    if (target === this.reaction) return;
    if (this.now() - this.since < MIN_HOLD_MS) return;
    const needed = target === 'neutral' ? RELAX_READINGS : CONFIRM_READINGS;
    if (this.streak < needed && !(e !== 'neutral' && confidence >= INSTANT_CONFIDENCE)) return;

    this.reaction = target;
    this.since = this.now();
    this.onChange(target, e);
  }

  reset() {
    this.reaction = 'neutral';
    this.since = -Infinity;
    this.candidate = null;
    this.streak = 0;
  }
}
