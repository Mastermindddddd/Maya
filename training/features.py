"""
Shared feature definitions — must match src/engine/expressionClassifier.ts exactly.

A sample is one MediaPipe FaceLandmarker reading: 52 blendshape scores (0–1) and the head
roll in radians, plus the student's resting-face baseline at that moment. The model sees
every value *relative to the baseline*, the same way the app does.
"""

import numpy as np

CLASSES = ['neutral', 'frustrated', 'confused', 'excited']
ROLL = 'roll'

# The app reacts when a reading's confidence is at least this (EmotionStateMachine)
MIN_CONFIDENCE = 0.45


def feature_names(blendshape_names):
    """Stable feature order: blendshapes alphabetically, then roll."""
    return sorted(n for n in blendshape_names if n != ROLL) + [ROLL]


def feature_vector(names, blendshapes, roll, baseline, base_roll):
    return np.array([
        (roll - base_roll) if n == ROLL else blendshapes.get(n, 0.0) - baseline.get(n, 0.0)
        for n in names
    ], dtype=np.float64)


# ── Rule-based classifier (port of ExpressionClassifier.scores) ─────────────
# Used to check a trained model actually beats the rules before shipping it.
NEUTRAL_SCORE = 0.15
FULL_SCORE = 0.6


def rule_scores(b, base, roll, base_roll):
    f = lambda n: max(0.0, b.get(n, 0.0) - base.get(n, 0.0))
    pair = lambda n: (f(n + 'Left') + f(n + 'Right')) / 2
    smile, cheek, eye_wide = pair('mouthSmile'), pair('cheekSquint'), pair('eyeWide')
    brow_down, press, frown, sneer = pair('browDown'), pair('mouthPress'), pair('mouthFrown'), pair('noseSneer')
    asym_now = abs(b.get('browOuterUpLeft', 0.0) - b.get('browOuterUpRight', 0.0))
    asym_rest = abs(base.get('browOuterUpLeft', 0.0) - base.get('browOuterUpRight', 0.0))
    brow_asym = max(0.0, asym_now - asym_rest)
    mouth_side = max(f('mouthLeft'), f('mouthRight'))
    pucker = f('mouthPucker')
    tilt = abs(roll - base_roll)
    return {
        'excited': 1.6 * smile + 0.5 * cheek + 0.3 * eye_wide,
        'frustrated': 1.3 * brow_down + 0.9 * press + 0.8 * frown + 0.6 * sneer - 1.0 * smile,
        'confused': 1.4 * brow_asym + 0.6 * brow_down + 0.8 * mouth_side + 0.5 * pucker + 1.5 * tilt
                    - 0.8 * smile - 0.5 * press,
    }


def rule_decision(b, base, roll, base_roll):
    """What the app would react to with the rules: an emotion, or 'neutral'."""
    scores = rule_scores(b, base, roll, base_roll)
    emotion, score = max(scores.items(), key=lambda kv: kv[1])
    confidence = min(1.0, score / FULL_SCORE)
    return emotion if score >= NEUTRAL_SCORE and confidence >= MIN_CONFIDENCE else 'neutral'
