/**
 * TurnDetector — when the student starts and stops talking
 * ────────────────────────────────────────────────────────
 * Fed one frame at a time (~32 ms) with Silero VAD's speech probability and the frame's
 * loudness (dBFS), from VoiceBridge. Decides:
 *
 *   speechStart  the student started talking (≥ 90 ms of clear speech: Silero itself scores coughs
 *                and clicks as non-speech, and one-word answers like "yes" are short)
 *   endLikely    250 ms of silence: probably done — start preparing a reply (speculatively)
 *   resumed      they kept talking after endLikely: throw the speculative work away
 *   endOfTurn    600 ms of silence: their turn is over (pauses shorter than this are part of the turn)
 *   bargeIn      the student talked over Maya: stop her
 *   ignored      a sound that wasn't the student talking (too short, or too quiet: a TV, someone far away)
 *
 * Background speech (TV, other people): the student, at the phone, is the loudest voice. Their
 * speaking level is learned from their own turns, and speech much quieter than it doesn't count.
 * Until they've spoken, speech must at least be clearly louder than the room's background level
 * (learned while nobody is talking), so a TV can be mistaken for them only before their first turn.
 *
 * Maya's own voice comes back through the microphone, so while she talks the bar is higher:
 * louder than her echo and sustained longer (barge-in).
 *
 * Pure logic (no React, no audio), so it can be tested with recorded frames.
 */

export type VadFrame = { p: number; db: number; t: number };  // speech probability 0–1, dBFS, ms

export type TurnEvent =
  | { type: 'speechStart'; t: number }
  | { type: 'endLikely'; t: number }
  | { type: 'resumed'; t: number }
  | { type: 'endOfTurn'; t: number; speechMs: number; forced: boolean }
  | { type: 'bargeIn'; t: number }
  | { type: 'ignored'; t: number; reason: 'too short' | 'too quiet' };

export const TURN_DEFAULTS = {
  startProb:       0.6,     // Silero probability to count as speech when starting…
  stayProb:        0.35,    // …and to keep counting once speaking (hysteresis)
  minSpeechMs:     90,      // shorter bursts (under 3 frames) are ignored; Silero already rejects coughs (they score ~0)
  likelyEndMs:     250,     // silence after which a reply can start being prepared
  endSilenceMs:    600,     // silence that ends the turn; shorter pauses are mid-sentence
  marginDb:        10,      // speech must be this much louder than the background to start a turn…
  stayMarginDb:    4,       // …but only this much to continue one (quiet syllables after a pause)
  minDb:           -55,     // …and at least this loud at all
  floorWindowMs:   8000,    // background level = quiet end of the last 8 s
  maxTurnMs:       30_000,  // a turn this long is probably a TV that slipped through
  bargeInMs:       400,     // talking over Maya must last this long…
  bargeInMarginDb: 6,       // …and be this much louder than her echo
  studentRangeDb:  16,      // once the student's own level is known, speech quieter than it by
                            // more than this (a TV, someone across the room) doesn't count;
  studentStartDb:  12,      // and a new turn's opening must average within this of their level
                            // (a TV's loud syllables can pass one by one, but not on average)
};
export type TurnOptions = typeof TURN_DEFAULTS;
const ECHO_WINDOW_MS = 3000;
const ECHO_WARMUP_MS = 300;

export class TurnDetector {
  private o: TurnOptions;
  private speaking = false;
  private tutorSpeaking = false;
  private candidateStart = -1;
  private candidateMs = 0;
  private candidateDb: number[] = [];
  private quietSpeechMs = 0;      // speech-like but too quiet: background talk
  private reportedQuiet = false;
  private dips = 0;               // frames below threshold inside a candidate
  private turnStart = 0;
  private lastSpeech = 0;
  private speechMs = 0;
  private likelySent = false;
  private lastT = -1;
  private frameMs = 32;
  private recent: { t: number; db: number }[] = [];
  private floor = -60;
  private echo: { t: number; db: number }[] = [];  // Maya's voice coming back through the mic
  private echoDb = -90;
  private studentDb = -Infinity;    // how loud the student talks (learned from their turns)
  private turnLevels: number[] = []; // loudness of this turn's speech frames

  constructor(private onEvent: (e: TurnEvent) => void, options: Partial<TurnOptions> = {}) {
    this.o = { ...TURN_DEFAULTS, ...options };
  }

  /** Background level the detector has learned (dBFS) */
  get backgroundDb() { return this.floor; }
  get isSpeaking() { return this.speaking; }

  setTutorSpeaking(on: boolean) {
    if (on && !this.tutorSpeaking) { this.echo = []; this.echoDb = -90; }
    this.tutorSpeaking = on;
  }

