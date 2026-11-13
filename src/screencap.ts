import * as vscode from 'vscode';
import { Adb } from './adb';
import { InputMessage, MirrorSource, Post } from './protocol';

/**
 * Fallback source: polls `adb exec-out screencap -p` and replays whole gestures
 * with `adb shell input`. Slow (≈1 fps on some devices) but needs nothing besides adb.
 */
export class ScreencapSource implements MirrorSource {
  readonly mode = 'screencap';

  private stopped = false;
  private timer?: NodeJS.Timeout;
  private lastFrame?: Buffer;
  private inputQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly adb: Adb,
    private readonly post: Post,
    private readonly onFail: (err: Error) => void,
    private readonly describeError: (err: unknown) => string,
  ) {}

  start(): void {
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const frame = await this.adb.screencap();
      if (this.stopped) {
        return;
      }
      if (!this.lastFrame || !this.lastFrame.equals(frame)) {
        this.lastFrame = frame;
        await this.post({ type: 'frame', data: new Uint8Array(frame) });
      }
      const interval = vscode.workspace.getConfiguration('phonePane').get<number>('frameInterval', 50);
      this.schedule(Math.max(0, interval));
    } catch (err) {
      if (!this.stopped) {
        this.stop();
        this.onFail(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  /** Captures right away instead of waiting for the next tick (used after input). */
  private kick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.tick();
    }
  }

  input(m: InputMessage): void {
    switch (m.type) {
      case 'tap':
        return this.enqueue(() => this.adb.tap(m.x, m.y));
      case 'swipe':
        return this.enqueue(() => this.adb.swipe(m.x1, m.y1, m.x2, m.y2, m.duration));
      case 'key':
        return this.enqueue(() => this.adb.keyevent(m.code));
      case 'text':
        return this.enqueue(() => this.adb.text(m.text));
    }
  }

  /** Runs input commands one after another so taps and keystrokes keep their order. */
  private enqueue(action: () => Promise<unknown>): void {
    this.inputQueue = this.inputQueue
      .then(action)
      .then(() => this.kick())
      .catch((err) => this.post({ type: 'toast', text: this.describeError(err) }));
  }
}
