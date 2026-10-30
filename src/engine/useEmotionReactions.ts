/**
 * useEmotionReactions
 * ───────────────────
 * Runs an EmotionDetector while `enabled`, feeds its readings through the
 * EmotionStateMachine, and publishes the result to the session store
 * (studentEmotion / tutorReaction). Affirming also gives a nod.
 */

import { useEffect, useRef } from 'react';
import { EmotionDetector, EmotionStateMachine } from './emotion';
import { useSessionStore } from '../store/sessionStore';

export function useEmotionReactions(detector: EmotionDetector | null, enabled: boolean) {
  const machine = useRef<EmotionStateMachine | null>(null);
  if (!machine.current) {
    machine.current = new EmotionStateMachine((reaction, emotion) => {
      const store = useSessionStore.getState();
      store.setReaction(reaction, emotion);
      if (reaction === 'affirming') store.setAnimation('nodding');
    });
  }

  useEffect(() => {
    if (!detector || !enabled) return;
    const m = machine.current!;
    Promise.resolve(detector.start(reading => m.push(reading))).catch(err =>
      console.warn('[Emotion] detector failed to start', err),
    );
    return () => {
      detector.stop();
      m.reset();
      useSessionStore.getState().setReaction('neutral', 'neutral');
    };
  }, [detector, enabled]);
}
