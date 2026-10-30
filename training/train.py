"""
Train the expression classifier and export it for the app.

Data sources (use either or both):
  --daisee   data/daisee_frames.csv        from extract_daisee.py
  --checkins emotion-checkins.jsonl ...    exported from the app ("Check-ins" chip)

  python train.py --daisee data/daisee_frames.csv --checkins exports/*.jsonl

Evaluation is always on people the model has never seen (grouped cross-validation by
student), because that is the situation in the app. The trained model is compared with
the current rules on exactly the same readings, and is only written to
../assets/emotion-model.json if it does better (use --force to write it anyway).

The model is a multinomial logistic regression on the 52 blendshapes + head roll, each
relative to the student's resting face — small, fast, and easy to inspect.
"""

import argparse
import json
import sys
import warnings
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, confusion_matrix, f1_score
from sklearn.model_selection import GroupKFold
from sklearn.metrics import precision_score, recall_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

from features import CLASSES, MIN_CONFIDENCE, ROLL, feature_names, feature_vector, rule_decision

HERE = Path(__file__).resolve().parent
MIN_STD = 0.005   # features that barely vary in training are dropped: on a new face they can explode
CLIP = 6.0        # standardised values are capped at ±CLIP (the app does the same)
# Harmless noise from scikit-learn 1.5 with newer SciPy releases
warnings.filterwarnings('ignore', message='Unknown solver options')


# ── Loading ───────────────────────────────────────────────────────────────
# Every source becomes a list of samples: (group, label, blendshapes, roll, baseline, base_roll)

def load_daisee(path):
    df = pd.read_csv(path)
    meta = {'subject', 'clip', 'label', ROLL}
    shape_cols = [c for c in df.columns if c not in meta]
    samples = []
    for subject, rows in df.groupby('subject'):
        # Resting face: the student's median over their calm clips (all clips if none are calm).
        # The app learns the same thing live from its first readings.
        calm = rows[rows['label'] == 'neutral']
        rest = calm if len(calm) >= 5 else rows
        baseline = rest[shape_cols].median().to_dict()
        base_roll = float(rest[ROLL].median())
        # to_dict, not itertuples: itertuples renames columns starting with "_" (MediaPipe's "_neutral")
        for d in rows.to_dict('records'):
            samples.append((f'daisee:{subject}', d['label'], {c: d[c] for c in shape_cols}, d[ROLL], baseline, base_roll))
    return samples


def load_checkins(paths):
    samples = []
    for path in paths:
        for line in Path(path).read_text().splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            for s in rec['samples']:
                samples.append((f"app:{rec['participant']}", rec['label'], s['blendshapes'], s['roll'],
                                rec['baseline'], rec['baseRoll']))
    return samples


# ── Training ──────────────────────────────────────────────────────────────

def clip(z):
    return np.clip(z, -CLIP, CLIP)


def make_model():
    return make_pipeline(StandardScaler(), FunctionTransformer(clip),
                         LogisticRegression(class_weight='balanced', C=0.5, max_iter=5000))


