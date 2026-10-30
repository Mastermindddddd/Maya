/**
 * AvatarRenderer
 * ──────────────
 * Renders teacher_maya_tiny.glb using expo-gl + Three.js directly.
 * No expo-three dependency — pure Three.js with the expo-gl context.
 *
 * GLB is loaded via expo-asset → base64 read → ArrayBuffer parse.
 * The GLTFLoader is imported from three/examples/jsm (bundled with three).
 *
 * Shape keys: the ~43 CC4 morph targets kept by strip-morphs.mjs.
 * Animations: all CC clips in the AnimationMixer, cleaned up by removeRootMotion + pruneTracks.
 * Lip sync: visemes open the jaw through the Rigify face bones (works without morphs),
 *           plus the CC4 viseme shape keys when morphs are enabled.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { StyleSheet, Platform } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader';
import { decode, encode } from 'base64-arraybuffer';
import { useSessionStore } from '../store/sessionStore';

// ── Debug / tuning switches ────────────────────────────────────────────────
const DEBUG_NO_ANIMATION    = false;  // true = never play clips (model stays in rest pose)
const DEBUG_NO_MORPHS       = true;   // true = ignore morph targets (no blink / lip shapes; the jaw still moves). Flip to false to test morphs
const DEBUG_PLAIN_SKIN      = false;  // true = plain colours per material instead of the GLB's base-colour textures
const TARGET_FPS            = 30;     // cap the render/animation rate

// ── Types ──────────────────────────────────────────────────────────────────
export type AnimationState =
  | 'idle' | 'talking' | 'talking2' | 'thinking'
  | 'listening' | 'nodding' | 'nodding_long'
  | 'pointing' | 'waving' | 'cheering' | 'clapping';

export const ANIMATION_MAP: Record<AnimationState, string> = {
  idle:         'CC_Breathing',
  talking:      'CC_Talking',
  talking2:     'CC_Talking2',
  thinking:     'CC_Thinking',
  listening:    'CC_Breathing',
  nodding:      'CC_Head_Nod_Yes',
  nodding_long: 'CC_Lenghty_Nod',
  pointing:     'CC_Pointing',
  waving:       'CC_Waving',
  cheering:     'CC_Cheering',
  clapping:     'CC_Clapping',
};

export const SHAPE_KEYS = {
  visemes: ['V_Open','V_Explosive','V_Dental_Lip','V_Tight_O','V_Tight','V_Wide','V_Affricate','V_Lip_Open'],
  eyes:    ['Eye_Blink_L','Eye_Blink_R','Eye_Wide_L','Eye_Wide_R','Eye_Squint_L','Eye_Squint_R',
             'Eye_L_Look_L','Eye_R_Look_L','Eye_L_Look_R','Eye_R_Look_R',
             'Eye_L_Look_Up','Eye_R_Look_Up','Eye_L_Look_Down','Eye_R_Look_Down'],
  brows:   ['Brow_Raise_Inner_L','Brow_Raise_Inner_R','Brow_Raise_Outer_L','Brow_Raise_Outer_R',
             'Brow_Drop_L','Brow_Drop_R','Brow_Compress_L','Brow_Compress_R'],
  mouth:   ['Mouth_Smile_L','Mouth_Smile_R','Mouth_Frown_L','Mouth_Frown_R',
             'Mouth_Close','Jaw_Open','Mouth_Chin_Up'],
  cheeks:  ['Cheek_Raise_L','Cheek_Raise_R','Cheek_Puff_L','Cheek_Puff_R',
             'Nose_Sneer_L','Nose_Sneer_R'],
} as const;

export type VisemeWeights    = Partial<Record<string, number>>;
export type ExpressionWeights = Partial<Record<string, number>>;

interface Props {
  animationState?: AnimationState;
  expression?:     ExpressionWeights;
  onReady?:        () => void;
  onError?:        (err: Error) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────
const FADE_DURATION  = 0.35;
const BLINK_INTERVAL = 4000;
const BLINK_DURATION = 120;
const MORPH_LERP     = 0.18;   // smoothing for expressions
const VISEME_LERP    = 0.55;   // visemes change every ~50ms, so they need much faster smoothing
const VISEME_NAMES   = new Set<string>(SHAPE_KEYS.visemes);
const CLIP_FPS       = 30;     // resample rate for the root-motion fix

// Jaw: how far each viseme opens the mouth (0–1), and the angle at 1
const JAW_MAX_ANGLE = THREE.MathUtils.degToRad(14);
const JAW_OPEN: Record<string, number> = {
  V_Open: 1, V_Tight_O: 0.5, V_Wide: 0.4, V_Tight: 0.35,
  V_Affricate: 0.25, V_Lip_Open: 0.2, V_Dental_Lip: 0.15, V_Explosive: 0.1,
};
// Rigify face bones that follow the jaw, and by how much (lips/cheeks only partly)
const JAW_FOLLOW: Record<string, number> = {
  'jaw_master':        1,     // chin + lower jaw
  'MCH-jaw_master':    1,     // lower lip
  'MCH-jaw_master001': 0.8,   // lower lip corners
  'MCH-jaw_master002': 0.45,  // mouth corners, lower cheeks
  'MCH-jaw_master003': 0.08,  // upper lip
  'MCH-jaw_master004': 0.03,  // upper cheeks, nose
  'ORG-teethB':        1,     // lower teeth
  'MCH-teeth_master':  1,     // tongue
};

// Plain colours by original material name: used in DEBUG_PLAIN_SKIN mode, and whenever a texture is missing.
// null = hide the mesh (transparent overlays and alpha cards look wrong without textures).
const SKIN_COLOUR = '#d9a98a';
const PLAIN_COLOURS: [RegExp, string | null][] = [
  [/Cornea|Occlusion|Tearline|Eyelash|Eyebrows/i, null],
  [/Eye_/i,    '#3b2a22'],
  [/Teeth/i,   '#f2efe6'],
  [/Tongue/i,  '#c4676f'],
  [/Nails/i,   '#e8c5b5'],
];

// Textured mode. The CC eye overlays need CC's custom shaders, so they are hidden.
// The tongue's base-colour slot holds an AO mask, so it gets a plain colour instead.
const HIDDEN_MATERIALS   = /Cornea|Occlusion|Tearline/i;
const UNTEXTURED         = /Tongue/i;
const ROUGHNESS: [RegExp, number][] = [
  [/Eye_/i,    0.2],
  [/Teeth/i,   0.35],
  [/Nails/i,   0.4],
  [/Tongue/i,  0.5],
];

// Eye texture: iris/pupil are placed from the mesh's own UVs, so it works
// whatever the UV layout is. Tune the two angles if the iris looks too big/small.
const IRIS_ANGLE  = THREE.MathUtils.degToRad(32);  // iris half-width as seen from the eye's centre
const PUPIL_ANGLE = THREE.MathUtils.degToRad(13);

const makeEyeTextureFor = (mesh: THREE.SkinnedMesh): THREE.DataTexture | null => {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const uv  = geo.getAttribute('uv');
  if (!pos || !uv) return null;

  geo.computeBoundingSphere();
  const c = geo.boundingSphere!.center;

  // Front of the eye = the vertex sticking out furthest toward +Z (the way the avatar faces)
  let front = 0, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > maxZ) { maxZ = pos.getZ(i); front = i; }
  }
  const fwd = new THREE.Vector3(
    pos.getX(front) - c.x, pos.getY(front) - c.y, pos.getZ(front) - c.z,
  ).normalize();
  const u0 = uv.getX(front), v0 = uv.getY(front);

  // How far (in UV space) do the iris and pupil angles reach?
  const dir = new THREE.Vector3();
  let irisR = 0, pupilR = 0;
  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i) - c.x, pos.getY(i) - c.y, pos.getZ(i) - c.z).normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(dir.dot(fwd), -1, 1));
    const d = Math.hypot(uv.getX(i) - u0, uv.getY(i) - v0);
    if (ang < IRIS_ANGLE)  irisR  = Math.max(irisR, d);
    if (ang < PUPIL_ANGLE) pupilR = Math.max(pupilR, d);
  }
  if (pupilR === 0) pupilR = irisR * 0.4;
  if (irisR === 0) return null;

  const S = 256;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot((x + 0.5) / S - u0, (y + 0.5) / S - v0);
      let col = [245, 242, 238];              // white of the eye
      if (d < irisR)  col = [96, 62, 38];     // iris
      if (d < pupilR) col = [10, 8, 8];       // pupil
      const i = (y * S + x) * 4;
      data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
};

// ── Textures ───────────────────────────────────────────────────────────────
// RN has no Image/Blob, so GLTFLoader can't decode textures itself. Instead each
// base-colour image is written to the cache dir and handed to expo-gl as
// { localUri }, which expo-gl decodes natively inside texImage2D/texSubImage2D.

// Width/height from a PNG or JPEG header (three needs them to allocate the texture)
const imageSize = (b: Uint8Array): { width: number; height: number } | null => {
  if (b[0] === 0x89 && b[1] === 0x50) {
    return {
      width:  (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0,
      height: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0,
    };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }  // fill byte
      // SOFn frame header (C4/C8/CC are other markers)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b[i + 7] << 8 | b[i + 8], height: b[i + 5] << 8 | b[i + 6] };
      }
      i += 2 + (b[i + 2] << 8 | b[i + 3]);
    }
  }
  return null;
};

const expoTexturePlugin = (parser: GLTFParser) => {
  const json = parser.json;
  // Only base-colour maps are used; skip normal/mask maps entirely
  const baseColour = new Set<number>(
    (json.materials ?? [])
      .map((m: any) => m.pbrMetallicRoughness?.baseColorTexture?.index)
      .filter((i: number | undefined) => i !== undefined),
  );
  return {
    name: 'ExpoGLTextures',
    loadTexture: async (index: number) => {
      if (DEBUG_PLAIN_SKIN || !baseColour.has(index)) return null;
      try {
        const source = json.images[json.textures[index].source];
        if (source.bufferView === undefined) return null;
        const bytes: ArrayBuffer = await parser.getDependency('bufferView', source.bufferView);
        const size = imageSize(new Uint8Array(bytes));
        if (!size) return null;

        const ext = source.mimeType === 'image/png' ? 'png' : 'jpg';
        const uri = `${FileSystem.cacheDirectory}avatar-tex-${index}.${ext}`;
        await FileSystem.writeAsStringAsync(uri, encode(bytes), {
          encoding: FileSystem.EncodingType.Base64,
        });

        const tex = new THREE.DataTexture({ localUri: uri } as any, size.width, size.height);
        tex.flipY           = false;  // glTF UVs are top-left
        tex.wrapS           = THREE.RepeatWrapping;
        tex.wrapT           = THREE.RepeatWrapping;
        tex.magFilter       = THREE.LinearFilter;
        tex.minFilter       = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate     = true;
        return tex;
      } catch (err) {
        console.warn('[Avatar] texture failed, using plain colour', index, err);
        return null;
      }
    },
  };
};

const makeMaterial = (mesh: THREE.SkinnedMesh, orig: THREE.MeshStandardMaterial): THREE.Material | null => {
  const name = orig?.name ?? '';
  const rule = PLAIN_COLOURS.find(([re]) => re.test(name));
  const map  = DEBUG_PLAIN_SKIN || UNTEXTURED.test(name) ? null : orig?.map ?? null;

  if (HIDDEN_MATERIALS.test(name)) return null;

  if (map) {
    const alphaCard = /Eyelash/i.test(name);
    return new THREE.MeshStandardMaterial({
      map,
      roughness: ROUGHNESS.find(([re]) => re.test(name))?.[1] ?? 0.65,
      metalness: 0,  // CC exports skin as metallic=1, which renders dark and muddy without an env map
      alphaTest: alphaCard ? 0.5 : 0,
      side:      alphaCard ? THREE.DoubleSide : THREE.FrontSide,
    });
  }
  if (/Eyebrows/i.test(name) && !DEBUG_PLAIN_SKIN) {
    return new THREE.MeshStandardMaterial({ color: orig.color, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  }
  if (rule?.[1] === null) return null;  // e.g. eyelash cards without their alpha texture
  const eyeTex = /Eye_/i.test(name) ? makeEyeTextureFor(mesh) : null;
  return new THREE.MeshStandardMaterial(
    eyeTex
      ? { map: eyeTex, roughness: 0.3 }
      : { color: rule?.[1] ?? SKIN_COLOUR, roughness: 0.7 },
  );
};

// ── Clip clean-up ──────────────────────────────────────────────────────────
// Rigify keeps its parent-switch helpers (MCH-torsoparent, MCH-*_ikparent*) beside
// `root`, not under it, and the CC clips bake a large drifting root motion into
// `root` AND into those siblings. Dropping only some of those tracks makes parts of
// the rig disagree, which tears the face, teeth and arms. Instead, cancel the root's
// motion on every top-level bone: the clip then plays in place with the rig intact.
const removeRootMotion = (clip: THREE.AnimationClip, model: THREE.Object3D) => {
  const rootBone = model.getObjectByName('root');
  if (!rootBone) return;
  const tops: THREE.Object3D[] = [];
  model.traverse(o => { if ((o as THREE.Bone).isBone && !(o.parent as THREE.Bone)?.isBone) tops.push(o); });

  const byName = new Map(clip.tracks.map(t => [t.name, t]));
  const interpolants = new Map<string, THREE.Interpolant>();
  const sample = <T extends THREE.Vector3 | THREE.Quaternion>(bone: THREE.Object3D, prop: 'position' | 'quaternion' | 'scale', t: number, out: T): T => {
    const key = `${bone.name}.${prop}`;
    const track = byName.get(key);
    if (!track) return out.copy(bone[prop] as any) as T;
    if (!interpolants.has(key)) interpolants.set(key, track.createInterpolant());
    return out.fromArray(interpolants.get(key)!.evaluate(t) as any) as T;
  };

  const n     = Math.max(2, Math.round(clip.duration * CLIP_FPS) + 1);
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = Math.min(clip.duration, i / CLIP_FPS);

  const restRoot = new THREE.Matrix4().compose(rootBone.position, rootBone.quaternion, rootBone.scale);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const animRoot = new THREE.Matrix4(), correction = new THREE.Matrix4(), m = new THREE.Matrix4();
  const out = tops.map(() => ({ p: new Float32Array(n * 3), q: new Float32Array(n * 4), s: new Float32Array(n * 3) }));

  for (let i = 0; i < n; i++) {
    const t = times[i];
    animRoot.compose(sample(rootBone, 'position', t, p), sample(rootBone, 'quaternion', t, q).normalize(), sample(rootBone, 'scale', t, s));
    correction.copy(restRoot).multiply(animRoot.invert());  // takes the animated root back to rest
    tops.forEach((bone, k) => {
      m.compose(sample(bone, 'position', t, p), sample(bone, 'quaternion', t, q).normalize(), sample(bone, 'scale', t, s));
      m.premultiply(correction).decompose(p, q, s);
      p.toArray(out[k].p, i * 3); q.toArray(out[k].q, i * 4); s.toArray(out[k].s, i * 3);
    });
  }

  const topNames = new Set(tops.map(b => b.name));
  clip.tracks = clip.tracks.filter(t => !topNames.has(t.name.substring(0, t.name.lastIndexOf('.'))));
  tops.forEach((bone, k) => {
    clip.tracks.push(
      new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, out[k].p),
      new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, out[k].q),
      new THREE.VectorKeyframeTrack(`${bone.name}.scale`, times, out[k].s),
    );
  });
};

// Lossless pruning (≈2175 → ≈200 tracks per clip): drop tracks of bones that never move
// the mesh, and tracks that never leave the bone's rest value (the mixer restores rest
// for those anyway).
const pruneTracks = (clip: THREE.AnimationClip, model: THREE.Object3D, deformBones: Set<string>) => {
  clip.tracks = clip.tracks.filter(t => {
    const dot  = t.name.lastIndexOf('.');
    const name = t.name.substring(0, dot);
    const prop = t.name.substring(dot + 1) as 'position' | 'quaternion' | 'scale';
    const bone = model.getObjectByName(name);
    if (!bone || !deformBones.has(name)) return false;
    const rest   = bone[prop].toArray() as number[];
    const values = t.values;
    for (let i = 0; i < values.length; i++) {
      if (Math.abs(values[i] - rest[i % rest.length]) > 1e-4) return true;
    }
    return false;
  });
};

// Bones that actually move the mesh (skin weight > 0), plus all their ancestors
const findDeformBones = (meshes: THREE.SkinnedMesh[]) => {
  const keep = new Set<string>();
  meshes.forEach(mesh => {
    const si = mesh.geometry.getAttribute('skinIndex');
    const sw = mesh.geometry.getAttribute('skinWeight');
    if (!si || !sw) return;
    const bones = mesh.skeleton.bones;
    for (let i = 0; i < si.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (sw.getComponent(i, k) <= 0) continue;
        let b: THREE.Object3D | null = bones[si.getComponent(i, k)] ?? null;
        while (b && (b as THREE.Bone).isBone && !keep.has(b.name)) {
          keep.add(b.name);
          b = b.parent;
        }
      }
    }
  });
  return keep;
};

// ── Jaw rig ────────────────────────────────────────────────────────────────
// Rotates the jaw-following face bones about the jaw hinge. They all share the
// ORG-face parent, so pivot and axis are computed once in that space.
type JawRig = { restore: () => void; open: (angle: number) => void };

const makeJawRig = (model: THREE.Object3D): JawRig | null => {
  const hinge = model.getObjectByName('jaw_master');
  if (!hinge?.parent) return null;
  model.updateMatrixWorld(true);
  const toFace = hinge.parent.matrixWorld.clone().invert();
  const axis   = new THREE.Vector3(1, 0, 0).transformDirection(toFace);  // the face's left–right axis
  const pivot  = hinge.position.clone();
  const bones  = Object.entries(JAW_FOLLOW)
    .map(([name, follow]) => ({ bone: model.getObjectByName(name), follow }))
    .filter((j): j is { bone: THREE.Object3D; follow: number } => !!j.bone && j.bone.parent === hinge.parent)
    .map(j => ({ ...j, basePos: j.bone.position.clone(), baseQuat: j.bone.quaternion.clone(), opened: false }));
  const q = new THREE.Quaternion();
  return {
    // Called before mixer.update: undoes last frame's offset so it never accumulates. Restores the
    // pre-offset pose rather than rest, because the mixer skips writing values that didn't change.
    restore: () => bones.forEach(j => {
      if (!j.opened) return;
      j.bone.position.copy(j.basePos);
      j.bone.quaternion.copy(j.baseQuat);
      j.opened = false;
    }),
    open: (angle: number) => {
      if (angle <= 0) return;
      bones.forEach(j => {
        j.basePos.copy(j.bone.position);
        j.baseQuat.copy(j.bone.quaternion);
        j.opened = true;
        q.setFromAxisAngle(axis, angle * j.follow);
        j.bone.position.sub(pivot).applyQuaternion(q).add(pivot);
        j.bone.quaternion.premultiply(q);
      });
    },
  };
};

// ── Component ──────────────────────────────────────────────────────────────
export default function AvatarRenderer({
  animationState = 'idle',
  expression     = {},
  onReady,
  onError,
}: Props) {
  const glRef            = useRef<ExpoWebGLRenderingContext | null>(null);
  const rendererRef      = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef         = useRef<THREE.Scene | null>(null);
  const cameraRef        = useRef<THREE.PerspectiveCamera | null>(null);
  const mixerRef         = useRef<THREE.AnimationMixer | null>(null);
  const actionsRef       = useRef<Map<string, THREE.AnimationAction>>(new Map());
  const currentActionRef = useRef<THREE.AnimationAction | null>(null);
  const clockRef         = useRef(new THREE.Clock());
  const rafRef           = useRef<number | null>(null);
  const meshRefs         = useRef<THREE.SkinnedMesh[]>([]);
  // Morph target indices are per-mesh; the same name can have a different index on another mesh.
  const morphIndices     = useRef<Map<THREE.SkinnedMesh, Map<string, number>>>(new Map());
  const targetMorphs     = useRef<Map<string, number>>(new Map());
  const currentMorphs    = useRef<Map<string, number>>(new Map());
  const jawRef           = useRef<JawRig | null>(null);
  const animStateRef     = useRef<AnimationState>(animationState);
  const blinkTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Morph helpers ────────────────────────────────────────────────────────
  const setMorph = useCallback((name: string, weight: number) => {
    targetMorphs.current.set(name, Math.max(0, Math.min(1, weight)));
  }, []);

  // Smooths every named weight once per frame and writes it to the meshes.
  // Returns how far the jaw should open (0–1) from the current visemes.
  const applyMorphs = useCallback(() => {
    let jaw = 0;
    targetMorphs.current.forEach((target, name) => {
      const current = currentMorphs.current.get(name) ?? 0;
      const lerp    = VISEME_NAMES.has(name) ? VISEME_LERP : MORPH_LERP;
      const next    = current + (target - current) * lerp;
      currentMorphs.current.set(name, next);
      jaw += next * (JAW_OPEN[name] ?? 0);
    });
    // Write each weight using that mesh's own morph-target index; leave other morphs alone.
    meshRefs.current.forEach(mesh => {
      const meshIndices = morphIndices.current.get(mesh);
      if (!meshIndices || !mesh.morphTargetInfluences) return;
      currentMorphs.current.forEach((weight, name) => {
        const index = meshIndices.get(name);
        if (index !== undefined) mesh.morphTargetInfluences![index] = weight;
      });
    });
    return Math.min(1, jaw);
  }, []);

  // ── Auto-blink ────────────────────────────────────────────────────────────
  const scheduleBlink = useCallback(() => {
    const delay = BLINK_INTERVAL + (Math.random() - 0.5) * 1500;
    blinkTimer.current = setTimeout(() => {
      setMorph('Eye_Blink_L', 1.0);
      setMorph('Eye_Blink_R', 1.0);
      blinkTimer.current = setTimeout(() => {
        setMorph('Eye_Blink_L', 0.0);
        setMorph('Eye_Blink_R', 0.0);
        scheduleBlink();
      }, BLINK_DURATION);
    }, delay);
  }, [setMorph]);

  // ── Animation switch ──────────────────────────────────────────────────────
  const switchAnimation = useCallback((state: AnimationState) => {
    if (DEBUG_NO_ANIMATION) return;
    const clipName  = ANIMATION_MAP[state];
    const newAction = actionsRef.current.get(clipName);
    if (!newAction) {
      console.warn(`[Avatar] clip not found: ${clipName}`);
      return;
    }
    const prev = currentActionRef.current;
    if (prev === newAction) return;
    newAction.reset().setEffectiveWeight(1).fadeIn(FADE_DURATION).play();
    if (prev) prev.fadeOut(FADE_DURATION);
    currentActionRef.current = newAction;
  }, []);

  // ── Load GLB ──────────────────────────────────────────────────────────────
  const loadModel = useCallback(async (
    scene: THREE.Scene,
    mixer: THREE.AnimationMixer,
  ) => {
    // Resolve the bundled asset
    const asset = Asset.fromModule(require('../../assets/models/teacher_maya_tiny.glb'));
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;

    // Read as base64 → ArrayBuffer (works on both iOS and Android)
    const b64    = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = decode(b64);

    // RN has a navigator object but no userAgent; GLTFLoader's constructor needs one
    if (typeof navigator !== 'undefined' && !(navigator as any).userAgent) {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'ReactNative',
        configurable: true,
      });
    }

    const loader = new GLTFLoader();
    loader.register(expoTexturePlugin as any);

    await new Promise<void>((resolve, reject) => {
      loader.parse(binary, '', gltf => {
        const model = gltf.scene;

        // The GLB is already in metres (bbox 0 → 1.7 on Y)
        model.scale.setScalar(1);
        model.position.set(0, 0, 0);
        model.frustumCulled = false;
        scene.add(model);

        // Collect skinned meshes + morph dictionaries
        model.traverse(child => {
          if (!(child instanceof THREE.SkinnedMesh)) return;
          meshRefs.current.push(child);
          child.frustumCulled = false;
          child.castShadow    = false;

          const orig     = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.MeshStandardMaterial;
          const material = makeMaterial(child, orig);
          if (material) child.material = material;
          else          child.visible  = false;

          if (DEBUG_NO_MORPHS) {
            child.geometry.morphAttributes = {};
            child.morphTargetInfluences = undefined;
            child.morphTargetDictionary = undefined;
            return;
          }

          // Build this mesh's own name → index map from its morphTargetDictionary
          const dict = child.morphTargetDictionary;
          if (dict) {
            const perMesh = new Map<string, number>();
            Object.entries(dict).forEach(([name, idx]) => {
              perMesh.set(name, idx as number);
            });
            morphIndices.current.set(child, perMesh);
          }
        });

        // GLTFLoader gives every mesh its own copy of the 725-bone skeleton; they all use the
        // same skin, so share one and the bone matrices are computed/uploaded once per frame.
        const shared = meshRefs.current[0]?.skeleton;
        meshRefs.current.forEach(mesh => {
          const sk = mesh.skeleton;
          if (sk === shared || sk.bones.length !== shared.bones.length) return;
          const same = sk.bones.every((b, i) => b === shared.bones[i] && sk.boneInverses[i].equals(shared.boneInverses[i]));
          if (same) mesh.skeleton = shared;
        });

        // Register all animation clips, cleaned up so they play in place and cheaply
        const deformBones = findDeformBones(meshRefs.current);
        gltf.animations.forEach(clip => {
          removeRootMotion(clip, model);
          pruneTracks(clip, model, deformBones);
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          actionsRef.current.set(clip.name, action);
        });

        jawRef.current = makeJawRig(model);

        console.log('[Avatar] Clips:', [...actionsRef.current.keys()]);
        console.log('[Avatar] Meshes with shape keys:', morphIndices.current.size);

        // Start idle
        const idle = actionsRef.current.get(ANIMATION_MAP['idle']);
        if (idle && !DEBUG_NO_ANIMATION) {
          idle.play();
          currentActionRef.current = idle;
        }

        resolve();
      }, reject);
    });
  }, []);

  // ── GL context ready ──────────────────────────────────────────────────────
  const onContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
    try {
      glRef.current = gl;

      // expo-gl can return undefined for empty info logs; Three calls .trim() on them
      const origShaderLog  = gl.getShaderInfoLog.bind(gl);
      const origProgramLog = gl.getProgramInfoLog.bind(gl);
      gl.getShaderInfoLog  = (s: any) => origShaderLog(s)  ?? '';
      gl.getProgramInfoLog = (p: any) => origProgramLog(p) ?? '';

      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;

      // ── Renderer (with a shim canvas, since RN has no DOM) ───────────────
      const canvas = {
        width: W,
        height: H,
        clientWidth: W,
        clientHeight: H,
        style: {},
        addEventListener: () => {},
        removeEventListener: () => {},
      } as any;

      const renderer = new THREE.WebGLRenderer({
        canvas,
        context: gl as unknown as WebGLRenderingContext,
        antialias: false,                 // cheaper; the GLView already has MSAA on iOS
      });
      renderer.setSize(W, H, false);      // false = don't touch canvas.style
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled   = false; // shadows were a big cost for little gain
      renderer.outputColorSpace    = THREE.SRGBColorSpace;
      renderer.toneMapping         = THREE.NeutralToneMapping;  // keeps the toon skin colours (ACES washed them out)
      renderer.toneMappingExposure = 1.0;
      rendererRef.current = renderer;

      // Surface real shader compile errors instead of failing silently
      renderer.debug.onShaderError = (g: any, program: any, vs: any, fs: any) => {
        console.error('[Avatar] shader error VS:', g.getShaderInfoLog(vs));
        console.error('[Avatar] shader error FS:', g.getShaderInfoLog(fs));
        console.error('[Avatar] shader error program:', g.getProgramInfoLog(program));
      };

      // ── Scene ─────────────────────────────────────────────────────────────
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#0B0F1A');
      sceneRef.current = scene;

      // ── Camera: bust portrait framing ─────────────────────────────────────
      const camera = new THREE.PerspectiveCamera(28, W / H, 0.01, 100);
      camera.position.set(0, 1.5, 1.6);
      camera.lookAt(0, 1.45, 0);
      cameraRef.current = camera;

      // ── Lighting ──────────────────────────────────────────────────────────
      const key = new THREE.DirectionalLight(0xFFF5E0, 2.0);   // warm key, upper-left
      key.position.set(-1.5, 3, 2);
      scene.add(key);

      const fill = new THREE.DirectionalLight(0xCCE0FF, 0.7);   // cool fill, right
      fill.position.set(2, 1.5, 1);
      scene.add(fill);

      scene.add(new THREE.HemisphereLight(0xFFF4EA, 0x40384A, 1.0));  // soft sky/ground ambient

      // ── Mixer ─────────────────────────────────────────────────────────────
      const mixer = new THREE.AnimationMixer(scene);
      mixerRef.current = mixer;

      // ── Render loop (capped), started BEFORE loading so a frame is always drawn ──
      let lastFrame = 0;
      const frameMs = 1000 / TARGET_FPS;
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const now = Date.now();
        if (now - lastFrame < frameMs) return;
        lastFrame = now;
        const delta = clockRef.current.getDelta();
        jawRef.current?.restore();
        mixer.update(delta);
        const jaw = applyMorphs();
        jawRef.current?.open(jaw * JAW_MAX_ANGLE);
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      tick();

      // ── Load model, with a timeout so a hang becomes a visible error ──────
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Model load timed out after 45s')), 45000),
      );
      await Promise.race([loadModel(scene, mixer), timeout]);

      scheduleBlink();
      onReady?.();
    } catch (err) {
      console.error('[Avatar] fatal:', err);
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }, [loadModel, applyMorphs, scheduleBlink, onReady, onError]);

  // ── Sync animation state prop ─────────────────────────────────────────────
  useEffect(() => {
    if (animStateRef.current !== animationState) {
      animStateRef.current = animationState;
      switchAnimation(animationState);
    }
  }, [animationState, switchAnimation]);

  // ── Sync viseme weights ───────────────────────────────────────────────────
  // Read straight from the store: visemes change every ~25ms while speaking, and
  // passing them as a prop re-rendered the whole session screen each time.
  useEffect(() => {
    const apply = (weights: VisemeWeights) => {
      SHAPE_KEYS.visemes.forEach(v => setMorph(v, 0));
      Object.entries(weights).forEach(([k, v]) => {
        if (v !== undefined) setMorph(k, v);
      });
    };
    apply(useSessionStore.getState().visemeWeights);
    return useSessionStore.subscribe((state, prev) => {
      if (state.visemeWeights !== prev.visemeWeights) apply(state.visemeWeights);
    });
  }, [setMorph]);

  // ── Sync expression weights ───────────────────────────────────────────────
  useEffect(() => {
    Object.entries(expression).forEach(([k, v]) => {
      if (v !== undefined) setMorph(k, v);
    });
  }, [expression, setMorph]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (rafRef.current)     cancelAnimationFrame(rafRef.current);
      if (blinkTimer.current) clearTimeout(blinkTimer.current);
      rendererRef.current?.dispose();
      mixerRef.current?.stopAllAction();
    };
  }, []);

  return (
    <GLView
      style={StyleSheet.absoluteFill}
      onContextCreate={onContextCreate}
      msaaSamples={Platform.OS === 'ios' ? 4 : 0}
    />
  );
}
