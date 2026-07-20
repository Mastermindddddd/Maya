/**
 * LoadingOverlay
 * ──────────────
 * Shown over the GL canvas while the GLB model is loading.
 * Animated dots pulse to signal activity.
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';

export default function LoadingOverlay() {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  const pulse = (anim: Animated.Value, delay: number) =>
    Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );

  useEffect(() => {
    pulse(dot1, 0).start();
    pulse(dot2, 160).start();
    pulse(dot3, 320).start();
  }, []);

  const dotStyle = (anim: Animated.Value) => ({
    opacity: anim,
    transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }],
  });

  return (
    <View style={s.overlay}>
      <View style={s.card}>
        <View style={s.dotsRow}>
          <Animated.View style={[s.dot, dotStyle(dot1)]} />
          <Animated.View style={[s.dot, dotStyle(dot2)]} />
          <Animated.View style={[s.dot, dotStyle(dot3)]} />
        </View>
        <Text style={s.label}>Loading Maya…</Text>
        <Text style={s.sub}>Setting up your tutor</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay:  { ...StyleSheet.absoluteFillObject, backgroundColor: '#0B0F1A', alignItems: 'center', justifyContent: 'center' },
  card:     { alignItems: 'center', gap: 12 },
  dotsRow:  { flexDirection: 'row', gap: 10, height: 24, alignItems: 'flex-end' },
  dot:      { width: 10, height: 10, borderRadius: 5, backgroundColor: '#F5A623' },
  label:    { fontSize: 18, fontWeight: '700', color: '#EDF0F7', letterSpacing: 0.3 },
  sub:      { fontSize: 13, color: '#5A6480' },
});