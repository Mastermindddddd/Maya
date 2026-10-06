import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const KEEP = new Set([
  // visemes
  'V_Open','V_Explosive','V_Dental_Lip','V_Tight_O','V_Tight','V_Wide','V_Affricate','V_Lip_Open',
  // eyes
  'Eye_Blink_L','Eye_Blink_R','Eye_Wide_L','Eye_Wide_R','Eye_Squint_L','Eye_Squint_R',
  'Eye_L_Look_L','Eye_R_Look_L','Eye_L_Look_R','Eye_R_Look_R',
  'Eye_L_Look_Up','Eye_R_Look_Up','Eye_L_Look_Down','Eye_R_Look_Down',
  // brows
  'Brow_Raise_Inner_L','Brow_Raise_Inner_R','Brow_Raise_Outer_L','Brow_Raise_Outer_R',
  'Brow_Drop_L','Brow_Drop_R','Brow_Compress_L','Brow_Compress_R',
  // mouth
  'Mouth_Smile_L','Mouth_Smile_R','Mouth_Frown_L','Mouth_Frown_R',
  'Mouth_Close','Jaw_Open','Mouth_Chin_Up',
  // cheeks and nose
  'Cheek_Raise_L','Cheek_Raise_R','Cheek_Puff_L','Cheek_Puff_R',
  'Nose_Sneer_L','Nose_Sneer_R',
]);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('assets/models/teacher_maya_lite.glb');

for (const mesh of doc.getRoot().listMeshes()) {
  const names = mesh.getExtras().targetNames;
  if (!names) continue;
  const keepIdx = names.map((n, i) => (KEEP.has(n) ? i : -1)).filter(i => i >= 0);
  const oldWeights = mesh.getWeights();

  for (const prim of mesh.listPrimitives()) {
    prim.listTargets().forEach((t, i) => {
      if (!keepIdx.includes(i)) { prim.removeTarget(t); t.dispose(); }
    });
  }
  mesh.setExtras({ ...mesh.getExtras(), targetNames: keepIdx.map(i => names[i]) });
  mesh.setWeights(keepIdx.map(i => oldWeights[i] ?? 0));
  console.log(mesh.getName(), names.length, '→', keepIdx.length);
}
await io.write('assets/models/teacher_maya_tiny.glb', doc);