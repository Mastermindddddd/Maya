/**
 * Trained expression model
 * ────────────────────────
 * Loads assets/emotion-model.json, written by training/train.py. Until a model has been
 * trained (the file says "trained": false), the classifier keeps using its rules.
 *
 * The model is a multinomial logistic regression over the features listed in the file:
 * each blendshape minus the student's resting value, plus head roll minus resting roll.
 */

import type { StudentEmotion } from './emotion';

export type EmotionModel = {
  version:         number;
  trained:         boolean;
  classes:         StudentEmotion[];
  features:        string[];
  mean:            number[];
  scale:           number[];
  coef:            number[][];  // one row per class
  intercept:       number[];
  clip?:           number;      // standardised values are capped at ±clip, as in training
  minProbability?: number;      // how sure the model must be before Maya reacts
};

export const EMOTION_MODEL: EmotionModel | null = (() => {
  const model = require('../../assets/emotion-model.json') as EmotionModel;
  return model?.trained ? model : null;
})();

/** Class probabilities for one feature vector (in the model's feature order) */
export function predictProbabilities(model: EmotionModel, x: number[]): number[] {
  const cap = model.clip ?? Infinity;
  const z = x.map((v, i) => Math.max(-cap, Math.min(cap, (v - model.mean[i]) / (model.scale[i] || 1))));
  const logits = model.coef.map((row, k) => row.reduce((sum, w, i) => sum + w * z[i], model.intercept[k]));
  const max = Math.max(...logits);
  const exp = logits.map(l => Math.exp(l - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map(e => e / total);
}
