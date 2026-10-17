// Mirrors packages/shared-ui/src/types/react-native-pixel-perfect.d.ts. The app's tsc program
// typechecks shared-ui sources via the import graph but doesn't include packages/shared-ui's
// ambient declarations, so the react-native-pixel-perfect (JS-only) shim is declared here too.
declare module 'react-native-pixel-perfect' {
  export interface PixelPerfectResolution {
    width: number;
    height: number;
  }
  export function create(resolution: PixelPerfectResolution): (size: number) => number;
}
