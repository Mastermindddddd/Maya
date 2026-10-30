// Makes teacher_maya_opt.glb (what the app loads) from teacher_maya_tiny.glb.
// Run after strip.mjs and strip-morphs.mjs:   node optimize-model.mjs
//
//  • Animations: removes the drifting root motion (Rigify keeps MCH-*parent helper bones
//    beside `root`, and the CC clips bake the drift into all of them), then drops tracks
//    that never move the mesh or never leave the rest pose. ~2175 → ~200 tracks per clip.
//    Then trims the frozen padding off each clip, keeps her feet planted at the rest
//    stance, and eases each clip's end back into its start so loops don't snap.
//  • Morph targets: drops the NORMAL deltas and stores POSITION deltas sparse (most are zero).
//  • Removes what the app never shows: cornea / eye-occlusion / tearline meshes, the unused
//    CC_Base skeleton, vertex colours, and every texture except base colour.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const IN  = 'assets/models/teacher_maya_tiny.glb';
const OUT = 'assets/models/teacher_maya_opt.glb';
const CLIP_FPS = 30;
const HIDDEN_MATERIALS = /Cornea|Occlusion|Tearline/i;

// ── 1. Clean the clips with three (same maths the renderer used to do at runtime) ──
const bytes = fs.readFileSync(IN);
const loader = new GLTFLoader();
loader.register(() => ({ name: 'SkipTextures', loadTexture: () => Promise.resolve(null) }));
const gltf = await new Promise((res, rej) =>
  loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', res, rej));
const model = gltf.scene;
const byName = new Map();
model.traverse(o => byName.set(o.name, o));

const removeRootMotion = clip => {
  const rootBone = byName.get('root');
  const tops = [];
  model.traverse(o => { if (o.isBone && !o.parent?.isBone) tops.push(o); });
  const tracks = new Map(clip.tracks.map(t => [t.name, t]));
  const sample = (bone, prop, t, out) => {
    const track = tracks.get(`${bone.name}.${prop}`);
    return track ? out.fromArray(track.createInterpolant().evaluate(t)) : out.copy(bone[prop]);
  };
  const n = Math.max(2, Math.round(clip.duration * CLIP_FPS) + 1);
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
  tops.forEach((bone, k) => clip.tracks.push(
    new THREE.VectorKeyframeTrack(`${bone.name}.position`, times, out[k].p),
    new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, out[k].q),
    new THREE.VectorKeyframeTrack(`${bone.name}.scale`, times, out[k].s),
  ));
};

// Bones that move the mesh (skin weight > 0) plus their ancestors
const deformBones = new Set();
model.traverse(mesh => {
  if (!mesh.isSkinnedMesh) return;
  const si = mesh.geometry.getAttribute('skinIndex'), sw = mesh.geometry.getAttribute('skinWeight');
  for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) {
    if (sw.getComponent(i, k) <= 0) continue;
    for (let b = mesh.skeleton.bones[si.getComponent(i, k)]; b?.isBone && !deformBones.has(b.name); b = b.parent) deformBones.add(b.name);
  }
});

// Drop tracks of bones that never move the mesh, and tracks that never leave rest (the mixer restores rest)
const pruneTracks = clip => {
  clip.tracks = clip.tracks.filter(t => {
    const dot = t.name.lastIndexOf('.');
    const name = t.name.substring(0, dot), prop = t.name.substring(dot + 1);
    if (!deformBones.has(name)) return false;
    const rest = byName.get(name)[prop].toArray();
    return t.values.some((v, i) => Math.abs(v - rest[i % rest.length]) > 1e-4);
  });
};

