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
  View, Text, TouchableOpacity, StyleSheet, Animated, Alert,
  ScrollView, Easing, Platform, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../App';

import AvatarRenderer, { AnimationState } from '../components/AvatarRenderer';
import LoadingOverlay from '../components/LoadingOverlay';
import { useLipSync } from '../engine/LipSyncEngine';
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

  // ── Maya speaks: transcript + talking animation + lip sync ─────────────
  // Speech ends when the lip sync does (until real TTS audio is wired up).
  const { speak, stopSpeaking } = useLipSync();
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tutorSays = useCallback((text: string) => {
    addMessage({ speaker: 'tutor', text });
    tutorStartsSpeaking();
    // Speak in the style of the current reaction (e.g. slower and softer when the student is frustrated)
    const durationMs = speak(text, undefined, REACTIONS[useSessionStore.getState().tutorReaction].speech);
    if (speechTimer.current) clearTimeout(speechTimer.current);
    speechTimer.current = setTimeout(tutorFinishedSpeaking, durationMs + 150);
  }, [addMessage, speak]);

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
        { text: 'Turn on', onPress: () => setCameraOn(true) },
      ],
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
  }, [stopSpeaking]);

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
    // Greet the student
    setTimeout(() => {
      tutorSays(`Hi ${studentName}! I'm Maya, your tutor. What are we working on today?`);
    }, 800);
  };

  // ── Mic button ────────────────────────────────────────────────────────
  const handleMicPress = () => {
    if (!isAvatarReady) return;
    if (phase === 'listening') {
      // Stop listening — simulate student finishing
      const mockStudentText = MOCK_STUDENT_LINES[mockLine.current++ % MOCK_STUDENT_LINES.length];
      addMessage({ speaker: 'student', text: mockStudentText });
      tutorIsThinking();
      // Simulate LLM + TTS for prototype
      setTimeout(() => {
        tutorSays("Of course! A quadratic equation has the form ax² + bx + c = 0. Let's start with a simple example — can you tell me what you already know about solving them?");
      }, 1800);
    } else if (phase === 'idle') {
      studentStartsSpeaking();
    }
  };

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

          {/* Mic button */}
          <Animated.View style={{ transform: [{ scale: micPulse }] }}>
            <TouchableOpacity
              style={[s.micBtn, phase === 'listening' && s.micBtnActive, !isAvatarReady && s.micBtnDisabled]}
              onPress={handleMicPress}
              disabled={!isAvatarReady || phase === 'thinking' || phase === 'speaking'}
            >
              <Text style={s.micIcon}>{phase === 'listening' ? '⏹' : '🎤'}</Text>
            </TouchableOpacity>
          </Animated.View>

          {/* Nod shortcut */}
          <TouchableOpacity style={s.sideBtn} onPress={() => tutorNods()}>
            <Text style={s.sideBtnText}>👍</Text>
          </TouchableOpacity>

        </View>

        <Text style={s.hint}>
          {phase === 'idle'      ? 'Tap the mic to speak'           :
           phase === 'listening' ? 'Tap again when done speaking'   :
           phase === 'thinking'  ? 'Maya is preparing a response…'  :
           phase === 'speaking'  ? 'Maya is explaining…'            : ''}
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
  micIcon:         { fontSize: 28 },
  sideBtn:         { width: 50, height: 50, borderRadius: 25, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  sideBtnText:     { fontSize: 22 },

  hint:            { fontSize: 12, color: C.textDim, textAlign: 'center', height: 18 },
});