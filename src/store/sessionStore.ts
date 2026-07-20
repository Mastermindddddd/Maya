/**
 * sessionStore — Global state for the tutor session
 * ──────────────────────────────────────────────────
 * Uses Zustand (lightweight, no boilerplate).
 * Drives the avatar animation state, lip sync weights,
 * facial expressions, and conversation history.
 *
 * State machine:
 *   IDLE → LISTENING (student speaks) → THINKING (LLM processing)
 *        → SPEAKING (AI responds)     → IDLE
 */

import { create } from 'zustand';
import { AnimationState, VisemeWeights, ExpressionWeights } from '../components/AvatarRenderer';

// ── Conversation ──────────────────────────────────────────────────────────
export type Speaker = 'student' | 'tutor';

export interface Message {
  id:        string;
  speaker:   Speaker;
  text:      string;
  timestamp: number;
}

// ── Session state machine ─────────────────────────────────────────────────
export type SessionPhase =
  | 'loading'    // GLB loading
  | 'idle'       // tutor waiting
  | 'listening'  // student speaking (mic active)
  | 'thinking'   // LLM processing
  | 'speaking'   // tutor responding (TTS playing)
  | 'error';

// ── Store shape ───────────────────────────────────────────────────────────
interface SessionState {
  // Student
  studentName:    string;
  setStudentName: (name: string) => void;

  // Session phase
  phase:          SessionPhase;
  setPhase:       (phase: SessionPhase) => void;

  // Avatar
  animationState: AnimationState;
  setAnimation:   (state: AnimationState) => void;

  visemeWeights:  VisemeWeights;
  setViseme:      (weights: VisemeWeights) => void;
  clearVisemes:   () => void;

  expression:     ExpressionWeights;
  setExpression:  (expr: ExpressionWeights) => void;
  clearExpression: () => void;

  // Conversation
  messages:       Message[];
  addMessage:     (msg: Omit<Message, 'id' | 'timestamp'>) => void;
  clearMessages:  () => void;

  // UI
  transcriptVisible: boolean;
  toggleTranscript:  () => void;

  // Session controls
  isAvatarReady:  boolean;
  setAvatarReady: (ready: boolean) => void;
}

// ── Phase → animation mapping ─────────────────────────────────────────────
const PHASE_ANIMATION: Record<SessionPhase, AnimationState> = {
  loading:   'idle',
  idle:      'idle',
  listening: 'idle',       // listening uses breathing + expression change
  thinking:  'thinking',
  speaking:  'talking',
  error:     'idle',
};

// ── Store ─────────────────────────────────────────────────────────────────
export const useSessionStore = create<SessionState>((set, get) => ({
  // Student
  studentName:    'Student',
  setStudentName: (name) => set({ studentName: name }),

  // Phase — automatically updates animation when phase changes
  phase: 'loading',
  setPhase: (phase) => {
    const animationState = PHASE_ANIMATION[phase];
    set({ phase, animationState });
  },

  // Avatar animation
  animationState: 'idle',
  setAnimation:   (animationState) => set({ animationState }),

  // Visemes — lip sync weights (0–1 per viseme)
  visemeWeights: {},
  setViseme:     (weights) => set({ visemeWeights: weights }),
  clearVisemes:  () => set({ visemeWeights: {} }),

  // Expressions
  expression: {},
  setExpression:  (expression) => set(s => ({
    expression: { ...s.expression, ...expression }
  })),
  clearExpression: () => set({ expression: {} }),

  // Conversation
  messages: [],
  addMessage: (msg) => set(s => ({
    messages: [...s.messages, {
      ...msg,
      id:        `${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
    }]
  })),
  clearMessages: () => set({ messages: [] }),

  // UI
  transcriptVisible: false,
  toggleTranscript:  () => set(s => ({ transcriptVisible: !s.transcriptVisible })),

  // Avatar ready flag
  isAvatarReady:  false,
  setAvatarReady: (ready) => set({ isAvatarReady: ready }),
}));

// ── Convenience helpers ───────────────────────────────────────────────────

/** Call when student starts talking — updates phase + expression */
export function studentStartsSpeaking() {
  const store = useSessionStore.getState();
  store.setPhase('listening');
  store.setExpression({
    'Eye_Wide_L':         0.15,
    'Eye_Wide_R':         0.15,
    'Brow_Raise_Inner_L': 0.3,
    'Brow_Raise_Inner_R': 0.3,
  });
}

/** Call when LLM is processing */
export function tutorIsThinking() {
  const store = useSessionStore.getState();
  store.setPhase('thinking');
  store.clearVisemes();
  store.setExpression({
    'Brow_Compress_L': 0.2,
    'Brow_Compress_R': 0.2,
    'Mouth_Close':     0.3,
  });
}

/** Call when TTS starts playing — drives lip sync each frame */
export function tutorStartsSpeaking() {
  const store = useSessionStore.getState();
  store.setPhase('speaking');
  store.setExpression({
    'Mouth_Smile_L':  0.25,
    'Mouth_Smile_R':  0.25,
    'Brow_Compress_L': 0,
    'Brow_Compress_R': 0,
  });
}

/** Call when TTS finishes */
export function tutorFinishedSpeaking() {
  const store = useSessionStore.getState();
  store.setPhase('idle');
  store.clearVisemes();
  store.setExpression({
    'Mouth_Smile_L': 0.15,
    'Mouth_Smile_R': 0.15,
  });
}

/** Play a reaction — nod on correct answer */
export function tutorNods(long = false) {
  const store = useSessionStore.getState();
  store.setAnimation(long ? 'nodding_long' : 'nodding');
  store.setExpression({ 'Mouth_Smile_L': 0.4, 'Mouth_Smile_R': 0.4 });
  // Return to previous state after nod
  setTimeout(() => {
    store.setPhase(store.phase);
    store.setExpression({ 'Mouth_Smile_L': 0.15, 'Mouth_Smile_R': 0.15 });
  }, 2500);
}

/** Celebrate — student got it! */
export function tutorCelebrates() {
  const store = useSessionStore.getState();
  store.setAnimation('cheering');
  store.setExpression({
    'Mouth_Smile_L':      0.9,
    'Mouth_Smile_R':      0.9,
    'Cheek_Raise_L':      0.7,
    'Cheek_Raise_R':      0.7,
    'Brow_Raise_Outer_L': 0.8,
    'Brow_Raise_Outer_R': 0.8,
  });
  setTimeout(() => {
    store.setPhase(store.phase);
    store.setExpression({ 'Mouth_Smile_L': 0.2, 'Mouth_Smile_R': 0.2 });
  }, 3000);
}