import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('assets/models/teacher_maya_small.glb');

for (const anim of doc.getRoot().listAnimations()) {
  for (const ch of anim.listChannels()) {
    if (ch.getTargetPath() === 'weights') {
      const sampler = ch.getSampler();
      anim.removeChannel(ch);
      ch.dispose();
      sampler?.dispose();
    }
  }
}
await io.write('assets/models/teacher_maya_lite.glb', doc);