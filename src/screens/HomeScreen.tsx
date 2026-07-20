/**
 * HomeScreen
 * ──────────
 * Clean entry point. Student enters their name and starts a session.
 * The design language: deep night-blue background, warm amber accent,
 * generous type scale — feels like a serious learning product, not a game.
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, Animated, Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '../../App';

type Props = {
  navigation: StackNavigationProp<RootStackParamList, 'Home'>;
};

// ── Design tokens ─────────────────────────────────────────────────────────
const C = {
  bg:        '#0B0F1A',   // deep night blue
  surface:   '#141929',   // card surface
  border:    '#1E2740',   // subtle border
  amber:     '#F5A623',   // warm tutor amber — the signature accent
  amberDim:  '#3D2A08',   // amber at low opacity
  text:      '#EDF0F7',   // near-white body text
  textDim:   '#5A6480',   // muted label
  teal:      '#2ECBA1',   // secondary success/active tint
};

export default function HomeScreen({ navigation }: Props) {
  const [name, setName]     = useState('');
  const [focused, setFocused] = useState(false);
  const scaleAnim = React.useRef(new Animated.Value(1)).current;

  const handleStart = () => {
    const trimmed = name.trim() || 'Student';
    navigation.navigate('Session', { studentName: trimmed });
  };

  const pressIn = () => {
    Animated.timing(scaleAnim, {
      toValue: 0.96, duration: 80, easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();
  };

  const pressOut = () => {
    Animated.timing(scaleAnim, {
      toValue: 1, duration: 120, easing: Easing.out(Easing.back(2)),
      useNativeDriver: true,
    }).start();
  };

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={s.container}>

          {/* ── Top mark ── */}
          <View style={s.topMark}>
            <View style={s.dot} />
            <Text style={s.wordmark}>MAYA</Text>
          </View>

          {/* ── Hero ── */}
          <View style={s.hero}>
            <Text style={s.heroEyebrow}>YOUR AI TUTOR</Text>
            <Text style={s.heroTitle}>{"Learn with\nsomeone who\nnotices."}</Text>
            <Text style={s.heroSub}>
              Maya watches what you're working on, explains on your page,
              and never gives up on you.
            </Text>
          </View>

          {/* ── Input card ── */}
          <View style={s.card}>
            <Text style={s.inputLabel}>What should Maya call you?</Text>
            <TextInput
              style={[s.input, focused && s.inputFocused]}
              placeholder="Your name"
              placeholderTextColor={C.textDim}
              value={name}
              onChangeText={setName}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              returnKeyType="done"
              onSubmitEditing={handleStart}
              autoCapitalize="words"
              maxLength={30}
            />

            <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
              <TouchableOpacity
                style={s.btn}
                onPress={handleStart}
                onPressIn={pressIn}
                onPressOut={pressOut}
                activeOpacity={1}
              >
                <Text style={s.btnText}>Start session →</Text>
              </TouchableOpacity>
            </Animated.View>
          </View>

          {/* ── Footer note ── */}
          <Text style={s.footer}>
            Your sessions are private and never shared.
          </Text>

        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: C.bg },
  flex:        { flex: 1 },
  container:   { flex: 1, paddingHorizontal: 28, justifyContent: 'space-between', paddingBottom: 24, paddingTop: 20 },

  // Wordmark
  topMark:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot:         { width: 8, height: 8, borderRadius: 4, backgroundColor: C.amber },
  wordmark:    { fontSize: 13, fontWeight: '700', letterSpacing: 4, color: C.amber },

  // Hero
  hero:        { flex: 1, justifyContent: 'center', paddingVertical: 24 },
  heroEyebrow: { fontSize: 11, fontWeight: '600', letterSpacing: 3, color: C.teal, marginBottom: 14 },
  heroTitle:   { fontSize: 44, fontWeight: '800', color: C.text, lineHeight: 52, marginBottom: 20, letterSpacing: -0.5 },
  heroSub:     { fontSize: 15, color: C.textDim, lineHeight: 24, maxWidth: 300 },

  // Card
  card:        { backgroundColor: C.surface, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: C.border, gap: 14 },
  inputLabel:  { fontSize: 13, color: C.textDim, fontWeight: '500' },
  input:       {
    backgroundColor: C.bg, borderRadius: 12, borderWidth: 1.5,
    borderColor: C.border, paddingHorizontal: 18, paddingVertical: 14,
    fontSize: 17, color: C.text, fontWeight: '500',
  },
  inputFocused: { borderColor: C.amber },
  btn:          {
    backgroundColor: C.amber, borderRadius: 14, paddingVertical: 16,
    alignItems: 'center',
  },
  btnText:      { fontSize: 16, fontWeight: '700', color: C.bg, letterSpacing: 0.3 },

  footer:       { fontSize: 12, color: C.textDim, textAlign: 'center', marginTop: 16 },
});