// The rest pose, captured before any mixer touches the bones
const bones = [];
model.traverse(o => { if (o.isBone) bones.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
const resetPose = () => bones.forEach(([o, p, q, s]) => { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); });
const worldPos = name => byName.get(name).getWorldPosition(new THREE.Vector3());
model.updateMatrixWorld(true);
const restFeet = { l: worldPos('DEF-footL'), r: worldPos('DEF-footR') };

// Samples a clip's pose at time t (exact at the end, no wrap-around) and calls fn
const samplePoses = (clip, times, fn) => {
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  times.forEach((t, i) => { mixer.setTime(t); model.updateMatrixWorld(true); fn(i, t); });
  mixer.stopAllAction(); mixer.uncacheRoot(model); resetPose();
};
const grid = duration => {
  const n = Math.max(2, Math.round(duration * CLIP_FPS) + 1);
  return Array.from({ length: n }, (_, i) => Math.min(duration, i / CLIP_FPS));
};

// Every clip was exported with the same 8.33 s range, but most only move for 1–5 s and
// then freeze. Cut each clip at the end of its first stretch of motion (a 1 s pause ends it).
const MOVING = 3e-4;  // metres per frame
const trimToMotion = clip => {
  const watch = ['DEF-spine006', 'DEF-spine003', 'DEF-handL', 'DEF-handR'];
  const times = grid(clip.duration);
  let prev = null, lastMoving = 0, still = 0;
  let done = false;
  samplePoses(clip, times, (i, t) => {
    const cur = watch.map(worldPos);
    if (prev && !done) {
      const moved = Math.max(...cur.map((p, k) => p.distanceTo(prev[k])));
      if (moved > MOVING) { lastMoving = t; still = 0; } else if ((still += 1 / CLIP_FPS) >= 1) done = true;
    }
    prev = cur;
  });
  const end = Math.min(clip.duration, lastMoving + 0.2);
  if (end < clip.duration - 0.05) { clip.duration = end; clip.trim(); }
};

// The clips float her up to ~25 cm and bob her body around. Each frame, translate the
// whole rig so the lower foot sits at the rest floor height and the feet stay centred
// where they rest (smoothed over ±0.15 s so it never jitters).
const topBones = [...new Set(bones.map(([o]) => o))].filter(o => !o.parent?.isBone && deformBones.has(o.name));
const SMOOTH = 4;  // frames each side
const groundClip = clip => {
  const times = grid(clip.duration);
  const raw = [], local = topBones.map(() => []);
  const restMid = restFeet.l.clone().add(restFeet.r).multiplyScalar(0.5);
  samplePoses(clip, times, i => {
    const l = worldPos('DEF-footL'), r = worldPos('DEF-footR');
    const mid = l.clone().add(r).multiplyScalar(0.5);
    raw.push(new THREE.Vector3(restMid.x - mid.x, Math.min(restFeet.l.y, restFeet.r.y) - Math.min(l.y, r.y), restMid.z - mid.z));
    topBones.forEach((b, k) => local[k].push(b.position.clone()));
  });
  const offsets = raw.map((_, i) => {
    const sum = new THREE.Vector3(); let n = 0;
    for (let j = Math.max(0, i - SMOOTH); j <= Math.min(raw.length - 1, i + SMOOTH); j++) { sum.add(raw[j]); n++; }
    return sum.divideScalar(n);
  });
  // The top-level bones sit directly under the (identity) armature, so a world offset is a local one
  const timesArr = new Float32Array(times);
  topBones.forEach((b, k) => {
    const values = new Float32Array(times.length * 3);
    local[k].forEach((p, i) => p.clone().add(offsets[i]).toArray(values, i * 3));
    clip.tracks = clip.tracks.filter(t => t.name !== `${b.name}.position`);
    clip.tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, timesArr, values));
  });
};

// Over the last half-second, ease every track back to its first value, so looping
// clips repeat without a snap and one-shot gestures end in the pose they started from.
const makeSeamless = clip => {
  const D = clip.duration, L = Math.min(0.5, D * 0.25), from = D - L;
  const smoothstep = x => x * x * (3 - 2 * x);
  const a = new THREE.Quaternion(), b = new THREE.Quaternion();
  clip.tracks = clip.tracks.map(track => {
    const interp = track.createInterpolant(), size = track.getValueSize();
    const first = Array.from(interp.evaluate(0));
    const times = [...Array.from(track.times).filter(t => t < from), ...grid(L).map(t => from + t)];
    const values = new Float32Array(times.length * size);
    times.forEach((t, i) => {
      const v = Array.from(interp.evaluate(Math.min(t, D)));
      const w = t < from ? 0 : smoothstep(Math.min(1, (t - from) / L));
      if (size === 4) {
        a.fromArray(v); b.fromArray(first);
        a.slerp(b, w).toArray(values, i * 4);
      } else {
        for (let k = 0; k < size; k++) values[i * size + k] = v[k] + (first[k] - v[k]) * w;
      }
    });
    const Track = track.constructor;
    return new Track(track.name, new Float32Array(times), values);  // all LINEAR from here on
  });
};

