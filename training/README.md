# Training Maya's expression classifier

The app reads the student's face with MediaPipe Face Landmarker (52 blendshape scores +
head tilt, all on the phone). A classifier turns those numbers into *neutral*,
*frustrated*, *confused* or *excited*. Out of the box that classifier is a set of
hand-written rules (`src/engine/expressionClassifier.ts`). This folder trains a model to
replace them, from two kinds of data:

| Source | What it is | Labels |
|---|---|---|
| **DAiSEE** | ~9,000 10-second clips of students in e-learning | confusion, frustration (no "excited") |
| **App check-ins** | Maya asks "How's this going?"; answers saved with face measurements | all four |

DAiSEE gives volume; check-ins match your real students, cameras and lighting. Use both
when you can.

## Setup

```bash
cd training
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## 1. DAiSEE

1. Request access and download DAiSEE from
   <https://people.iith.ac.in/vineethnb/resources/daisee/>. **Check its licence** before
   shipping a model trained on it in a commercial app.
2. Extract the face measurements (resumable; a full run takes a while):

   ```bash
   python extract_daisee.py --daisee /path/to/DAiSEE --out data/daisee_frames.csv
   # quick trial first:  --max-clips 200
   ```

## 2. App check-ins

With the expression camera on, Maya asks "How's this going?" every few minutes, but
only after the student (or a parent) agrees to saving check-ins. Only numbers are saved,
never images.

To get them off the phone: tap **⇪ Check-ins (N)** at the end of the test-chip row →
**Export**, and send the file to your computer (e-mail, Drive, …). Save each phone's export
under a different name, e.g. `exports/phone-a.jsonl`.

Aim for a few hundred check-ins from at least 20–30 different people. Evaluation is always
on people the model hasn't seen, so the number of *people* matters more than the number of
check-ins.

## 3. Train

```bash
python train.py --daisee data/daisee_frames.csv --checkins exports/*.jsonl
```

The script prints how the trained model and the current rules do **on students it never
saw**, side by side. It only writes `../assets/emotion-model.json` if the model does
better (`--force` writes it anyway). Then reload the app: it uses the model automatically.
To go back to the rules, restore the file to `{ "version": 1, "trained": false }`.

Classes the model wasn't trained on keep using the rules (with DAiSEE only, "excited"
stays the smile rule).

## Keeping app and training in sync

`features.py` must compute exactly what the app computes: each blendshape minus the
student's resting value, plus head roll minus resting roll. The rules in `features.py`
are a copy of the app's rules, used only to check that a trained model really beats them.
If you change one side, change the other.

## Privacy

`data/` and `exports/` are git-ignored: check-ins come from real students. Keep them
somewhere access-controlled, and delete them when they're no longer needed.