  push({ p, db, t }: VadFrame) {
    if (this.lastT >= 0) this.frameMs = Math.max(1, Math.min(100, t - this.lastT));
    this.lastT = t;
    const o = this.o;

    // Learn the background level while nobody is talking (frozen during a turn)
    if (!this.speaking && !this.tutorSpeaking) {
      this.recent.push({ t, db });
      while (this.recent.length && t - this.recent[0].t > o.floorWindowMs) this.recent.shift();
      const sorted = this.recent.map(r => r.db).sort((a, b) => a - b);
      this.floor = sorted[Math.floor(sorted.length * 0.2)] ?? this.floor;
    }
    // Maya's echo level: the loud end (80th percentile) of the last 3 s of her speech, leaving
    // out frames that might be the student starting to talk over her
    if (this.tutorSpeaking && !this.speaking && this.candidateStart < 0) {
      this.echo.push({ t, db });
      while (this.echo.length && t - this.echo[0].t > ECHO_WINDOW_MS) this.echo.shift();
      const sorted = this.echo.map(r => r.db).sort((a, b) => a - b);
      this.echoDb = sorted[Math.floor(sorted.length * 0.8)] ?? this.echoDb;
    }
    // Until her echo has been measured, her own voice could look like an interruption
    const echoKnown = this.echo.length * this.frameMs >= ECHO_WARMUP_MS;
    if (this.tutorSpeaking && !this.speaking && !echoKnown) return;

    const bar = Math.max(o.minDb, this.floor + o.marginDb, this.studentDb - o.studentRangeDb,
      this.tutorSpeaking ? this.echoDb + o.bargeInMarginDb : -Infinity);
    const loud = db >= bar;
    const loudEnoughToContinue = db >= Math.max(o.minDb, this.floor + o.stayMarginDb, this.studentDb - o.studentRangeDb - 6);

    if (!this.speaking) this.idleFrame(p, loud, t, db);
    else this.speakingFrame(p, loudEnoughToContinue, t, db);
  }

  private idleFrame(p: number, loud: boolean, t: number, db: number) {
    const o = this.o;
    const needed = this.tutorSpeaking ? o.bargeInMs : o.minSpeechMs;
    if (p >= o.startProb && loud) {
      if (this.candidateStart < 0) this.candidateStart = t;
      this.candidateMs += this.frameMs;
      this.candidateDb.push(db);
      this.dips = 0;
      if (this.candidateMs >= needed) {
        // Judge the opening as a whole: once the student's level is known, it must average close to it
        const mean = this.candidateDb.reduce((a, b) => a + b, 0) / this.candidateDb.length;
        if (mean < this.studentDb - o.studentStartDb) {
          if (!this.tutorSpeaking) this.onEvent({ type: 'ignored', t, reason: 'too quiet' });
          this.resetCandidate();
          return;
        }
        this.speaking = true;
        this.turnStart = this.candidateStart;
        this.lastSpeech = t;
        this.speechMs = this.candidateMs;
        this.turnLevels = [];
        this.likelySent = false;
        if (this.tutorSpeaking) this.onEvent({ type: 'bargeIn', t });
        this.onEvent({ type: 'speechStart', t: this.candidateStart });
        this.resetCandidate();
      }
      return;
    }
    // Speech-like but not loud enough: someone in the background
    if (p >= o.startProb && !loud) {
      this.quietSpeechMs += this.frameMs;
      if (this.quietSpeechMs >= o.minSpeechMs && !this.reportedQuiet && !this.tutorSpeaking) {
        this.reportedQuiet = true;
        this.onEvent({ type: 'ignored', t, reason: 'too quiet' });
      }
    } else if (p < o.stayProb) {
      this.quietSpeechMs = 0;
      this.reportedQuiet = false;
    }
    // Up to three weak frames inside a candidate are allowed (dips between syllables, a "t" closing the mouth)
    if (this.candidateStart >= 0 && ++this.dips > 3) {
      if (this.candidateMs >= 2 * this.frameMs && !this.tutorSpeaking) {
        this.onEvent({ type: 'ignored', t, reason: 'too short' });
      }
      this.resetCandidate();
    }
  }

  private speakingFrame(p: number, loud: boolean, t: number, db: number) {
    const o = this.o;
    if (p >= o.stayProb && loud) {
      this.lastSpeech = t;
      this.speechMs += this.frameMs;
      this.turnLevels.push(db);
      if (this.likelySent) {
        this.likelySent = false;
        this.onEvent({ type: 'resumed', t });
      }
    }
    const silence = t - this.lastSpeech;
    const forced = t - this.turnStart >= o.maxTurnMs;
    if (silence >= o.likelyEndMs && !this.likelySent && !forced) {
      this.likelySent = true;
      this.onEvent({ type: 'endLikely', t });
    }
    if (silence >= o.endSilenceMs || forced) {
      this.speaking = false;
      this.learnStudentLevel();
      this.onEvent({ type: 'endOfTurn', t, speechMs: this.speechMs, forced });
    }
  }

  /** The student is the loudest voice (closest to the phone): raise the level at once when a
   *  louder turn comes, lower it only slowly (they may have moved back a little) */
  private learnStudentLevel() {
    if (this.turnLevels.length < 5) return;
    const sorted = [...this.turnLevels].sort((a, b) => a - b);
    const level = sorted[Math.floor(sorted.length * 0.7)];  // the turn's typical voiced loudness
    this.studentDb = level > this.studentDb || this.studentDb === -Infinity
      ? level
      : this.studentDb + (level - this.studentDb) * 0.2;
  }

  /** How loud the student talks (dBFS), once learned */
  get studentLevelDb() { return this.studentDb; }

  private resetCandidate() {
    this.candidateStart = -1;
    this.candidateMs = 0;
    this.candidateDb = [];
    this.dips = 0;
  }
}
