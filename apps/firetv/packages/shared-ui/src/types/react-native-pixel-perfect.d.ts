// react-native-pixel-perfect ships no type declarations. create(resolution) returns a
// scaler: (size) => number that maps design-resolution pixels to the current device.
declare module 'react-native-pixel-perfect' {
  export interface PixelPerfectResolution {
    width: number;
    height: number;
  }
  export function create(resolution: PixelPerfectResolution): (size: number) => number;
}
