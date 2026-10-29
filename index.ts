import { registerRootComponent } from 'expo';

import App from './App';

const SILENCED = ['EXGL: gl.pixelStorei'];
(['log', 'warn'] as const).forEach(level => {
  const orig = console[level];
  console[level] = (...args: any[]) => {
    if (typeof args[0] === 'string' && SILENCED.some(s => args[0].includes(s))) return;
    orig(...args);
  };
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
