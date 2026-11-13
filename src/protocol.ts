/** Messages the webview sends to the extension. */
export type ClientMessage =
  | { type: 'ready'; h264: boolean }
  | { type: 'retry' }
  | { type: 'videoError'; message: string }
  | InputMessage;

/** User input coming from the webview. Coordinates are in canvas pixels (w × h). */
export type InputMessage =
  // screencap mode: whole gestures, replayed with `adb shell input`
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration: number }
  // scrcpy mode: raw pointer events, injected in real time
  | { type: 'touch'; action: TouchAction; x: number; y: number; w: number; h: number }
  | { type: 'scroll'; x: number; y: number; w: number; h: number; dx: number; dy: number }
  // both modes
  | { type: 'key'; code: number }
  | { type: 'text'; text: string };

export const enum TouchAction {
  Down = 0,
  Up = 1,
  Move = 2,
}

export type Post = (message: Record<string, unknown>) => Thenable<unknown>;

/** Something that streams the device screen to the webview and forwards input back. */
export interface MirrorSource {
  readonly mode: 'scrcpy' | 'screencap';
  input(message: InputMessage): void;
  /** Called when the webview could not decode the video. */
  videoError?(): void;
  stop(): void;
}