def app_decision(probabilities, classes, threshold):
    """What the app reacts to: the top class if it isn't neutral and is confident enough."""
    out = []
    for p in probabilities:
        k = int(np.argmax(p))
        out.append(classes[k] if classes[k] != 'neutral' and p[k] >= threshold else 'neutral')
    return np.array(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--daisee', type=Path, help='CSV from extract_daisee.py')
    ap.add_argument('--checkins', type=Path, nargs='*', default=[], help='JSONL files exported from the app')
    ap.add_argument('--out', type=Path, default=HERE.parent / 'assets' / 'emotion-model.json')
    ap.add_argument('--folds', type=int, default=5)
    ap.add_argument('--min-probability', type=float, default=MIN_CONFIDENCE,
                    help=f'how sure the model must be before Maya reacts (default {MIN_CONFIDENCE})')
    ap.add_argument('--min-precision', type=float, default=0.5,
                    help='each emotion must be right at least this often when Maya reacts to it (default 0.5)')
    ap.add_argument('--force', action='store_true', help='write the model even if it fails the checks')
    args = ap.parse_args()

    samples = (load_daisee(args.daisee) if args.daisee else []) + load_checkins(args.checkins)
    samples = [s for s in samples if s[1] in CLASSES]
    if not samples:
        sys.exit('No training data: pass --daisee and/or --checkins')

    names = feature_names(samples[0][2].keys())
    X = np.stack([feature_vector(names, b, roll, base, base_roll) for _, _, b, roll, base, base_roll in samples])
    keep = X.std(0) >= MIN_STD
    dropped = [n for n, k in zip(names, keep) if not k]
    names, X = [n for n, k in zip(names, keep) if k], X[:, keep]
    if dropped:
        print(f'Dropped {len(dropped)} features that barely vary in this data: {", ".join(dropped)}')
    y = np.array([s[1] for s in samples])
    groups = np.array([s[0] for s in samples])
    rules = np.array([rule_decision(b, base, roll, base_roll) for _, _, b, roll, base, base_roll in samples])

    classes = [c for c in CLASSES if c in set(y)]
    print(f'{len(y)} readings from {len(set(groups))} students — ' +
          ', '.join(f'{c}: {n}' for c, n in sorted(Counter(y).items(), key=lambda kv: CLASSES.index(kv[0]))))
    if len(classes) < 2:
        sys.exit('Need at least two different labels to train')

    folds = min(args.folds, len(set(groups)))
    if folds < 2:
        sys.exit('Need readings from at least two different students (evaluation is on unseen students)')

    # Cross-validated predictions, each made by a model that never saw that student
    probabilities = np.zeros((len(y), len(classes)))
    for train_idx, test_idx in GroupKFold(n_splits=folds).split(X, y, groups):
        model = make_model().fit(X[train_idx], y[train_idx])
        order = [list(model.classes_).index(c) for c in classes]
        probabilities[test_idx] = model.predict_proba(X[test_idx])[:, order]
    predicted = app_decision(probabilities, classes, args.min_probability)

    # Only score the labels the model can predict (e.g. DAiSEE has no "excited")
    mask = np.isin(y, classes)
    model_f1 = f1_score(y[mask], predicted[mask].astype(str), labels=classes, average='macro', zero_division=0)
    rules_f1 = f1_score(y[mask], rules[mask], labels=classes, average='macro', zero_division=0)

    print(f'\n── Trained model, on unseen students ({folds}-fold) ──')
    print(classification_report(y[mask], predicted[mask].astype(str), labels=classes, zero_division=0))
    print('Confusion matrix (rows = true, columns = predicted):', classes)
    print(confusion_matrix(y[mask], predicted[mask].astype(str), labels=classes))
    print('\n── Current rules, same readings ──')
    print(classification_report(y[mask], rules[mask], labels=classes, zero_division=0))
    print(f'Macro F1 — model {model_f1:.3f} vs rules {rules_f1:.3f}')

    # When Maya reacts, how often is she right? (precision) — and how often does a calm student
    # set her off? Precision matters most: a wrong "you seem frustrated" is worse than a miss.
    emotions = [c for c in classes if c != 'neutral']
    print('\n── If Maya only reacts above a threshold ──')
    for t in sorted({args.min_probability, 0.45, 0.6, 0.7}):
        pred = app_decision(probabilities, classes, t)
        cells = [f'{c}: right {precision_score(y, pred, labels=[c], average="macro", zero_division=0):.0%} '
                 f'of the time, catches {recall_score(y, pred, labels=[c], average="macro", zero_division=0):.0%}'
                 for c in emotions]
        alarms = np.mean(pred[y == 'neutral'] != 'neutral') if 'neutral' in classes else float('nan')
        print(f'  {t:.2f}  ' + ' | '.join(cells) + f' | calm readings misread: {alarms:.1%}')

    precision = {c: precision_score(y, predicted, labels=[c], average='macro', zero_division=0) for c in emotions}
    weak = [c for c, p in precision.items() if p < args.min_precision]
    problems = []
    if model_f1 <= rules_f1:
        problems.append('it does not beat the rules')
    if weak:
        problems.append('when Maya reacts to ' + ', '.join(f'{c} she would be right only {precision[c]:.0%} of the time'
                                                           for c in weak) + f' (needs {args.min_precision:.0%})')
    if problems and not args.force:
        sys.exit('\nNot exporting the model: ' + '; '.join(problems) + '.\n'
                 'The app keeps its current classifier. Collect more data (app check-ins), or pass --force.')

    # Final model on all data
    final = make_model().fit(X, y)
    scaler, logreg = final.named_steps['standardscaler'], final.named_steps['logisticregression']
    precision = {c: precision_score(y, predicted, labels=[c], average='macro', zero_division=0) for c in emotions}
    exported = {
        'version': 1,
        'trained': True,
        'classes': list(logreg.classes_),
        'features': names,
        'mean': np.round(scaler.mean_, 6).tolist(),
        'scale': np.round(scaler.scale_, 6).tolist(),
        'coef': np.round(logreg.coef_, 6).tolist(),
        'intercept': np.round(logreg.intercept_, 6).tolist(),
        'clip': CLIP,
        'minProbability': args.min_probability,
        'evaluation': {'macroF1': round(model_f1, 3), 'rulesMacroF1': round(rules_f1, 3),
                       'precision': {c: round(p, 3) for c, p in precision.items()},
                       'readings': int(len(y)), 'students': int(len(set(groups)))},
    }
    # Binary logistic regression stores one row; expand to one row per class for the app
    if len(exported['classes']) == 2:
        c = np.array(exported['coef'][0]); b = exported['intercept'][0]
        exported['coef'] = [(-c / 2).round(6).tolist(), (c / 2).round(6).tolist()]
        exported['intercept'] = [round(-b / 2, 6), round(b / 2, 6)]
    args.out.write_text(json.dumps(exported, indent=1))
    print(f'\nWrote {args.out}')


if __name__ == '__main__':
    main()
