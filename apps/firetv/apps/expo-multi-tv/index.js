import { registerRootComponent } from 'expo';
import App from './App';

// Dependencies are hoisted to the workspace root, so expo/AppEntry.js (which does a relative
// `../../App` import) no longer resolves to this app. Register the root component locally instead.
registerRootComponent(App);
