/**
 * useCheckIns
 * ───────────
 * Decides when Maya asks "How's this going?" while the expression camera is on, and
 * saves the answer with the face measurements from just before she asked (checkins.ts).
 *
 * She only asks when nobody is talking, not more than every few minutes, and only after
 * the student agreed to saving check-ins (asked once, separately from the camera).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { CameraEmotionDetector } from '../components/EmotionCamera';
import type { StudentEmotion } from './emotion';
import { useSessionStore } from '../store/sessionStore';
import { Consent, countCheckIns, getConsent, saveCheckIn, setConsent } from './checkins';

const FIRST_MS     = 60_000;              // first check-in about a minute after the camera starts
const MIN_GAP_MS   = 150_000;             // then every 2.5–4 minutes
const MAX_GAP_MS   = 240_000;
const RETRY_MS     = 30_000;              // no usable face readings yet: try again shortly
const SAMPLE_MS    = 6_000;               // save the readings from the 6 s before asking
const SHOW_MS      = 20_000;              // the card goes away on its own if ignored
const POLL_MS      = 5_000;

type Snapshot = ReturnType<CameraEmotionDetector['recent']>;

const askConsent = () => new Promise<Consent>(resolve => {
  Alert.alert(
    'Help Maya learn your expressions?',
    "Sometimes Maya will ask how it's going. Can she save your answer together with the face " +
    "measurements from that moment? Only numbers are saved (like \"eyebrows lowered: 0.3\"), never " +
    'photos or video, and they stay on this phone unless you export them. ' +
    'If the student is a child, a parent or guardian should decide.',
    [
      { text: 'No thanks', style: 'cancel', onPress: () => resolve('no') },
      { text: 'Yes, save', onPress: () => resolve('yes') },
    ],
    { cancelable: false },
  );
});

export function useCheckIns(detector: CameraEmotionDetector, active: boolean) {
  const [prompt, setPrompt] = useState<Snapshot | null>(null);
  const [count, setCount]   = useState(0);
  const consent = useRef<Consent>(undefined);
  const dueAt   = useRef(Infinity);
  const asking  = useRef(false);

  const refreshCount = useCallback(() => { countCheckIns().then(setCount).catch(() => {}); }, []);
  useEffect(() => {
    refreshCount();
    getConsent().then(c => { consent.current = c; }).catch(() => {});
  }, [refreshCount]);

  // Start the clock when the camera turns on; drop any open card when it turns off
  useEffect(() => {
    dueAt.current = active ? Date.now() + FIRST_MS : Infinity;
    if (!active) setPrompt(null);
  }, [active]);

  useEffect(() => {
    if (!active || prompt) return;
    const id = setInterval(async () => {
      if (asking.current || Date.now() < dueAt.current || consent.current === 'no') return;
      if (useSessionStore.getState().phase !== 'idle') return;  // never interrupt anyone talking
      const snap = detector.recent(SAMPLE_MS);
      if (snap.warm || snap.samples.length < 2) { dueAt.current = Date.now() + RETRY_MS; return; }

      if (consent.current === undefined) {
        asking.current = true;
        consent.current = await askConsent();
        await setConsent(consent.current).catch(() => {});
        asking.current = false;
        if (consent.current === 'no') return;
      }
      dueAt.current = Date.now() + MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
      setPrompt(snap);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [active, prompt, detector]);

  // Ignored cards go away
  useEffect(() => {
    if (!prompt) return;
    const id = setTimeout(() => setPrompt(null), SHOW_MS);
    return () => clearTimeout(id);
  }, [prompt]);

  const answer = useCallback((label: StudentEmotion) => {
    if (!prompt) return;
    const { phase, tutorReaction } = useSessionStore.getState();
    setPrompt(null);
    saveCheckIn({
      label, phase, reaction: tutorReaction,
      baseline: prompt.baseline, baseRoll: prompt.baseRoll, samples: prompt.samples,
    }).then(refreshCount).catch(err => console.warn('[CheckIn] save failed', err));
  }, [prompt, refreshCount]);

  const skip = useCallback(() => setPrompt(null), []);

  return { showing: !!prompt, answer, skip, count, refreshCount };
}
