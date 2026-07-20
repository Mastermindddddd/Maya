/**
 * metro.config.js
 * ───────────────
 * Registers .glb and .gltf as valid asset extensions so Metro
 * bundles them correctly. Without this, require('./teacher_maya.glb')
 * will throw "Unable to resolve module" at runtime.
 */

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add GLB/GLTF to the asset extensions list
config.resolver.assetExts = [
  ...config.resolver.assetExts,
  'glb',
  'gltf',
  'bin',
  'hdr',
];

module.exports = config;