"""
Extract MediaPipe blendshapes from the DAiSEE dataset.

DAiSEE (https://people.iith.ac.in/vineethnb/resources/daisee/) has ~9,000 ten-second
clips of students in e-learning, each labelled 0–3 for boredom, engagement, confusion
and frustration. Request access and download it yourself; check its licence before
using a model trained on it commercially.

Usage:
  python extract_daisee.py --daisee /path/to/DAiSEE --out data/daisee_frames.csv

Writes one row per sampled frame: subject, clip, label, roll, and the 52 blendshapes.
Resumable: clips already in the output file are skipped, so you can stop and restart.

Label mapping (clip level, levels 0–3):
  frustrated  Frustration >= --min-level and >= Confusion
  confused    Confusion   >= --min-level and >  Frustration
  neutral     Confusion == 0 and Frustration == 0
  (anything in between is skipped as ambiguous)
DAiSEE has no "excited" label; the app keeps its smile rule for that.
"""

import argparse
import csv
import math
import sys
import urllib.request
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

MODEL_URL = ('https://storage.googleapis.com/mediapipe-models/face_landmarker/'
             'face_landmarker/float16/1/face_landmarker.task')
VIDEO_EXTS = {'.avi', '.mp4', '.mov', '.mkv'}


def load_labels(daisee):
    """ClipID (without extension) → (confusion, frustration) from every CSV under Labels/."""
    labels = {}
    for path in sorted((daisee / 'Labels').glob('*.csv')):
        with open(path, newline='') as f:
            reader = csv.DictReader(f)
            # DAiSEE's headers have stray spaces (e.g. "Frustration ")
            reader.fieldnames = [h.strip() for h in reader.fieldnames]
            for row in reader:
                clip = Path(row['ClipID'].strip()).stem
                labels[clip] = (int(row['Confusion']), int(row['Frustration']))
    return labels


def clip_label(confusion, frustration, min_level):
    if frustration >= min_level and frustration >= confusion:
        return 'frustrated'
    if confusion >= min_level and confusion > frustration:
        return 'confused'
    if confusion == 0 and frustration == 0:
        return 'neutral'
    return None


def download_model(model_path, attempts=5):
    """Downloads to a temporary file with a timeout, so a dropped connection never hangs or
    leaves a half-written model under the real name."""
    model_path.parent.mkdir(parents=True, exist_ok=True)
    partial = model_path.with_suffix('.part')
    for attempt in range(1, attempts + 1):
        try:
            print(f'Downloading face model to {model_path} (attempt {attempt}) …')
            with urllib.request.urlopen(MODEL_URL, timeout=30) as response, open(partial, 'wb') as out:
                expected = int(response.headers.get('Content-Length', 0))
                while chunk := response.read(1 << 16):
                    out.write(chunk)
            if expected and partial.stat().st_size != expected:
                raise IOError(f'incomplete: {partial.stat().st_size} of {expected} bytes')
            partial.replace(model_path)
            return
        except (OSError, IOError) as err:
            print(f'  failed: {err}')
    sys.exit(f'Could not download the face model. Download it yourself from\n  {MODEL_URL}\nand save it as {model_path}')


def make_landmarker(model_path):
    if not model_path.exists():
        download_model(model_path)
    options = vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
        output_face_blendshapes=True,
        output_facial_transformation_matrixes=True,
    )
    return vision.FaceLandmarker.create_from_options(options)


def read_frames(path, every_s):
    """Yields RGB frames every `every_s` seconds."""
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps * every_s))
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if index % step == 0:
            yield cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        index += 1
    cap.release()


def measure(landmarker, rgb):
    result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    if not result.face_blendshapes:
        return None
    blendshapes = {c.category_name: round(c.score, 4) for c in result.face_blendshapes[0]}
    # Head roll from the rotation matrix — same formula as the app (atan2(m[1], m[0]) on the
    # column-major array, i.e. row 1 / row 0 of the first column)
    m = result.facial_transformation_matrixes[0]
    roll = math.atan2(m[1][0], m[0][0])
    return blendshapes, roll


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--daisee', type=Path, required=True, help='DAiSEE folder (contains DataSet/ and Labels/)')
    ap.add_argument('--out', type=Path, default=Path('data/daisee_frames.csv'))
    ap.add_argument('--every', type=float, default=1.0, help='seconds between sampled frames (default 1)')
    ap.add_argument('--min-level', type=int, default=2, help='label level that counts as frustrated/confused (default 2)')
    ap.add_argument('--max-clips', type=int, default=0, help='stop after this many clips (0 = all), for a quick trial')
    ap.add_argument('--model', type=Path, default=Path('data/face_landmarker.task'))
    args = ap.parse_args()

    labels = load_labels(args.daisee)
    if not labels:
        sys.exit(f'No label CSVs found under {args.daisee / "Labels"}')
    videos = [p for p in (args.daisee / 'DataSet').rglob('*') if p.suffix.lower() in VIDEO_EXTS]
    print(f'{len(labels)} labelled clips, {len(videos)} videos')

    done = set()
    if args.out.exists():
        with open(args.out, newline='') as f:
            done = {row['clip'] for row in csv.DictReader(f)}
        print(f'Resuming: {len(done)} clips already extracted')

    landmarker = make_landmarker(args.model)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    writer, out = None, open(args.out, 'a', newline='')
    counts = {'clips': 0, 'frames': 0, 'no_face': 0, 'skipped': 0}

    for video in sorted(videos):
        clip = video.stem
        if clip in done or clip not in labels:
            continue
        label = clip_label(*labels[clip], args.min_level)
        if label is None:
            counts['skipped'] += 1
            continue
        subject = video.parent.parent.name  # DataSet/<split>/<subject>/<clip>/<clip>.avi
        for rgb in read_frames(video, args.every):
            measured = measure(landmarker, rgb)
            if measured is None:
                counts['no_face'] += 1
                continue
            blendshapes, roll = measured
            if writer is None:
                fields = ['subject', 'clip', 'label', 'roll'] + sorted(blendshapes)
                writer = csv.DictWriter(out, fieldnames=fields)
                if out.tell() == 0:
                    writer.writeheader()
            writer.writerow({'subject': subject, 'clip': clip, 'label': label, 'roll': round(roll, 4), **blendshapes})
            counts['frames'] += 1
        counts['clips'] += 1
        if counts['clips'] % 100 == 0:
            out.flush()
            print(f"  {counts['clips']} clips, {counts['frames']} frames")
        if args.max_clips and counts['clips'] >= args.max_clips:
            break

    out.close()
    print(f"Done: {counts['clips']} clips → {counts['frames']} frames "
          f"({counts['no_face']} frames without a face, {counts['skipped']} ambiguous clips skipped)")


if __name__ == '__main__':
    main()
