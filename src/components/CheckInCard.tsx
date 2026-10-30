/**
 * CheckInCard — "How's this going?" with four answers (see engine/useCheckIns.ts)
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { StudentEmotion } from '../engine/emotion';

const ANSWERS: [string, string, StudentEmotion][] = [
  ['😣', 'Frustrated', 'frustrated'],
  ['🤔', 'Confused',   'confused'  ],
  ['🙂', 'Fine',       'neutral'   ],
  ['🤩', 'Great!',     'excited'   ],
];

export default function CheckInCard({ onAnswer, onSkip }: {
  onAnswer: (label: StudentEmotion) => void;
  onSkip:   () => void;
}) {
  return (
    <View style={s.card}>
      <View style={s.header}>
        <Text style={s.title}>How's this going?</Text>
        <TouchableOpacity onPress={onSkip} hitSlop={12}>
          <Text style={s.skip}>Skip</Text>
        </TouchableOpacity>
      </View>
      <View style={s.row}>
        {ANSWERS.map(([emoji, label, value]) => (
          <TouchableOpacity key={value} style={s.answer} onPress={() => onAnswer(value)} accessibilityLabel={label}>
            <Text style={s.emoji}>{emoji}</Text>
            <Text style={s.label}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card:   { position: 'absolute', left: 16, right: 16, bottom: 44, padding: 14, borderRadius: 16,
            backgroundColor: 'rgba(20,25,41,0.95)', borderWidth: 1, borderColor: '#1E2740' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title:  { color: '#EDF0F7', fontSize: 15, fontWeight: '600' },
  skip:   { color: '#5A6480', fontSize: 13 },
  row:    { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  answer: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 12, backgroundColor: '#0B0F1A' },
  emoji:  { fontSize: 24 },
  label:  { color: '#EDF0F7', fontSize: 11, marginTop: 4 },
});
