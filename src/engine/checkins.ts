/**
 * Emotion check-ins — labelled training data, collected in the app
 * ────────────────────────────────────────────────────────────────
 * Now and then Maya asks "How's this going?". With the student's (or a parent's) consent,
 * their answer is saved together with the face *measurements* from just before she asked —
 * numbers only, never images — so training/train.py can learn from real students.
 *
 * Stored on the phone only, as JSON lines in the app's documents folder, until exported
 * with the share sheet. Each line:
 *   { v, participant, session, at, label, phase, reaction, baseline, baseRoll,
 *     samples: [{ ago, blendshapes, roll }] }
 * `participant` is a random ID for this install (no names), so training can test on
 * people it hasn't seen.
 */

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { StudentEmotion } from './emotion';
import type { Blendshapes } from './expressionClassifier';

const DATA_FILE     = `${FileSystem.documentDirectory}emotion-checkins.jsonl`;
const SETTINGS_FILE = `${FileSystem.documentDirectory}emotion-checkin-settings.json`;

export type Consent = 'yes' | 'no' | undefined;
type Settings = { consent?: Consent; participant: string };

export type CheckInSample = { ago: number; blendshapes: Blendshapes; roll: number };
export type CheckIn = {
  label:    StudentEmotion;
  phase:    string;
  reaction: string;
  baseline: Blendshapes;
  baseRoll: number;
  samples:  CheckInSample[];
};

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const SESSION_ID = randomId();

async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(SETTINGS_FILE));
  } catch {
    const settings = { participant: randomId() };
    await FileSystem.writeAsStringAsync(SETTINGS_FILE, JSON.stringify(settings));
    return settings;
  }
}

export async function getConsent(): Promise<Consent> {
  return (await readSettings()).consent;
}

export async function setConsent(consent: Consent) {
  const settings = await readSettings();
  await FileSystem.writeAsStringAsync(SETTINGS_FILE, JSON.stringify({ ...settings, consent }));
}

async function readLines(): Promise<string[]> {
  const info = await FileSystem.getInfoAsync(DATA_FILE);
  if (!info.exists) return [];
  return (await FileSystem.readAsStringAsync(DATA_FILE)).split('\n').filter(Boolean);
}

// 4 decimals is more precision than MediaPipe's scores carry, and keeps the file small
const round = (o: Blendshapes) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4]));

export async function saveCheckIn(checkIn: CheckIn) {
  const { participant } = await readSettings();
  const line = JSON.stringify({
    v: 1, participant, session: SESSION_ID, at: new Date().toISOString(), ...checkIn,
    baseline: round(checkIn.baseline),
    baseRoll: Math.round(checkIn.baseRoll * 1e4) / 1e4,
    samples:  checkIn.samples.map(s => ({ ...s, blendshapes: round(s.blendshapes), roll: Math.round(s.roll * 1e4) / 1e4 })),
  });
  // expo-file-system can't append, so rewrite the file (~5 KB per check-in, ~2.5 MB for 500)
  const lines = await readLines();
  await FileSystem.writeAsStringAsync(DATA_FILE, [...lines, line].join('\n') + '\n');
}

export async function countCheckIns(): Promise<number> {
  return (await readLines()).length;
}

/** Opens the share sheet with the check-ins file (e-mail it, save to Drive, …) */
export async function exportCheckIns(): Promise<boolean> {
  if ((await countCheckIns()) === 0 || !(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(DATA_FILE, { mimeType: 'application/json', dialogTitle: 'Export emotion check-ins' });
  return true;
}

export async function deleteCheckIns() {
  await FileSystem.deleteAsync(DATA_FILE, { idempotent: true });
}
