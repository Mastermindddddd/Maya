/**
 * AvatarRenderer
 * ──────────────
 * Renders teacher_maya.glb using expo-gl + Three.js directly.
 * No expo-three dependency — pure Three.js with the expo-gl context.
 *
 * GLB is loaded via expo-asset → base64 read → ArrayBuffer parse.
 * The GLTFLoader is imported from three/examples/jsm (bundled with three).
 *
 * Shape keys: all 148 CC4 morph targets accessible by name.
 * Animations: all 11 CC clips in the AnimationMixer.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { GLView, ExpoWebGLRenderingContext } from 'expo-gl';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

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
    const asset = Asset.fromModule(require('../../assets/models/teacher_maya.glb'));
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;

    // Read as base64 → ArrayBuffer (works on both iOS and Android)
    const b64    = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

    // Parse with GLTFLoader
    const loader = new GLTFLoader();

    await new Promise<void>((resolve, reject) => {
      loader.parse(binary, '', gltf => {
        const model = gltf.scene;

        // CC4 exports in centimetres → scale to metres
        model.scale.setScalar(0.012);
        // Position: nudge down so bust fills the portrait frame
        model.position.set(0, -1.65, 0);
        model.frustumCulled = false;
        scene.add(model);

        // Collect skinned meshes + morph dictionaries
        model.traverse(child => {
          if (!(child instanceof THREE.SkinnedMesh)) return;
          meshRefs.current.push(child);
          child.frustumCulled = false;
          child.castShadow    = true;

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
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          actionsRef.current.set(clip.name, action);
        });

        // Log what we found (helpful for debugging)
        console.log('[Avatar] Clips:', [...actionsRef.current.keys()]);
        console.log('[Avatar] Shape keys:', [...morphIndices.current.keys()].length);

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
    glRef.current = gl;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;

    // ── Renderer ─────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      context: gl as unknown as WebGLRenderingContext,
      antialias: true,
    });
    renderer.setSize(W, H);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled   = true;
    renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace    = THREE.SRGBColorSpace;
    renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    rendererRef.current = renderer;

    // ── Scene ─────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0B0F1A');
    sceneRef.current = scene;

    // ── Camera — bust portrait framing ────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(28, W / H, 0.01, 100);
    camera.position.set(0, 0.18, 2.8);
    camera.lookAt(0, 0.1, 0);
    cameraRef.current = camera;

    // ── Lighting ──────────────────────────────────────────────────────────
    // Warm key from upper-left
    const key = new THREE.DirectionalLight(0xFFF5E0, 2.2);
    key.position.set(-1.5, 3, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    // Cool fill from right
    const fill = new THREE.DirectionalLight(0xCCE0FF, 0.8);
    fill.position.set(2, 1.5, 1);
    scene.add(fill);
    // Amber rim — separates avatar from dark bg
    const rim = new THREE.DirectionalLight(0xF5A623, 0.6);
    rim.position.set(0, 2, -3);
    scene.add(rim);
    // Soft ambient
    scene.add(new THREE.AmbientLight(0x8090B0, 0.5));

    // ── Mixer ─────────────────────────────────────────────────────────────
    const mixer = new THREE.AnimationMixer(scene);
    mixerRef.current = mixer;

    // ── Load model ────────────────────────────────────────────────────────
    try {
      await loadModel(scene, mixer);
      scheduleBlink();
      onReady?.();
    } catch (err) {
      console.error('[Avatar] load error:', err);
      onError?.(err as Error);
      return;
    }

    // ── Render loop ───────────────────────────────────────────────────────
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const delta = clockRef.current.getDelta();
      mixer.update(delta);
      applyMorphs();
      renderer.render(scene, camera);
      // expo-gl: signal frame is done
      gl.endFrameEXP?.();
    };
    tick();

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