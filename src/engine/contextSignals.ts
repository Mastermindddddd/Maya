/**
 * Context signals — what the student says and does
 * ────────────────────────────────────────────────
 * In tutoring, the clearest signs of frustration and confusion aren't on the face:
 * wrong answers in a row, "I don't get it", asking the same thing again, or going quiet
 * after a question. Each of these adds evidence for an emotion; evidence fades with a
 * 30 s half-life, so Maya responds to how things are going now, not ten minutes ago.
 *
 * ContextEvidence is pure logic (no React); useContextSignals feeds it from the session.
 */

import type { StudentEmotion } from './emotion';

export type Emotion = Exclude<StudentEmotion, 'neutral'>;
const EMOTIONS: Emotion[] = ['frustrated', 'confused', 'excited'];
const HALF_LIFE_MS = 30_000;

// ── What the student says ─────────────────────────────────────────────────
// Checked in this order; the first match wins (frustration outranks confusion).
const PHRASES: [Emotion, number, RegExp, string][] = [
  ['frustrated', 0.9, /\b(i give up|i can'?t do (this|it)|i hate (this|math|maths)|forget it|this is (so |too |really )?(hard|impossible|annoying|stupid|pointless)|i'?m (so |just )?(bad|stupid|dumb|useless) at|i'?ll never (get|understand)|ugh+|argh+)\b/i, 'sounded frustrated'],
  ['confused',   0.8, /\b(i (still )?(don'?t|didn'?t|do not|did not) (really )?(understand|get (it|this|that|why|how|what))|i'?m (so |really |a bit )?(confused|lost)|what do you mean|(that|this|it) (makes|made) no sense|(doesn'?t|does not|didn'?t|did not) make (any )?sense|wait,? what|huh|can you (explain|say|repeat) (that|it|this)( again)?|say that again|not sure (how|what|why|where)|how did you get)\b/i, 'sounded confused'],
  ['excited',    0.7, /\b(i (get|got) it|oh,? i see|(that|it) makes sense( now)?|i did it|(yes|yay|awesome|nice|cool)\b!*|that was easy|now i understand)\b/i, 'sounded pleased'],
];
const NEGATED = /\b(not|don'?t|doesn'?t|didn'?t|never|no)\b/i;

/** The emotion a student message signals, if any */
export function phraseSignal(text: string): { emotion: Emotion; weight: number; reason: string } | null {
  for (const [emotion, weight, pattern, reason] of PHRASES) {
    if (!pattern.test(text)) continue;
    // "that doesn't make sense" shouldn't count as pleased
    if (emotion === 'excited' && NEGATED.test(text)) continue;
    return { emotion, weight, reason };
  }
  return null;
}

// ── Asking the same thing again ────────────────────────────────────────────
const STOPWORDS = new Set(('a an the is are was were be do does did can could would you me i my it this that ' +
  'to of in on for with and or so what how why please again just about').split(' '));
const words = (text: string) => new Set(
  text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w)),
);

/** How alike two messages are (0–1, by shared meaningful words) */
export function similarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  A.forEach(w => { if (B.has(w)) shared++; });
  return shared / (A.size + B.size - shared);
}

// ── Evidence ──────────────────────────────────────────────────────────────
const REPEAT_SIMILARITY = 0.5;
const REPEAT_WEIGHT     = 0.6;
const SILENCE_WEIGHT    = 0.4;
const WRONG_WEIGHT      = 0.3;   // per wrong answer in the current streak: 0.3, then +0.6, then +0.9
const CORRECT_WEIGHT    = 0.35;
const BREAKTHROUGH      = 0.8;   // right after getting it wrong: a real "I got it" moment

export class ContextEvidence {
  private score: Record<Emotion, number> = { frustrated: 0, confused: 0, excited: 0 };
  private reason: Record<Emotion, string> = { frustrated: '', confused: '', excited: '' };
  private updated = 0;
  private wrongStreak = 0;
  private questions: string[] = [];

  constructor(private now: () => number = Date.now) {}

  /** Current evidence per emotion (0–1), after fading */
  current(): Record<Emotion, number> {
    this.decay();
    return { ...this.score };
  }

  reasonFor(emotion: Emotion) { return this.reason[emotion]; }

  studentSaid(text: string) {
    const phrase = phraseSignal(text);
    if (phrase) this.add(phrase.emotion, phrase.weight, phrase.reason);
    // Only questions can be "asked again"
    if (/\?\s*$/.test(text.trim()) || /^(how|why|what|can|could|is|does|do)\b/i.test(text.trim())) {
      if (this.questions.some(q => similarity(q, text) >= REPEAT_SIMILARITY)) {
        this.add('confused', REPEAT_WEIGHT, 'asked the same question again');
      }
      this.questions = [...this.questions.slice(-5), text];
    }
  }

  answered(correct: boolean) {
    if (correct) {
      this.add('excited', this.wrongStreak > 0 ? BREAKTHROUGH : CORRECT_WEIGHT,
               this.wrongStreak > 0 ? 'got it right after struggling' : 'answered correctly');
      this.wrongStreak = 0;
      // Getting it right resolves most of the frustration and confusion
      this.score.frustrated *= 0.4;
      this.score.confused *= 0.4;
    } else {
      this.wrongStreak++;
      this.add('frustrated', WRONG_WEIGHT * Math.min(this.wrongStreak, 3),
               this.wrongStreak > 1 ? `${this.wrongStreak} wrong answers in a row` : 'wrong answer');
    }
  }

  /** No reply long after Maya asked a question */
  wentQuiet() {
    this.add('confused', SILENCE_WEIGHT, 'went quiet after a question');
  }

  reset() {
    this.score = { frustrated: 0, confused: 0, excited: 0 };
    this.wrongStreak = 0;
    this.questions = [];
  }

  private add(emotion: Emotion, weight: number, reason: string) {
    this.decay();
    this.score[emotion] = Math.min(1, this.score[emotion] + weight);
    this.reason[emotion] = reason;
  }

  private decay() {
    const t = this.now();
    if (this.updated) {
      const k = Math.pow(0.5, (t - this.updated) / HALF_LIFE_MS);
      EMOTIONS.forEach(e => { this.score[e] *= k; });
    }
    this.updated = t;
  }
}
