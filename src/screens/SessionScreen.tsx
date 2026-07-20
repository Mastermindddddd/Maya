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

import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
  ScrollView, Easing, Platform, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../App';

import AvatarRenderer, { AnimationState } from '../components/AvatarRenderer';
import LoadingOverlay from '../components/LoadingOverlay';
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
  const visemeWeights  = useSessionStore(s => s.visemeWeights);
  const expression     = useSessionStore(s => s.expression);
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
      addMessage({ speaker: 'tutor', text: `Hi ${studentName}! I'm Maya, your tutor. What are we working on today?` });
      tutorStartsSpeaking();
      // Simulate end of speech for prototype
      setTimeout(tutorFinishedSpeaking, 3000);
    }, 800);
  };

  // ── Mic button ────────────────────────────────────────────────────────
  const handleMicPress = () => {
    if (!isAvatarReady) return;
    if (phase === 'listening') {
      // Stop listening — simulate student finishing
      const mockStudentText = "Can you help me with quadratic equations?";
      addMessage({ speaker: 'student', text: mockStudentText });
      tutorIsThinking();
      // Simulate LLM + TTS for prototype
      setTimeout(() => {
        addMessage({ speaker: 'tutor', text: "Of course! A quadratic equation has the form ax² + bx + c = 0. Let's start with a simple example — can you tell me what you already know about solving them?" });
        tutorStartsSpeaking();
        setTimeout(tutorFinishedSpeaking, 4000);
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
          visemeWeights={visemeWeights}
          expression={expression}
          onReady={handleAvatarReady}
          onError={(err) => { console.error(err); setPhase('error'); }}
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
          <TouchableOpacity style={s.transcriptBtn} onPress={toggleTranscript}>
            <Text style={s.transcriptBtnText}>≡</Text>
          </TouchableOpacity>
        </View>

        {/* Status label */}
        <View style={s.statusBar}>
          <Text style={[s.statusText, { color: phaseInfo.color }]}>
            {phaseInfo.label}
          </Text>
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
              onPress={() => useSessionStore.getState().setAnimation(state)}
            >
              <Text style={[s.animChipText, animationState === state && s.animChipTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
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

  // Status bar
  statusBar:       { position: 'absolute', bottom: 14, left: 0, right: 0, alignItems: 'center' },
  statusText:      { fontSize: 13, fontWeight: '500', letterSpacing: 0.5 },

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