gltf.animations.forEach(clip => {
  removeRootMotion(clip);
  pruneTracks(clip);
  if (clip.tracks.length === 0) return;
  trimToMotion(clip);
  groundClip(clip);
  makeSeamless(clip);
});

// ── 2. Write the cleaned clips back into the glTF document ───────────────────
const io  = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();
const buffer = root.listBuffers()[0];
const docNodes = root.listNodes();
const PATHS = { position: 'translation', quaternion: 'rotation', scale: 'scale' };

const inputs = new Map();  // shared time accessors
const timesAccessor = times => {
  const key = Array.from(times).join(',');
  if (!inputs.has(key)) inputs.set(key, doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer));
  return inputs.get(key);
};

root.listAnimations().forEach((anim, i) => {
  const clip = gltf.animations[i];  // GLTFLoader keeps the document's animation order
  anim.listChannels().forEach(c => c.dispose());
  anim.listSamplers().forEach(s => s.dispose());
  if (clip.tracks.length === 0) { anim.dispose(); return; }
  for (const track of clip.tracks) {
    const dot  = track.name.lastIndexOf('.');
    const node = docNodes[gltf.parser.associations.get(byName.get(track.name.substring(0, dot))).nodes];
    const sampler = doc.createAnimationSampler()
      .setInput(timesAccessor(track.times))
      .setOutput(doc.createAccessor().setType(track.getValueSize() === 4 ? 'VEC4' : 'VEC3').setArray(new Float32Array(track.values)).setBuffer(buffer))
      .setInterpolation(track.getInterpolation() === THREE.InterpolateDiscrete ? 'STEP' : 'LINEAR');
    anim.addSampler(sampler).addChannel(
      doc.createAnimationChannel().setTargetNode(node).setTargetPath(PATHS[track.name.substring(dot + 1)]).setSampler(sampler));
  }
});

// ── 3. Remove what the app never shows ───────────────────────────────────────
const disposeTree = node => { node.listChildren().forEach(disposeTree); node.dispose(); };
for (const node of root.listNodes()) {
  if (node.isDisposed() || !node.getMesh()) continue;
  const mesh = node.getMesh();
  mesh.listPrimitives().forEach(p => {
    if (HIDDEN_MATERIALS.test(p.getMaterial()?.getName() ?? '')) { mesh.removePrimitive(p); p.dispose(); }
  });
  if (mesh.listPrimitives().length === 0) { mesh.dispose(); node.dispose(); }
}
// The CC_Base skeleton is a second, unskinned copy of the rig
const joints = new Set(root.listSkins().flatMap(s => s.listJoints()));
for (const scene of root.listScenes()) for (const top of scene.listChildren()) {
  let used = false;
  top.traverse(n => { if (n.getMesh() || n.getSkin() || joints.has(n)) used = true; });
  if (!used) disposeTree(top);
}

for (const mat of root.listMaterials()) {
  mat.setNormalTexture(null).setOcclusionTexture(null).setEmissiveTexture(null).setMetallicRoughnessTexture(null);
  mat.listExtensions().forEach(ext => mat.setExtension(ext.extensionName, null));
}
root.listExtensionsUsed()
  .filter(e => /clearcoat|specular|ior/.test(e.extensionName))
  .forEach(e => e.dispose());

for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
  prim.setAttribute('COLOR_0', null);
  for (const target of prim.listTargets()) {
    target.setAttribute('NORMAL', null);
    target.getAttribute('POSITION')?.setSparse(true);
  }
}

// ── 4. Drop orphans and write ────────────────────────────────────────────────
const orphan = p => p.listParents().every(parent => parent.propertyType === 'Root');
for (const list of [root.listMaterials(), root.listTextures(), root.listAccessors()]) {
  list.filter(orphan).forEach(p => p.dispose());
}

await io.write(OUT, doc);
const mb = f => (fs.statSync(f).size / 1e6).toFixed(1) + ' MB';
console.log(`${IN} (${mb(IN)}) → ${OUT} (${mb(OUT)})`);
