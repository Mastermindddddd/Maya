/**
 * AvatarRenderer
 * ──────────────
 * Renders teacher_maya_opt.glb using expo-gl + Three.js directly.
 * No expo-three dependency — pure Three.js with the expo-gl context.
 *
 * GLB is loaded via expo-asset → base64 read → ArrayBuffer parse.
 * The GLTFLoader is imported from three/examples/jsm (bundled with three).
 * Call preloadAvatar() early (HomeScreen does) so the session screen opens fast.
 *
 * The GLB is produced by optimize-model.mjs (root motion removed, unused tracks,
 * meshes and textures dropped, morph targets sparse) — rerun it after changing the model.
 * Shape keys: the ~43 CC4 morph targets kept by strip-morphs.mjs.
 * Animations: all CC clips in the AnimationMixer.
 * Lip sync: visemes open the jaw through the Rigify face bones (works without morphs),
 *           plus the CC4 viseme shape keys when morphs are enabled.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { StyleSheet, Platform } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTF, GLTFLoader, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader';
import { decode, encode } from 'base64-arraybuffer';
import { useSessionStore } from '../store/sessionStore';

// ── Debug / tuning switches ────────────────────────────────────────────────
const DEBUG_NO_ANIMATION    = false;  // true = never play clips (model stays in rest pose)
const DEBUG_NO_MORPHS       = false;  // true = ignore morph targets (no blink / lip shapes / expressions; the jaw still moves)
const DEBUG_PLAIN_SKIN      = false;  // true = plain colours per material instead of the GLB's base-colour textures
const TARGET_FPS            = 60;     // cap the render/animation rate; drop to 30 if the phone runs hot or the UI gets sluggish

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
  onGestureFinished?: () => void;  // a one-shot gesture (nod, wave…) ended and she went back to her loop
}

// ── Constants ──────────────────────────────────────────────────────────────
const FADE_DURATION  = 0.5;
const MAX_DELTA      = 0.1;    // seconds; a long stall (GC, loading) shouldn't make her jump
// States that loop; everything else is a one-shot gesture
const LOOPING_STATES = new Set<AnimationState>(['idle', 'listening', 'talking', 'talking2', 'thinking']);
const LOOPING_CLIPS  = new Set([...LOOPING_STATES].map(state => ANIMATION_MAP[state]));
const BLINK_INTERVAL = 4000;
const BLINK_DURATION = 120;
// Smoothing time constants (seconds), so they're the same at any frame rate
const MORPH_TAU      = 0.12;   // expressions
const VISEME_TAU     = 0.05;   // mouth shapes change every ~60ms while speaking
const BLINK_TAU      = 0.03;   // a blink lasts 120ms, so it has to close fast
const VISEME_NAMES   = new Set<string>(SHAPE_KEYS.visemes);
const BLINK_NAMES    = new Set<string>(['Eye_Blink_L', 'Eye_Blink_R']);
// The two talking clips alternate each loop, so talking doesn't repeat every 4 s
const TALK_ALTERNATE: Record<string, string> = { CC_Talking: 'CC_Talking2', CC_Talking2: 'CC_Talking' };

// Jaw: how far each viseme opens the mouth (0–1), and the angle at 1
const JAW_MAX_ANGLE = THREE.MathUtils.degToRad(14);
const JAW_OPEN: Record<string, number> = {
  V_Open: 1, V_Tight_O: 0.6, V_Wide: 0.55, V_Tight: 0.45,
  V_Explosive: 0.15, V_Affricate: 0.12, V_Lip_Open: 0.15, V_Dental_Lip: 0.1,
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

// ── Model loading (shared, so it can start before the session screen) ───────
type AvatarModel = {
  model:      THREE.Group;
  animations: THREE.AnimationClip[];
  meshes:     THREE.SkinnedMesh[];
  resetPose:  () => void;  // puts every bone back to its rest pose
};

// While morphs are disabled, don't even decode them: drop the targets from the JSON first
const skipMorphsPlugin = (parser: GLTFParser) => ({
  name: 'SkipMorphs',
  beforeRoot: () => {
    (parser.json.meshes ?? []).forEach((mesh: any) => {
      mesh.primitives.forEach((prim: any) => delete prim.targets);
      delete mesh.weights;
      if (mesh.extras) delete mesh.extras.targetNames;
    });
  },
});

const loadAvatarModel = async (): Promise<AvatarModel> => {
  // Resolve the bundled asset
  const asset = Asset.fromModule(require('../../assets/models/teacher_maya_opt.glb'));
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
  if (DEBUG_NO_MORPHS) loader.register(skipMorphsPlugin as any);
  const gltf = await new Promise<GLTF>((resolve, reject) => loader.parse(binary, '', resolve, reject));

  const model = gltf.scene;
  model.frustumCulled = false;

  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse(child => {
    if (!(child instanceof THREE.SkinnedMesh)) return;
    meshes.push(child);
    child.frustumCulled = false;
    child.castShadow    = false;
    const orig     = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.MeshStandardMaterial;
    const material = makeMaterial(child, orig);
    if (material) child.material = material;
    else          child.visible  = false;
  });

  // GLTFLoader gives every mesh its own copy of the 725-bone skeleton; they all use the
  // same skin, so share one and the bone matrices are computed/uploaded once per frame.
  const shared = meshes[0]?.skeleton;
  meshes.forEach(mesh => {
    const sk = mesh.skeleton;
    if (sk === shared || sk.bones.length !== shared.bones.length) return;
    const same = sk.bones.every((b, i) => b === shared.bones[i] && sk.boneInverses[i].equals(shared.boneInverses[i]));
    if (same) mesh.skeleton = shared;
  });

  const rest: [THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3][] = [];
  model.traverse(o => {
    if ((o as THREE.Bone).isBone) rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
  });
  const resetPose = () => rest.forEach(([o, p, q, s]) => {
    o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s);
  });

  return { model, animations: gltf.animations, meshes, resetPose };
};

// Starts loading/parsing the model once; later calls share the same promise.
let avatarPromise: Promise<AvatarModel> | null = null;
export const preloadAvatar = () => {
  if (!avatarPromise) {
    avatarPromise = loadAvatarModel();
    avatarPromise.catch(() => { avatarPromise = null; });  // let the next call retry
  }
  return avatarPromise;
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

// ── Life: small head movements and eye glances ─────────────────────────────
// Clips loop, so on their own she repeats exactly. This adds slow, never-repeating
// head motion and quick eye glances on top. The head skin (DEF-spine… chain) and the
// face (ORG-spine… > ORG-face) hang off separate chains in this rig, so a head turn
// rotates both by the same world rotation about the same pivot.
const HEAD_SWAY   = THREE.MathUtils.degToRad(2.2);  // idle amplitude; 1.6× while talking
const EYE_RANGE   = THREE.MathUtils.degToRad(6);
const SACCADE_TAU = 0.035;  // eye glances are quick

type LifeRig = { restore: () => void; apply: (time: number, dt: number, talking: boolean) => void };

const makeLifeRig = (model: THREE.Object3D): LifeRig | null => {
  const bones = ['DEF-spine006', 'ORG-spine006', 'MCH-eyeL', 'MCH-eyeR'].map(n => model.getObjectByName(n));
  if (bones.some(b => !b?.parent)) return null;
  const [headSkin, headFace, eyeL, eyeR] = bones as THREE.Object3D[];
  const saved = bones.map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() }));
  let applied = false;

  const gaze = new THREE.Vector2(), gazeTarget = new THREE.Vector2();
  let nextGlance = 0;
  const pivot = new THREE.Vector3(), q = new THREE.Quaternion(), euler = new THREE.Euler();
  const m = new THREE.Matrix4(), step = new THREE.Matrix4();

  // Rotates a bone by world rotation `rot` about world point `p`, by rewriting its local transform
  const rotateInWorld = (bone: THREE.Object3D, p: THREE.Vector3, rot: THREE.Quaternion) => {
    const parent = bone.parent!;
    parent.updateWorldMatrix(true, false);
    m.compose(bone.position, bone.quaternion, bone.scale).premultiply(parent.matrixWorld);
    m.premultiply(step.makeTranslation(-p.x, -p.y, -p.z))
     .premultiply(step.makeRotationFromQuaternion(rot))
     .premultiply(step.makeTranslation(p.x, p.y, p.z));
    m.premultiply(step.copy(parent.matrixWorld).invert()).decompose(bone.position, bone.quaternion, bone.scale);
  };
  // Smooth pseudo-random wave in −1…1: sines at unrelated frequencies never line up into a loop
  const wave = (t: number, a: number, b: number, c: number) =>
    (Math.sin(t * a) + 0.6 * Math.sin(t * b + 1.3) + 0.35 * Math.sin(t * c + 2.1)) / 1.95;

  return {
    // Called before mixer.update; restores the pre-offset pose (the mixer skips unchanged values)
    restore: () => {
      if (!applied) return;
      bones.forEach((b, i) => { b!.position.copy(saved[i].p); b!.quaternion.copy(saved[i].q); b!.scale.copy(saved[i].s); });
      applied = false;
    },
    apply: (t, dt, talking) => {
      bones.forEach((b, i) => { saved[i].p.copy(b!.position); saved[i].q.copy(b!.quaternion); saved[i].s.copy(b!.scale); });
      applied = true;

      const amp   = HEAD_SWAY * (talking ? 1.6 : 1);
      const yaw   = amp * wave(t, 0.37, 0.83, 1.71);
      const pitch = amp * 0.7 * wave(t + 11, 0.43, 0.97, 1.93);
      const roll  = amp * 0.45 * wave(t + 23, 0.29, 0.71, 1.37);
      q.setFromEuler(euler.set(pitch, yaw, roll, 'YXZ'));
      headSkin.getWorldPosition(pivot);
      rotateInWorld(headSkin, pivot, q);
      rotateInWorld(headFace, pivot, q);

      // Mostly look at the student; now and then glance away
      if (t >= nextGlance) {
        const away = Math.random() < 0.35;
        const spread = away ? 1 : 0.2;
        gazeTarget.set((Math.random() * 2 - 1) * EYE_RANGE * spread, away ? (Math.random() * 2 - 1) * EYE_RANGE * 0.5 : 0);
        nextGlance = t + 0.8 + Math.random() * 2.2;
      }
      gaze.lerp(gazeTarget, 1 - Math.exp(-dt / SACCADE_TAU));
      // The eyes cancel most of the head turn, so her gaze stays steady
      q.setFromEuler(euler.set(gaze.y - pitch * 0.7, gaze.x - yaw * 0.7, 0, 'YXZ'));
      for (const eye of [eyeL, eyeR]) {
        eye.getWorldPosition(pivot);
        rotateInWorld(eye, pivot, q);
      }
    },
  };
};

// ── Component ──────────────────────────────────────────────────────────────
export default function AvatarRenderer({
  animationState = 'idle',
  expression     = {},
  onReady,
  onError,
  onGestureFinished,
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
  const lifeRef          = useRef<LifeRig | null>(null);
  const avatarRef        = useRef<AvatarModel | null>(null);
  const gestureDoneRef   = useRef(onGestureFinished);
  gestureDoneRef.current = onGestureFinished;
  const animStateRef     = useRef<AnimationState>(animationState);
  const baseStateRef     = useRef<AnimationState>('idle');
  const blinkTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Morph helpers ────────────────────────────────────────────────────────
  const setMorph = useCallback((name: string, weight: number) => {
    targetMorphs.current.set(name, Math.max(0, Math.min(1, weight)));
  }, []);

  // Smooths every named weight once per frame and writes it to the meshes.
  // Returns how far the jaw should open (0–1) from the current visemes.
  const applyMorphs = useCallback((dt: number) => {
    let jaw = 0;
    targetMorphs.current.forEach((target, name) => {
      const current = currentMorphs.current.get(name) ?? 0;
      const tau     = VISEME_NAMES.has(name) ? VISEME_TAU : BLINK_NAMES.has(name) ? BLINK_TAU : MORPH_TAU;
      const next    = current + (target - current) * (1 - Math.exp(-dt / tau));
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
  const playClip = useCallback((clipName: string) => {
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

  // Looping states become the "base"; gestures play once on top and then return to it
  const switchAnimation = useCallback((state: AnimationState) => {
    if (DEBUG_NO_ANIMATION) return;
    if (LOOPING_STATES.has(state)) baseStateRef.current = state;
    const clipName = ANIMATION_MAP[state];
    // Already talking on the other talking clip: keep going rather than crossfading
    if (currentActionRef.current?.getClip().name === TALK_ALTERNATE[clipName]) return;
    playClip(clipName);
  }, [playClip]);

  // ── Load GLB ──────────────────────────────────────────────────────────────
  const loadModel = useCallback(async (
    scene: THREE.Scene,
    mixer: THREE.AnimationMixer,
  ) => {
    const avatar = await preloadAvatar();  // usually already done while the user typed their name
    avatarRef.current = avatar;
    avatar.resetPose();  // in case a previous session left it mid-animation
    scene.add(avatar.model);
    meshRefs.current = avatar.meshes;

    // Build each mesh's own name → morph index map from its morphTargetDictionary
    avatar.meshes.forEach(mesh => {
      const dict = mesh.morphTargetDictionary;
      if (dict) morphIndices.current.set(mesh, new Map(Object.entries(dict)));
    });

    // Register all animation clips (already cleaned up by optimize-model.mjs)
    avatar.animations.forEach(clip => {
      const action = mixer.clipAction(clip);
      if (LOOPING_CLIPS.has(clip.name)) {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;  // hold the last pose while fading back
      }
      actionsRef.current.set(clip.name, action);
    });
    mixer.addEventListener('finished', e => {
      if (e.action !== currentActionRef.current) return;
      playClip(ANIMATION_MAP[baseStateRef.current]);
      gestureDoneRef.current?.();
    });
    mixer.addEventListener('loop', e => {
      const next = TALK_ALTERNATE[e.action.getClip().name];
      if (next && e.action === currentActionRef.current) playClip(next);
    });

    jawRef.current  = makeJawRig(avatar.model);
    lifeRef.current = makeLifeRig(avatar.model);

    console.log('[Avatar] Clips:', [...actionsRef.current.keys()]);
    console.log('[Avatar] Meshes with shape keys:', morphIndices.current.size);

    // Start idle
    const idle = actionsRef.current.get(ANIMATION_MAP['idle']);
    if (idle && !DEBUG_NO_ANIMATION) {
      idle.play();
      currentActionRef.current = idle;
    }
  }, [playClip]);

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
      // The cap allows a few ms of vsync jitter: a strict `< frameMs` check skips frames that
      // arrive a hair early, giving an uneven 33/50 ms rhythm that reads as stutter.
      let lastFrame = 0;
      const frameMs = 1000 / TARGET_FPS;
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const now = performance.now();
        if (now - lastFrame < frameMs - 4) return;
        lastFrame = now;
        const delta = Math.min(clockRef.current.getDelta(), MAX_DELTA);
        jawRef.current?.restore();
        lifeRef.current?.restore();
        mixer.update(delta);
        const jaw     = applyMorphs(delta);
        const talking = !!TALK_ALTERNATE[ANIMATION_MAP[baseStateRef.current]];
        lifeRef.current?.apply(now / 1000, delta, talking);
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
      // The parsed model is cached for the next session: detach it and leave it at rest
      const avatar = avatarRef.current;
      if (avatar) {
        mixerRef.current?.uncacheRoot(mixerRef.current.getRoot());
        avatar.model.removeFromParent();
        avatar.resetPose();
      }
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
