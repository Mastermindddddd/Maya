/**
 * SessionScreen
 * ─────────────
 * The main teaching interface. Full-screen avatar with:
 *   • 3D avatar rendering (AvatarRenderer)
 *   • Animation state controls
 *   • Mic button (STT — wired up in Phase 2)
 *   • Conversation transcript overlay
 *   • Status indicator
 *
 * This screen is designed for portrait mode — avatar fills the
 * top 65% of screen, controls occupy the bottom 35%.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Alert, Linking,
  ScrollView, Easing, Platform, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera } from 'expo-camera';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../App';

import AvatarRenderer, { AnimationState } from '../components/AvatarRenderer';
import LoadingOverlay from '../components/LoadingOverlay';
import { spokenText, useLipSync } from '../engine/LipSyncEngine';
import { playOnBridge, say, serverUrl, stopVoice } from '../engine/tutorVoice';
import VoiceBridgeView, { ListenerInfo, VoiceBridge } from '../components/VoiceBridge';
import { TURN_DEFAULTS } from '../engine/turnDetector';
import { Audio } from 'expo-av';
import { ManualEmotionDetector, REACTIONS, StudentEmotion } from '../engine/emotion';
import { useEmotionReactions } from '../engine/useEmotionReactions';
import { ContextEvidence } from '../engine/contextSignals';
import { FACE_TRUST, FusedEmotionDetector, FusionInfo, TRUST_ALL } from '../engine/emotionFusion';
import { useContextSignals } from '../engine/useContextSignals';
import EmotionCamera, { CameraEmotionDetector, CameraInfo } from '../components/EmotionCamera';
import CheckInCard from '../components/CheckInCard';
import { useCheckIns } from '../engine/useCheckIns';
import { deleteCheckIns, exportCheckIns } from '../engine/checkins';
import {
  useSessionStore,
  studentStartsSpeaking,
  tutorIsThinking,
  tutorStartsSpeaking,
  tutorFinishedSpeaking,
  tutorNods,
  tutorCelebrates,
} from '../store/sessionStore';

type Props = {
  navigation: StackNavigationProp<RootStackParamList, 'Session'>;
  route:      RouteProp<RootStackParamList, 'Session'>;
};

const { height: SCREEN_H } = Dimensions.get('window');

// Prototype student lines for the mic button (until speech-to-text is wired up); they
// exercise the context signals: a request, a confused line, the same question again, a win
// Stand-in for the AI's first sentence (a fast streaming model takes roughly this long)
const MOCK_AI_MS = 500;
const MOCK_TUTOR_REPLY = "Of course! A quadratic equation has the form ax² + bx + c = 0. Let's start with a simple example — can you tell me what you already know about solving them?";

// Short acknowledgements Maya says the instant the student's turn ends, while she prepares her
// reply. Generated once (a few credits), then kept in memory by the VoiceBridge.
const FILLERS = [
  { id: 'mm-okay', text: 'Mm, okay.' },
  { id: 'right',   text: 'Right.' },
  { id: 'okay',    text: 'Okay.' },
  { id: 'mm-hm',   text: 'Mm-hm.' },
];

const MOCK_STUDENT_LINES = [
  'Can you help me with quadratic equations?',
  "Wait, what do you mean? I don't get it.",
  'Can you help me with quadratic equations again?',
  'Oh I see, that makes sense now!',
];
const AVATAR_HEIGHT = SCREEN_H * 0.65;

// ── Design tokens ─────────────────────────────────────────────────────────
const C = {
  bg:        '#0B0F1A',
  surface:   '#141929',
  border:    '#1E2740',
  amber:     '#F5A623',
  amberDim:  '#3D2A08',
  text:      '#EDF0F7',
  textDim:   '#5A6480',
  teal:      '#2ECBA1',
  red:       '#E8525A',
  student:   '#1E2740',
  tutor:     '#192238',
};

// Phase → human-readable label + colour
const PHASE_LABEL: Record<string, { label: string; color: string }> = {
  loading:   { label: 'Loading Maya…',   color: C.textDim },
  idle:      { label: 'Maya is ready',   color: C.teal    },
  listening: { label: 'Listening…',      color: C.amber   },
  thinking:  { label: 'Maya is thinking…', color: C.textDim },
  speaking:  { label: 'Maya is speaking', color: C.teal   },
  error:     { label: 'Something went wrong', color: C.red },
};

export default function SessionScreen({ navigation, route }: Props) {
  const { studentName } = route.params;
  const scrollRef = useRef<ScrollView>(null);
  const micPulse  = useRef(new Animated.Value(1)).current;

  // Global session state
  const phase          = useSessionStore(s => s.phase);
  const animationState = useSessionStore(s => s.animationState);
  const expression     = useSessionStore(s => s.expression);
  const tutorReaction  = useSessionStore(s => s.tutorReaction);
  const studentEmotion = useSessionStore(s => s.studentEmotion);
  const messages       = useSessionStore(s => s.messages);
  const isAvatarReady  = useSessionStore(s => s.isAvatarReady);
  const transcriptVisible = useSessionStore(s => s.transcriptVisible);
  const setStudentName = useSessionStore(s => s.setStudentName);
  const setPhase       = useSessionStore(s => s.setPhase);
  const setAvatarReady = useSessionStore(s => s.setAvatarReady);
  const addMessage     = useSessionStore(s => s.addMessage);
  const toggleTranscript = useSessionStore(s => s.toggleTranscript);

  // Set student name in store
  useEffect(() => {
    setStudentName(studentName);
  }, [studentName, setStudentName]);

  // ── Maya speaks ──────────────────────────────────────────────────────────
  // Preferred: streamed through the VoiceBridge (plays after ~200 ms of audio, fillers ready in
  // memory). Fallbacks: the whole line via expo-av (tutorVoice.say), then silent lip sync.
  const { speak, speakCharacters, speakCharacterStream, stopSpeaking } = useLipSync();
  const bridge = useMemo(() => new VoiceBridge(), []);
  const lineId = useRef(0);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Response time: student stopped talking → Maya's first sound (often a filler), and → her reply
  const studentStoppedAt = useRef<number | null>(null);
  const firstSoundAt = useRef<number | null>(null);
  const [latency, setLatency] = useState<{ firstSound: number; reply: number } | null>(null);
  const noteSound = (at: number, isReply: boolean) => {
    const stopped = studentStoppedAt.current;
    if (stopped === null) return;
    if (firstSoundAt.current === null) firstSoundAt.current = at;
    if (isReply) {
      setLatency({ firstSound: firstSoundAt.current - stopped, reply: at - stopped });
      studentStoppedAt.current = null;
    }
  };

  // Plays one line; resolves when it has finished, been stopped, or failed
  const speakLine = useCallback(async (id: number, text: string) => {
    // Speak in the style of the current reaction (e.g. slower and softer when the student is frustrated)
    const reaction = useSessionStore.getState().tutorReaction;
    const style = REACTIONS[reaction].speech;
    const spoken = spokenText(text);

    if (bridge.ready) {
      const line = playOnBridge(bridge, { text: spoken, reaction }, clock => speakCharacterStream(style.intensity, clock));
      if (line) {
        const audibleAt = await Promise.race([line.started, line.finished.then(() => null)]);
        if (id !== lineId.current) return;
        if (audibleAt !== null) {
          noteSound(audibleAt, true);
          tutorStartsSpeaking();
          await line.finished;
          return;
        }
        // Couldn't stream (server off, over budget…): try the other ways below
      }
    }
    const voiced = await say(spoken, reaction, style.intensity, speakCharacters, () => id === lineId.current);
    if (id !== lineId.current) return;
    noteSound(performance.now(), true);
    tutorStartsSpeaking();
    if (voiced) { await voiced.finished; return; }
    const durationMs = speak(text, undefined, style);
    await new Promise<void>(resolve => { speechTimer.current = setTimeout(resolve, durationMs + 150); });
  }, [bridge, speak, speakCharacters, speakCharacterStream]);

  // A short acknowledgement the instant the student's turn ends, while the reply is prepared
  const lastFiller = useRef('');
  const replyStarted = useRef(false);
  const playFiller = useCallback((id: number) => {
    const options = FILLERS.filter(f => f.id !== lastFiller.current && bridge.hasFiller(f.id));
    const filler = options[Math.floor(Math.random() * options.length)];
    if (!filler) return;
    lastFiller.current = filler.id;
    const line = playOnBridge(bridge, { filler: filler.id }, clock => speakCharacterStream(1, clock));
    line?.started.then(at => {
      if (id !== lineId.current) return;
      noteSound(at, false);
      tutorStartsSpeaking();
    });
    // Reply not ready when the filler ends: back to the thinking look rather than silent "talking"
    line?.finished.then(() => { if (id === lineId.current && !replyStarted.current) tutorIsThinking(); });
  }, [bridge, speakCharacterStream]);

  // Maya's answer: optionally a filler straight away, then the reply (which may still be generating)
  const respond = useCallback(async (reply: Promise<string>, withFiller: boolean) => {
    const id = ++lineId.current;
    if (speechTimer.current) clearTimeout(speechTimer.current);
    firstSoundAt.current = null;
    replyStarted.current = false;
    if (withFiller) playFiller(id);
    const text = await reply;
    if (id !== lineId.current) return;
    addMessage({ speaker: 'tutor', text });
    replyStarted.current = true;
    await speakLine(id, text);
    if (id === lineId.current) tutorFinishedSpeaking();
  }, [addMessage, playFiller, speakLine]);

  const tutorSays = useCallback((text: string) => respond(Promise.resolve(text), false), [respond]);

  // Load the fillers into the bridge once it's up (generated once ever, then served from the cache)
  useEffect(() => {
    bridge.onReady = () => {
      const url = serverUrl();
      if (url) FILLERS.forEach(f => bridge.preloadFiller(url, f.id, f.text));
    };
    return () => { bridge.onReady = undefined; };
  }, [bridge]);

  // ── Student emotion → Maya's reaction ─────────────────────────────────
  // With the camera on, MediaPipe reads the student's face on the phone (EmotionCamera).
  // With it off, the "Student" test chips set what the manual detector reports.
  const emotionDetector = useMemo(() => new ManualEmotionDetector(), []);
  const cameraDetector  = useMemo(() => new CameraEmotionDetector(), []);
  const [cameraOn, setCameraOn]     = useState(false);
  const [cameraInfo, setCameraInfo] = useState<CameraInfo>({ status: 'off' });
  useEffect(() => {
    cameraDetector.onInfo = setCameraInfo;
    return () => { cameraDetector.onInfo = undefined; };
  }, [cameraDetector]);
  // Face readings are fused with context signals (answers, what the student says, silence).
  // The camera's face readings are only trusted where they've proven reliable (FACE_TRUST);
  // the test chips are trusted fully, since they stand in for a perfect detector.
  const context = useMemo(() => new ContextEvidence(), []);
  useContextSignals(context);
  const [fusionInfo, setFusionInfo] = useState<FusionInfo>({ emotion: null, score: 0, reason: '' });
  const fusedDetector = useMemo(() => {
    const d = cameraOn
      ? new FusedEmotionDetector(cameraDetector, context, FACE_TRUST)
      : new FusedEmotionDetector(emotionDetector, context, TRUST_ALL);
    d.onInfo = info => setFusionInfo(prev =>
      prev.emotion === info.emotion && prev.reason === info.reason && Math.abs(prev.score - info.score) < 0.05 ? prev : info);
    return d;
  }, [cameraOn, cameraDetector, emotionDetector, context]);
  useEmotionReactions(fusedDetector, isAvatarReady);
  const mockLine = useRef(0);

  // "How's this going?" check-ins: labelled data for training the classifier (training/)
  const checkIns = useCheckIns(cameraDetector, cameraOn && cameraInfo.status === 'on');
  const manageCheckIns = () => {
    if (checkIns.count === 0) {
      Alert.alert('No check-ins yet', "With the camera on, Maya sometimes asks how it's going. Answers you agree to save appear here.");
      return;
    }
    Alert.alert(`${checkIns.count} check-ins saved`, 'They stay on this phone until you export them.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete all', style: 'destructive', onPress: () => Alert.alert('Delete all check-ins?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteCheckIns().then(checkIns.refreshCount) },
      ]) },
      { text: 'Export', onPress: () => exportCheckIns().then(ok => {
        if (!ok) Alert.alert('Export unavailable', 'Sharing files is not available on this device.');
      }) },
    ]);
  };

  // Ask before switching the camera on, and say exactly what happens to the video
  const toggleCamera = () => {
    if (cameraOn) { setCameraOn(false); return; }
    Alert.alert(
      'Let Maya see your expressions?',
      "Maya can use your front camera to notice when you're frustrated, confused or excited, " +
      'and adjust how she explains. Your face is read on this phone only: no video or photos ' +
      'are saved or sent anywhere. You can turn it off at any time.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Turn on', onPress: startCamera },
      ],
    );
  };
  // Ask Android for the camera from the app itself before starting the WebView: the WebView
  // then finds it already granted, instead of relying on its own permission request (which
  // can go unanswered inside Expo Go and leave it stuck on "Starting camera…")
  const startCamera = async () => {
    const permission = await Camera.requestCameraPermissionsAsync().catch(() => null);
    if (permission?.granted) { setCameraOn(true); return; }
    Alert.alert(
      'Camera permission needed',
      permission?.canAskAgain === false
        ? 'Camera access is turned off for this app. You can turn it on in Settings → Apps → Permissions.'
        : 'Maya needs camera permission to read your expressions.',
      permission?.canAskAgain === false
        ? [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }]
        : [{ text: 'OK' }],
    );
  };
  const cameraLabel = (() => {
    switch (cameraInfo.status) {
      case 'camera': return 'Starting camera…';
      case 'model':  return 'Loading face reader…';
      case 'error':  return `Camera unavailable: ${cameraInfo.error ?? 'unknown error'}`;
      case 'on':
        if (!cameraInfo.face) return 'Camera on · no face in view';
        if (cameraInfo.reading?.emotion && cameraInfo.reading.emotion !== 'neutral') {
          return `Camera on · looks ${cameraInfo.reading.emotion} (${Math.round(cameraInfo.reading.confidence * 100)}%)`;
        }
        return 'Camera on · looks neutral';
      default: return 'Camera on';
    }
  })();
  useEffect(() => () => {
    if (speechTimer.current) clearTimeout(speechTimer.current);
    stopSpeaking();
    stopVoice();
    bridge.stop();
  }, [stopSpeaking, bridge]);

  // ── Mic pulse animation ───────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'listening') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(micPulse, { toValue: 1.18, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(micPulse, { toValue: 1.0,  duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      ).start();
    } else {
      micPulse.stopAnimation();
      Animated.timing(micPulse, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    }
  }, [phase, micPulse]);

  // Auto-scroll transcript
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  // ── Avatar ready ──────────────────────────────────────────────────────
  const handleAvatarReady = () => {
    setAvatarReady(true);
    setPhase('idle');
    startListening();
    // Greet the student
    setTimeout(() => {
      tutorSays(`Hi ${studentName}! I'm Maya, your tutor. What are we working on today?`);
    }, 800);
  };

  // ── The student's turn ends (mic button, or hands-free) ──────────────────
  // Until speech-to-text and the AI are wired up, the student's words and the reply are mock ones.
  const thinkOfReply = () => new Promise<string>(resolve => setTimeout(() => resolve(MOCK_TUTOR_REPLY), MOCK_AI_MS));
  // A reply started early, at the first "probably done" pause (dropped if the student goes on)
  const earlyReply = useRef<Promise<string> | null>(null);

  const studentTurnEnded = useCallback((stoppedAt: number, early: Promise<string> | null = null) => {
    studentStoppedAt.current = stoppedAt;
    const mockStudentText = MOCK_STUDENT_LINES[mockLine.current++ % MOCK_STUDENT_LINES.length];
    addMessage({ speaker: 'student', text: mockStudentText });
    tutorIsThinking();
    respond(early ?? thinkOfReply(), true);
  }, [addMessage, respond]);

  // Stop everything Maya is saying or about to say
  const silenceMaya = useCallback(() => {
    lineId.current++;  // anything still loading won't play
    bridge.stop(); stopVoice(); stopSpeaking();
    if (speechTimer.current) clearTimeout(speechTimer.current);
    earlyReply.current = null;
  }, [bridge, stopSpeaking]);

  // ── Hands-free: Silero VAD decides when the student starts and stops talking ──
  const [handsFree, setHandsFree] = useState(false);
  const [listenerInfo, setListenerInfo] = useState<ListenerInfo>({ status: 'off' });
  useEffect(() => {
    bridge.onInfo = info => setListenerInfo(prev =>
      prev.status === info.status && prev.error === info.error && Math.abs((prev.level ?? 0) - (info.level ?? 0)) < 2 ? prev : info);
    bridge.onEvent = event => {
      const phaseNow = useSessionStore.getState().phase;
      switch (event.type) {
        case 'bargeIn':
          // The student talked over Maya: stop her straight away
          silenceMaya();
          studentStoppedAt.current = null;
          studentStartsSpeaking();
          break;
        case 'speechStart':
          // Still preparing the reply: they weren't done after all, so drop it and let them finish
          if (phaseNow === 'thinking') { silenceMaya(); studentStoppedAt.current = null; }
          if (phaseNow === 'idle' || phaseNow === 'thinking') studentStartsSpeaking();
          break;
        case 'endLikely':
          // Probably done: start thinking of the reply now, to save the rest of the wait
          if (phaseNow === 'listening' && !earlyReply.current) earlyReply.current = thinkOfReply();
          break;
        case 'resumed':
          earlyReply.current = null;
          break;
        case 'endOfTurn':
          // The student actually stopped endSilenceMs ago; that wait is part of the response time
          if (phaseNow === 'listening') {
            studentTurnEnded(performance.now() - TURN_DEFAULTS.endSilenceMs, earlyReply.current);
          }
          earlyReply.current = null;
          break;
        // ignored: noises, background talk
      }
    };
    return () => { bridge.onEvent = undefined; bridge.onInfo = undefined; };
  }, [bridge, silenceMaya, studentTurnEnded]);
  // The detector needs to know when Maya talks (her voice comes back through the mic)
  useEffect(() => bridge.setTutorSpeaking(phase === 'speaking'), [bridge, phase]);
  useEffect(() => bridge.setListening(handsFree), [bridge, handsFree]);

  // Maya listens automatically. The first time, explain why before Android asks for the microphone.
  const [micBlocked, setMicBlocked] = useState(false);
  const startListening = useCallback(async () => {
    const current = await Audio.getPermissionsAsync().catch(() => null);
    if (current?.granted) { setMicBlocked(false); setHandsFree(true); return; }
    const ask = async () => {
      const permission = await Audio.requestPermissionsAsync().catch(() => null);
      if (permission?.granted) { setMicBlocked(false); setHandsFree(true); return; }
      setMicBlocked(true);
      if (permission?.canAskAgain === false) {
        Alert.alert('Microphone is turned off',
          'Maya needs the microphone to hear you. You can turn it on in Settings → Apps → Permissions.',
          [{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }]);
      }
    };
    if (current?.canAskAgain === false) return ask();
    Alert.alert(
      'Maya listens to you',
      "Just talk: Maya hears when you start and stop speaking, so there's no button to press. " +
      'The sound is analysed on this phone only: nothing is recorded or sent anywhere. ' +
      'You can pause listening any time with 🎙 at the top.',
      [{ text: 'Continue', onPress: ask }],
      { cancelable: false },
    );
  }, []);
  // Mute / unmute with 🎙 at the top
  const toggleHandsFree = () => {
    if (handsFree) setHandsFree(false);
    else startListening();
  };
  const listenerLabel = (() => {
    switch (listenerInfo.status) {
      case 'mic':   return 'Starting microphone…';
      case 'model': return 'Loading voice detector…';
      case 'error': return `Hands-free unavailable: ${listenerInfo.error ?? 'unknown error'}`;
      case 'on':    return phase === 'listening' ? 'Listening… (just stop when you’re done)' : 'Hands-free on · speak any time';
      default:      return 'Hands-free on';
    }
  })();

  const phaseInfo = PHASE_LABEL[phase] ?? PHASE_LABEL.idle;

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>

      {/* ── Avatar viewport ── */}
      <View style={[s.avatarContainer, { height: AVATAR_HEIGHT }]}>
        <AvatarRenderer
          animationState={animationState}
          expression={expression}
          reaction={tutorReaction}
          onReady={handleAvatarReady}
          onError={(err) => { console.error(err); setPhase('error'); }}
          // Back to the phase's animation, so the gesture chip un-highlights and can be tapped again
          onGestureFinished={() => setPhase(useSessionStore.getState().phase)}
        />

        {/* Loading overlay */}
        {!isAvatarReady && <LoadingOverlay />}

        {/* Top bar — back + name */}
        <View style={s.topBar}>
          <TouchableOpacity style={s.backBtn} onPress={() => navigation.goBack()}>
            <Text style={s.backText}>←</Text>
          </TouchableOpacity>
          <View style={s.nameTag}>
            <View style={[s.statusDot, { backgroundColor: phaseInfo.color }]} />
            <Text style={s.nameText}>Maya</Text>
          </View>
          <View style={s.topRight}>
            <TouchableOpacity
              style={[s.transcriptBtn, handsFree && s.cameraBtnOn]}
              onPress={toggleHandsFree}
              accessibilityLabel={handsFree ? 'Turn off hands-free' : 'Talk to Maya hands-free'}
            >
              <Text style={s.transcriptBtnText}>🎙</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.transcriptBtn, cameraOn && s.cameraBtnOn]}
              onPress={toggleCamera}
              accessibilityLabel={cameraOn ? 'Turn off expression camera' : 'Let Maya see your expressions'}
            >
              <Text style={s.transcriptBtnText}>{cameraOn ? '📷' : '🙂'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.transcriptBtn} onPress={toggleTranscript}>
              <Text style={s.transcriptBtnText}>≡</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Camera indicator: always visible while the camera is on */}
        {cameraOn && (
          <View style={s.cameraPill}>
            <View style={[s.statusDot, { backgroundColor: cameraInfo.status === 'on' ? C.red : C.textDim }]} />
            <Text style={s.cameraPillText} numberOfLines={1}>{cameraLabel}</Text>
          </View>
        )}
        {cameraOn && <EmotionCamera detector={cameraDetector} />}

        {/* Hands-free indicator: always visible while the microphone is on */}
        {handsFree && (
          <View style={[s.cameraPill, { top: cameraOn ? 96 : 66 }]}>
            <View style={[s.statusDot, { backgroundColor: listenerInfo.status === 'on' ? C.red : C.textDim }]} />
            <Text style={s.cameraPillText} numberOfLines={1}>{listenerLabel}</Text>
          </View>
        )}
        <VoiceBridgeView bridge={bridge} />
        {checkIns.showing && <CheckInCard onAnswer={checkIns.answer} onSkip={checkIns.skip} />}

        {/* Status label */}
        <View style={s.statusBar}>
          <Text style={[s.statusText, { color: phaseInfo.color }]}>
            {phaseInfo.label}
          </Text>
          {/* Why Maya is reacting, for testing and tuning */}
          {fusionInfo.emotion && fusionInfo.score >= 0.45 && !!fusionInfo.reason && (
            <Text style={s.noticingText} numberOfLines={1}>Noticing: {fusionInfo.reason}</Text>
          )}
          {/* Response time: student stopped talking → Maya's first sound */}
          {latency && (
            <Text style={s.noticingText} numberOfLines={1}>
              ⏱ first sound {Math.round(latency.firstSound)} ms · reply {Math.round(latency.reply)} ms (after the student stopped)
            </Text>
          )}
        </View>
      </View>

      {/* ── Bottom controls ── */}
      <View style={s.controls}>

        {/* Transcript */}
        {transcriptVisible && messages.length > 0 && (
          <ScrollView
            ref={scrollRef}
            style={s.transcript}
            contentContainerStyle={s.transcriptContent}
            showsVerticalScrollIndicator={false}
          >
            {messages.map(msg => (
              <View key={msg.id} style={[
                s.bubble,
                msg.speaker === 'student' ? s.bubbleStudent : s.bubbleTutor
              ]}>
                <Text style={s.bubbleSpeaker}>
                  {msg.speaker === 'student' ? studentName : 'Maya'}
                </Text>
                <Text style={s.bubbleText}>{msg.text}</Text>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Student row — for testing the reactions. Face chips stand in for the camera
            (hidden while it's on); answer chips stand in for the tutoring logic. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.animRow} contentContainerStyle={s.animRowContent}>
          <Text style={[s.animChipText, s.emotionLabel]}>Student:</Text>
          <TouchableOpacity style={s.animChip} onPress={() => useSessionStore.getState().reportAnswer(true)}>
            <Text style={s.animChipText}>✓ Right answer</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.animChip} onPress={() => useSessionStore.getState().reportAnswer(false)}>
            <Text style={s.animChipText}>✗ Wrong answer</Text>
          </TouchableOpacity>
          {!cameraOn && ([
            ['😐 Neutral',    'neutral'   ],
            ['😣 Frustrated', 'frustrated'],
            ['🤔 Confused',   'confused'  ],
            ['🤩 Excited',    'excited'   ],
          ] as [string, StudentEmotion][]).map(([label, emotion]) => (
            <TouchableOpacity
              key={emotion}
              style={[s.animChip, studentEmotion === emotion && s.animChipActive]}
              onPress={() => emotionDetector.set(emotion)}
            >
              <Text style={[s.animChipText, studentEmotion === emotion && s.animChipTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Animation quick-switch row — for testing */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.animRow} contentContainerStyle={s.animRowContent}>
          {([
            ['Idle',       'idle'      ],
            ['Talk',       'talking'   ],
            ['Think',      'thinking'  ],
            ['Nod',        'nodding'   ],
            ['Point',      'pointing'  ],
            ['Wave',       'waving'    ],
            ['Cheer',      'cheering'  ],
            ['Clap',       'clapping'  ],
          ] as [string, AnimationState][]).map(([label, state]) => (
            <TouchableOpacity
              key={state}
              style={[s.animChip, animationState === state && s.animChipActive]}
              // "Talk" makes her actually speak a line; the others just play the animation
              onPress={() => state === 'talking'
                ? tutorSays("Let's try one together. If x squared equals nine, then x can be three, or minus three.")
                : useSessionStore.getState().setAnimation(state)}
            >
              <Text style={[s.animChipText, animationState === state && s.animChipTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.animChip} onPress={manageCheckIns}>
            <Text style={s.animChipText}>⇪ Check-ins ({checkIns.count})</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Main controls row */}
        <View style={s.mainControls}>

          {/* Celebrate shortcut */}
          <TouchableOpacity style={s.sideBtn} onPress={tutorCelebrates}>
            <Text style={s.sideBtnText}>🎉</Text>
          </TouchableOpacity>

          {/* Listening indicator (no button: Maya hears when you start and stop talking) */}
          <View style={s.listenIndicator}>
            <Animated.View
              style={[s.micBtn, { transform: [{ scale: micPulse }] },
                phase === 'listening' && s.micBtnActive,
                (!handsFree || listenerInfo.status !== 'on') && s.micBtnDisabled]}
              accessibilityLabel={handsFree ? 'Maya is listening' : 'Listening is paused'}
            >
              <Text style={s.micIcon}>{handsFree ? '🎙' : '🔇'}</Text>
            </Animated.View>
            {/* How loud the microphone hears you: shows it's working */}
            <View style={s.levelRow}>
              {[0, 1, 2, 3, 4].map(i => {
                const lit = handsFree && listenerInfo.status === 'on' &&
                  ((listenerInfo.level ?? -100) + 65) / 9 > i;   // -65 dB … -20 dB over five bars
                return <View key={i} style={[s.levelBar, { height: 4 + i * 2 }, lit && s.levelBarLit]} />;
              })}
            </View>
          </View>

          {/* Nod shortcut */}
          <TouchableOpacity style={s.sideBtn} onPress={() => tutorNods()}>
            <Text style={s.sideBtnText}>👍</Text>
          </TouchableOpacity>

        </View>

        <Text style={s.hint}>
          {micBlocked                         ? 'Maya can’t hear you: allow the microphone (🎙 at the top)' :
           !handsFree                         ? 'Listening is paused — tap 🎙 at the top to resume'      :
           listenerInfo.status === 'error'    ? `Maya can’t hear you: ${listenerInfo.error ?? 'microphone problem'}` :
           listenerInfo.status !== 'on'       ? 'Getting ready to listen…'                               :
           phase === 'idle'                   ? 'Just talk — Maya is listening'                          :
           phase === 'listening'              ? 'Listening… just stop when you’re done'                  :
           phase === 'thinking'               ? 'Maya is thinking…'                                      :
           phase === 'speaking'               ? 'Maya is talking (you can interrupt her)'                : ''}
        </Text>

      </View>

    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:            { flex: 1, backgroundColor: C.bg },

  // Avatar
  avatarContainer: { position: 'relative', overflow: 'hidden', backgroundColor: C.bg },

  // Top bar
  topBar:          { position: 'absolute', top: 16, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  backBtn:         { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(11,15,26,0.7)', alignItems: 'center', justifyContent: 'center' },
  backText:        { fontSize: 20, color: C.text },
  nameTag:         { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(11,15,26,0.7)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  statusDot:       { width: 7, height: 7, borderRadius: 4 },
  nameText:        { fontSize: 14, fontWeight: '600', color: C.text },
  transcriptBtn:   { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(11,15,26,0.7)', alignItems: 'center', justifyContent: 'center' },
  transcriptBtnText: { fontSize: 20, color: C.text },
  topRight:        { flexDirection: 'row', gap: 8 },
  cameraBtnOn:     { borderWidth: 1, borderColor: C.red },
  cameraPill:      { position: 'absolute', top: 66, alignSelf: 'center', maxWidth: '86%', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: 'rgba(11,15,26,0.75)' },
  cameraPillText:  { fontSize: 12, color: C.text },

  // Status bar
  statusBar:       { position: 'absolute', bottom: 14, left: 0, right: 0, alignItems: 'center' },
  statusText:      { fontSize: 13, fontWeight: '500', letterSpacing: 0.5 },
  noticingText:    { fontSize: 11, color: C.textDim, marginTop: 3, textAlign: 'center' },

  // Controls
  controls:        { flex: 1, backgroundColor: C.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 16, paddingBottom: 12, paddingHorizontal: 20 },

  // Transcript
  transcript:      { maxHeight: 160, marginBottom: 10 },
  transcriptContent: { gap: 8, paddingBottom: 4 },
  bubble:          { borderRadius: 14, padding: 12, maxWidth: '85%' },
  bubbleStudent:   { backgroundColor: C.student, alignSelf: 'flex-end' },
  bubbleTutor:     { backgroundColor: C.tutor, alignSelf: 'flex-start' },
  bubbleSpeaker:   { fontSize: 10, fontWeight: '600', color: C.textDim, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 },
  bubbleText:      { fontSize: 13.5, color: C.text, lineHeight: 20 },

  // Animation chips
  animRow:         { flexGrow: 0, marginBottom: 14 },
  animRowContent:  { gap: 8, paddingRight: 4 },
  animChip:        { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border },
  animChipActive:  { backgroundColor: C.amberDim, borderColor: C.amber },
  animChipText:    { fontSize: 12, color: C.textDim, fontWeight: '500' },
  animChipTextActive: { color: C.amber },
  emotionLabel:    { alignSelf: 'center', marginRight: 2 },

  // Main controls
  mainControls:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 24, marginBottom: 10 },
  micBtn:          { width: 72, height: 72, borderRadius: 36, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center', shadowColor: C.amber, shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 8 },
  micBtnActive:    { backgroundColor: C.red, shadowColor: C.red },
  micBtnDisabled:  { opacity: 0.4 },
  listenIndicator: { alignItems: 'center', gap: 6 },
  levelRow:        { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 14 },
  levelBar:        { width: 4, borderRadius: 2, backgroundColor: C.border },
  levelBarLit:     { backgroundColor: C.teal },
  micIcon:         { fontSize: 28 },
  sideBtn:         { width: 50, height: 50, borderRadius: 25, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  sideBtnText:     { fontSize: 22 },

  hint:            { fontSize: 12, color: C.textDim, textAlign: 'center', height: 18 },
});