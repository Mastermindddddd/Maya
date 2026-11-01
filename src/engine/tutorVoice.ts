/**
 * tutorVoice — Maya's real voice (ElevenLabs, through voice/server.mjs on your laptop)
 * ──────────────────────────────────────────────────────────────────────────────────
 * Asks the voice server for audio + per-character timings, plays the audio with expo-av,
 * and drives lip sync from the audio's own playback position, so the mouth can't drift.
 *
 * If the server can't be reached, is over its daily limit, or anything else fails, `say`
 * returns null and the caller falls back to silent, estimated lip sync — Maya never stops
 * working because of the voice.
 *
 * The server address is your laptop's: the same host Metro serves the app from, port 8787.
 */

import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import { Audio, AVPlaybackStatus } from 'expo-av';
import type { TutorReaction } from './emotion';
import type { LineEvents, VoiceBridge } from '../components/VoiceBridge';

const VOICE_PORT = 8787;
const REQUEST_TIMEOUT_MS = 12_000;
const RETRY_AFTER_MS = 60_000;  // after a failure, don't keep waiting on the server for every line

export type VoiceLine = {
  durationMs: number;
  finished: Promise<void>;  // resolves when the audio ends (or is stopped)
};
type LipSync = (chars: string[], starts: number[], ends: number[], intensity: number, clock: () => number) => void;

export const serverUrl = () => {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:${VOICE_PORT}` : null;
};

let current: Audio.Sound | null = null;
let endCurrent = () => {};
let unavailableUntil = 0;
let audioModeSet = false;

export async function stopVoice() {
  const sound = current;
  current = null;
  endCurrent();  // anything waiting for this line to finish can move on
  await sound?.stopAsync().catch(() => {});
  await sound?.unloadAsync().catch(() => {});
}

// fetch with a timeout (AbortSignal.timeout isn't available in every React Native version)
async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

let lineCount = 0;

/** Speaks `text` in Maya's voice. Returns null if the voice isn't available (use silent lip sync).
 *  `stillWanted` is checked just before playing: a line cancelled while it loaded never plays. */
export async function say(text: string, reaction: TutorReaction, intensity: number, lipSync: LipSync,
                          stillWanted: () => boolean = () => true): Promise<VoiceLine | null> {
  const base = serverUrl();
  if (!base || Date.now() < unavailableUntil) return null;
  await stopVoice();

  try {
    const res = await fetchWithTimeout(`${base}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, reaction }),
    }, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[Voice] server said ${res.status}: ${(await res.json().catch(() => ({}))).error ?? ''}`);
      unavailableUntil = Date.now() + RETRY_AFTER_MS;
      return null;
    }
    const line = await res.json() as { audioBase64: string; characters: string[]; starts: number[]; ends: number[] };

    if (!audioModeSet) {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: true });
      audioModeSet = true;
    }
    // Its own file per line, so two lines loading at once can't overwrite each other
    const uri = `${FileSystem.cacheDirectory}maya-line-${++lineCount % 4}.mp3`;
    await FileSystem.writeAsStringAsync(uri, line.audioBase64, { encoding: FileSystem.EncodingType.Base64 });

    // The lip-sync clock: the audio's last reported position, moved on by the time since then
    let position = 0, positionAt = performance.now(), playing = false, resolveDone = () => {};
    const finished = new Promise<void>(resolve => { resolveDone = resolve; });
    const onStatus = (s: AVPlaybackStatus) => {
      if (!s.isLoaded) return;
      position = s.positionMillis; positionAt = performance.now(); playing = s.isPlaying;
      if (s.didJustFinish) resolveDone();
    };
    const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: false, progressUpdateIntervalMillis: 50 }, onStatus);
    if (!stillWanted()) { await sound.unloadAsync().catch(() => {}); return null; }
    await stopVoice();  // another line may have started while this one loaded
    current = sound;
    endCurrent = () => resolveDone();  // (after stopVoice, which ends the previous line, not this one)
    const clock = () => position + (playing ? performance.now() - positionAt : 0);

    await sound.playAsync();
    lipSync(line.characters, line.starts, line.ends, intensity, clock);
    finished.then(() => { if (current === sound) stopVoice(); });

    const durationMs = (line.ends[line.ends.length - 1] ?? 0) * 1000;
    return { durationMs, finished };
  } catch (err) {
    console.warn('[Voice] unavailable, using silent lip sync:', String(err));
    unavailableUntil = Date.now() + RETRY_AFTER_MS;
    return null;
  }
}

// ── Streamed playback through the VoiceBridge ─────────────────────────────
type StreamLipSync = (clock: () => number) => { add: (c: string[], s: number[], e: number[]) => void; end: () => void };
export type BridgeLine = {
  started: Promise<number>;                           // performance.now() when it becomes audible
  finished: Promise<'done' | 'stopped' | 'error'>;
};

/** Plays a line (streamed from the voice server) or a preloaded filler through the VoiceBridge.
 *  Lip sync follows the bridge's playback position. Returns null if it can't be played. */
export function playOnBridge(bridge: VoiceBridge, what: { text: string; reaction: TutorReaction } | { filler: string },
                             lipSync: StreamLipSync): BridgeLine | null {
  const url = serverUrl();
  let position = 0, positionAt = performance.now();
  const clock = () => position + (performance.now() - positionAt);
  let lip: ReturnType<StreamLipSync> | null = null;
  const early: [string[], number[], number[]][] = [];  // timings that arrive before the audio starts
  let resolveStarted: (t: number) => void = () => {};
  let resolveFinished: (r: 'done' | 'stopped' | 'error') => void = () => {};
  const started = new Promise<number>(r => { resolveStarted = r; });
  const finished = new Promise<'done' | 'stopped' | 'error'>(r => { resolveFinished = r; });

  const events: LineEvents = {
    onStart: inMs => {
      position = -inMs; positionAt = performance.now();
      lip = lipSync(clock);
      early.forEach(a => lip!.add(...a));
      resolveStarted(performance.now() + inMs);
    },
    onAlign: (c, s, e) => (lip ? lip.add(c, s, e) : early.push([c, s, e])),
    onPosition: ms => { position = ms; positionAt = performance.now(); },
    onEnd: stopped => { lip?.end(); resolveFinished(stopped ? 'stopped' : 'done'); },
    onError: message => { console.warn('[Voice]', message); resolveFinished('error'); },
  };
  const id = 'filler' in what
    ? bridge.playFiller(what.filler, events)
    : url ? bridge.say(url, what.text, what.reaction, events) : null;
  return id ? { started, finished } : null;
}
