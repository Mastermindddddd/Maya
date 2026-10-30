/**
 * useContextSignals
 * ─────────────────
 * Feeds ContextEvidence from the session: every student message, every answer the
 * tutoring logic reports (store.reportAnswer), and silence after Maya asks a question.
 */

import { useEffect } from 'react';
import type { ContextEvidence } from './contextSignals';
import { useSessionStore } from '../store/sessionStore';

const QUIET_AFTER_QUESTION_MS = 20_000;

export function useContextSignals(context: ContextEvidence) {
  useEffect(() => {
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const clearQuiet = () => { if (quietTimer) clearTimeout(quietTimer); quietTimer = null; };

    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      // New messages
      if (state.messages.length > prev.messages.length) {
        for (const msg of state.messages.slice(prev.messages.length)) {
          if (msg.speaker === 'student') {
            clearQuiet();
            context.studentSaid(msg.text);
          }
        }
      }
      // Answers checked by the tutoring logic
      if (state.lastAnswer && state.lastAnswer !== prev.lastAnswer) {
        context.answered(state.lastAnswer.correct);
      }
      // Maya finished speaking with a question: start waiting for a reply
      if (prev.phase === 'speaking' && state.phase === 'idle') {
        const last = [...state.messages].reverse().find(m => m.speaker === 'tutor');
        clearQuiet();
        if (last && /\?\s*$/.test(last.text.trim())) {
          quietTimer = setTimeout(() => {
            if (useSessionStore.getState().phase === 'idle') context.wentQuiet();
          }, QUIET_AFTER_QUESTION_MS);
        }
      }
      // The student started speaking (mic): they're not quiet
      if (state.phase === 'listening') clearQuiet();
    });

    return () => { unsubscribe(); clearQuiet(); };
  }, [context]);
}
