import { SupportedKeys } from './SupportedKeys';

// Define a type for the listener function
export type KeydownListener = (event: SupportedKeys) => void;

export interface RemoteControlManagerInterface {
  // Returns the listener so react-tv-space-navigation's remoteControlUnsubscriber can detach it.
  addKeydownListener(listener: KeydownListener): KeydownListener;
  removeKeydownListener(listener: KeydownListener): void;
  emitKeyDown(key: SupportedKeys): void;
}