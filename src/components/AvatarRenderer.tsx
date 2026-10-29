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
 * Animations: all CC clips in the AnimationMixer.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { decode } from 'base64-arraybuffer';

// ── Debug switches (set to false / remove once the avatar shows) ───────────
const DEBUG_TEST_CUBE   = true;   // red cube beside the head: proves the renderer draws
const DEBUG_NO_MORPHS   = true;  // true = drop morph targets (tests whether morphs break rendering)
const DEBUG_PLAIN_SKIN  = true;   // true = replace heavy materials with a plain skin-colour material

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
  visemeWeights?:  VisemeWeights;
  expression?:     ExpressionWeights;
  onReady?:        () => void;
  onError?:        (err: Error) => void;
}

// ── Constants ──────────────────────────────────────────────────────────────
const FADE_DURATION  = 0.35;
const BLINK_INTERVAL = 4000;
const BLINK_DURATION = 120;
const MORPH_LERP     = 0.18;

// ── Component ──────────────────────────────────────────────────────────────
export default function AvatarRenderer({
  animationState = 'idle',
  visemeWeights  = {},
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
  const morphIndices     = useRef<Map<string, number>>(new Map());
  const targetMorphs     = useRef<Map<string, number>>(new Map());
  const currentMorphs    = useRef<Map<string, number>>(new Map());
  const animStateRef     = useRef<AnimationState>(animationState);
  const blinkTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Morph helpers ────────────────────────────────────────────────────────
  const setMorph = useCallback((name: string, weight: number) => {
    targetMorphs.current.set(name, Math.max(0, Math.min(1, weight)));
  }, []);

  const applyMorphs = useCallback(() => {
    meshRefs.current.forEach(mesh => {
      if (!mesh.morphTargetInfluences) return;
      morphIndices.current.forEach((index, name) => {
        const target  = targetMorphs.current.get(name) ?? 0;
        const current = currentMorphs.current.get(name) ?? 0;
        const next    = current + (target - current) * MORPH_LERP;
        currentMorphs.current.set(name, next);
        mesh.morphTargetInfluences![index] = next;
      });
    });
  }, []);

  // ── Auto-blink ────────────────────────────────────────────────────────────
  const scheduleBlink = useCallback(() => {
    const delay = BLINK_INTERVAL + (Math.random() - 0.5) * 1500;
    blinkTimer.current = setTimeout(() => {
      setMorph('Eye_Blink_L', 1.0);
      setMorph('Eye_Blink_R', 1.0);
      setTimeout(() => {
        setMorph('Eye_Blink_L', 0.0);
        setMorph('Eye_Blink_R', 0.0);
        scheduleBlink();
      }, BLINK_DURATION);
    }, delay);
  }, [setMorph]);

  // ── Animation switch ──────────────────────────────────────────────────────
  const switchAnimation = useCallback((state: AnimationState) => {
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
    loader.register(() => ({
      name: 'SkipTextures',
      loadTexture: () => Promise.resolve(null as any),
    }));

    await new Promise<void>((resolve, reject) => {
      loader.parse(binary, '', gltf => {
        const model = gltf.scene;

        // The GLB is already in metres (bbox 0 → 1.7 on Y)
        model.scale.setScalar(1);
        model.position.set(0, 0, 0);
        model.frustumCulled = false;
        scene.add(model);

        // Where did the model actually land? Head should be near y ≈ 1.6
        const box = new THREE.Box3().setFromObject(model);
        console.log('[Avatar] bbox min', box.min.toArray(), 'max', box.max.toArray());

        // Collect skinned meshes + morph dictionaries
        model.traverse(child => {
          if (!(child instanceof THREE.SkinnedMesh)) return;
          meshRefs.current.push(child);
          child.frustumCulled = false;
          child.castShadow    = true;

          if (DEBUG_PLAIN_SKIN) {
            child.material = new THREE.MeshStandardMaterial({ color: '#d9a98a', roughness: 0.7 });
          }

          if (DEBUG_NO_MORPHS) {
            child.geometry.morphAttributes = {};
            child.morphTargetInfluences = undefined;
            child.morphTargetDictionary = undefined;
            return;
          }

          // Build name → index map from morphTargetDictionary
          const dict = child.morphTargetDictionary;
          if (dict) {
            Object.entries(dict).forEach(([name, idx]) => {
              if (!morphIndices.current.has(name)) {
                morphIndices.current.set(name, idx as number);
              }
            });
          }
        });

        // Register all animation clips
        gltf.animations.forEach(clip => {
  const before = clip.tracks.length;
  clip.tracks = clip.tracks.filter(
  t => !t.name.endsWith('.scale') && !t.name.endsWith('.position'),
);
  if (clip.name === 'CC_Breathing') {
    console.log('[Avatar] tracks', before, '→', clip.tracks.length,
      clip.tracks.slice(0, 6).map(t => t.name));
  }
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  actionsRef.current.set(clip.name, action);
});

        // Log what we found (helpful for debugging)
        console.log('[Avatar] Clips:', [...actionsRef.current.keys()]);
        console.log('[Avatar] Shape keys:', [...morphIndices.current.keys()].length);

        const logBones = (label: string) => {
  model.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  let count = 0;
  model.traverse(o => {
    if ((o as THREE.Bone).isBone) { box.expandByPoint(o.getWorldPosition(v)); count++; }
  });
  const f = (a: number[]) => a.map(n => Math.round(n * 100) / 100);
  console.log(`[Avatar] ${label}`, count, 'bones, box', f(box.min.toArray()), f(box.max.toArray()));
};
logBones('bones at start');
setTimeout(() => logBones('bones after 1s'), 1000);

        // Start idle
        const idle = actionsRef.current.get(ANIMATION_MAP['idle']);
        if (idle) {
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
      console.log('[Avatar] 1 context ready');
      glRef.current = gl;

      // expo-gl can return undefined for empty info logs; Three calls .trim() on them
      const origShaderLog  = gl.getShaderInfoLog.bind(gl);
      const origProgramLog = gl.getProgramInfoLog.bind(gl);
      gl.getShaderInfoLog  = (s: any) => origShaderLog(s)  ?? '';
      gl.getProgramInfoLog = (p: any) => origProgramLog(p) ?? '';

      const W = gl.drawingBufferWidth;
      const H = gl.drawingBufferHeight;

      console.log('[Avatar] buffer', W, H, 'aspect', (W / H).toFixed(2));

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
        antialias: true,
      });
      renderer.setSize(W, H, false);   // false = don't touch canvas.style
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled   = true;
      renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace    = THREE.SRGBColorSpace;
      renderer.toneMapping         = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
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
      const key = new THREE.DirectionalLight(0xFFF5E0, 2.2);   // warm key, upper-left
      key.position.set(-1.5, 3, 2);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      scene.add(key);

      const fill = new THREE.DirectionalLight(0xCCE0FF, 0.8);   // cool fill, right
      fill.position.set(2, 1.5, 1);
      scene.add(fill);

      const rim = new THREE.DirectionalLight(0xF5A623, 0.6);    // amber rim light
      rim.position.set(0, 2, -3);
      scene.add(rim);

      scene.add(new THREE.AmbientLight(0x8090B0, 0.5));

      // ── Debug: red cube next to where the head should be ──────────────────
      if (DEBUG_TEST_CUBE) {
        const testCube = new THREE.Mesh(
          new THREE.BoxGeometry(0.2, 0.2, 0.2),
          new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        );
        testCube.position.set(0.3, 1.5, 0);
        scene.add(testCube);
      }

      // ── Mixer ─────────────────────────────────────────────────────────────
      const mixer = new THREE.AnimationMixer(scene);
      mixerRef.current = mixer;

      // ── Start the render loop BEFORE loading, so a frame is always drawn ──
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
        const delta = clockRef.current.getDelta();
        mixer.update(delta);
        applyMorphs();
        renderer.render(scene, camera);
        gl.endFrameEXP();
      };
      tick();

      // ── Load model, with a timeout so a hang becomes a visible error ──────
      console.log('[Avatar] 2 scene built, loading model');
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Model load timed out after 45s')), 45000),
      );
      await Promise.race([loadModel(scene, mixer), timeout]);

      console.log('[Avatar] 3 model loaded');
      scheduleBlink();
      onReady?.();
      console.log('[Avatar] 4 ready');
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
  useEffect(() => {
    SHAPE_KEYS.visemes.forEach(v => setMorph(v, 0));
    Object.entries(visemeWeights).forEach(([k, v]) => {
      if (v !== undefined) setMorph(k, v);
    });
  }, [visemeWeights, setMorph]);

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
      msaaSamples={Platform.OS === 'ios' ? 4 : 2}
    />
  );
}