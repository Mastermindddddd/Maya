/**
 * EmotionCamera
 * ─────────────
 * On-device face expression reading with MediaPipe FaceLandmarker (web build) running
 * in a hidden WebView. The WebView opens the front camera and every 2 s sends only the
 * 52 blendshape scores and the head tilt to the app: no image or video ever leaves it,
 * and nothing is stored.
 *
 * The MediaPipe engine (~9.6 MB) and face model (~3.8 MB) are downloaded on first use
 * and cached by the WebView. To work fully offline, bundle them as assets and point
 * MP_BASE / MODEL_URL at the local copies.
 *
 * Usage: render <EmotionCamera detector={d} /> while the camera should be on, and pass
 * the same CameraEmotionDetector to useEmotionReactions.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { DETECT_INTERVAL_MS, EmotionDetector, EmotionReading } from '../engine/emotion';
import { ExpressionClassifier, FaceSample, EmotionScores } from '../engine/expressionClassifier';

const MP_VERSION = '0.10.14';
const MP_BASE    = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// ── Page that runs in the WebView ──────────────────────────────────────────
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#000">
<video id="v" playsinline muted autoplay style="width:2px;height:2px"></video>
<script type="module">
const post = m => window.ReactNativeWebView.postMessage(JSON.stringify(m));
// Plain-language reasons for the usual camera failures
const REASONS = {
  NotAllowedError:  'camera permission was refused',
  NotReadableError: 'another app is using the camera',
  NotFoundError:    'no front camera was found',
  TimeoutError:     "the camera didn't start within 15 seconds",
};
try {
  post({ type: 'status', status: 'camera' });
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('this WebView has no camera support');
  // Never wait forever: if Android doesn't answer, say so
  const stream = await Promise.race([
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } }, audio: false,
    }),
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 15000)),
  ]);
  const v = document.getElementById('v');
  v.srcObject = stream;
  await v.play();

  post({ type: 'status', status: 'model' });
  const { FaceLandmarker, FilesetResolver } = await import('${MP_BASE}/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks('${MP_BASE}/wasm');
  const landmarker = await FaceLandmarker.createFromOptions(files, {
    // CPU: the avatar already keeps the GPU busy, and one frame every 2 s is cheap
    baseOptions: { modelAssetPath: '${MODEL_URL}', delegate: 'CPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  post({ type: 'status', status: 'on' });

  setInterval(() => {
    if (v.readyState < 2) return;
    const result = landmarker.detectForVideo(v, performance.now());
    const categories = result.faceBlendshapes?.[0]?.categories;
    if (!categories) return post({ type: 'face', face: null });
    const blendshapes = {};
    for (const c of categories) blendshapes[c.categoryName] = Math.round(c.score * 1000) / 1000;
    // Head tilt (roll) from the face's rotation matrix (column-major 4x4)
    const m = result.facialTransformationMatrixes?.[0]?.data;
    const roll = m ? Math.atan2(m[1], m[0]) : 0;
    post({ type: 'face', face: { blendshapes, roll } });
  }, ${DETECT_INTERVAL_MS});
} catch (err) {
  post({ type: 'error', message: REASONS[err && err.name] || String(err && err.message || err) });
}
</script></body></html>`;

// ── Detector ───────────────────────────────────────────────────────────────
export type CameraStatus = 'off' | 'camera' | 'model' | 'on' | 'error';
export type CameraInfo   = {
  status:  CameraStatus;
  error?:  string;
  face?:   boolean;          // a face is in view
  reading?: EmotionReading;  // latest classified reading
  scores?: EmotionScores;    // raw scores, for tuning the classifier
};

const RECENT_MS = 12000;  // readings kept for check-ins

export class CameraEmotionDetector implements EmotionDetector {
  private onReading?: (reading: EmotionReading) => void;
  private classifier = new ExpressionClassifier();
  private history: { at: number; face: FaceSample }[] = [];
  info: CameraInfo = { status: 'off' };
  onInfo?: (info: CameraInfo) => void;

  start(onReading: (reading: EmotionReading) => void) {
    this.onReading = onReading;
    this.classifier.reset();
    this.history = [];
  }

  /** Readings from the last `ms` milliseconds, plus the resting face they're compared with */
  recent(ms: number) {
    const now = Date.now();
    return {
      ...this.classifier.snapshot(),
      samples: this.history
        .filter(h => now - h.at <= ms)
        .map(h => ({ ago: now - h.at, blendshapes: h.face.blendshapes, roll: h.face.roll })),
    };
  }

  stop() {
    this.onReading = undefined;
    this.update({ status: 'off', error: undefined, face: undefined, reading: undefined, scores: undefined });
  }

  /** Called with each message from the WebView page */
  handleMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'status') this.update({ status: msg.status, error: undefined });
    else if (msg.type === 'error') this.update({ status: 'error', error: msg.message });
    else if (msg.type === 'face') {
      if (msg.face) {
        const now = Date.now();
        this.history = [...this.history.filter(h => now - h.at <= RECENT_MS), { at: now, face: msg.face }];
      }
      const reading = this.classifier.classify(msg.face as FaceSample | null);
      this.update({ face: !!msg.face, reading, scores: { ...this.classifier.lastScores } });
      this.onReading?.(reading);
    }
  }

  private update(patch: Partial<CameraInfo>) {
    this.info = { ...this.info, ...patch };
    this.onInfo?.(this.info);
  }
}

// ── Component ──────────────────────────────────────────────────────────────
export default function EmotionCamera({ detector }: { detector: CameraEmotionDetector }) {
  return (
    // Tiny but on screen: some Android WebViews pause timers in views that aren't visible
    <View style={s.host} pointerEvents="none">
      <WebView
        source={{ html: PAGE, baseUrl: 'https://localhost/' }}  // https origin: getUserMedia needs a secure context
        originWhitelist={['*']}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        mediaCapturePermissionGrantType="grant"
        onMessage={(e: WebViewMessageEvent) => detector.handleMessage(e.nativeEvent.data)}
        onError={e => detector.handleMessage(JSON.stringify({ type: 'error', message: e.nativeEvent.description }))}
        style={s.webview}
      />
    </View>
  );
}

const s = StyleSheet.create({
  host:    { position: 'absolute', left: 0, bottom: 0, width: 2, height: 2, opacity: 0.01, overflow: 'hidden' },
  webview: { width: 2, height: 2, backgroundColor: 'transparent' },
});
