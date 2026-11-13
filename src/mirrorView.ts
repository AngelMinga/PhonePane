import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Adb, AdbError, Device, resolveAdbPath } from './adb';

const SERIAL_KEY = 'phonePane.serial';

type ClientMessage =
  | { type: 'ready' }
  | { type: 'retry' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; duration: number }
  | { type: 'key'; code: number }
  | { type: 'text'; text: string };

export class MirrorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'phonePane.mirror';

  private view?: vscode.WebviewView;
  private readonly adb = new Adb(resolveAdbPath());
  private paused = false;

  /** Bumped on every start/stop so stale capture loops exit on their own. */
  private generation = 0;
  private isRunning = false;
  /** False until the current device has been confirmed online and announced to the webview. */
  private deviceReady = false;
  private timer?: NodeJS.Timeout;
  private lastFrame?: Buffer;
  private inputQueue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.adb.serial = context.globalState.get<string>(SERIAL_KEY);
    void vscode.commands.executeCommand('setContext', 'phonePane.paused', false);

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('phonePane.adbPath')) {
          this.adb.bin = resolveAdbPath();
          this.restart();
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this.html(view.webview, mediaRoot);

    view.webview.onDidReceiveMessage((m: ClientMessage) => this.onMessage(m), null, this.disposables);
    view.onDidChangeVisibility(() => (view.visible ? this.start() : this.stop()), null, this.disposables);
    view.onDidDispose(() => {
      this.stop();
      this.view = undefined;
    }, null, this.disposables);
  }

  // ---- Commands -----------------------------------------------------------

  async selectDevice(): Promise<void> {
    let devices: Device[];
    try {
      devices = await this.adb.devices();
    } catch (err) {
      void vscode.window.showErrorMessage(this.describeError(err));
      return;
    }
    if (devices.length === 0) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No Android device connected.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      devices.map((d) => ({
        label: d.model ?? d.serial,
        description: d.serial,
        detail: d.state === 'device' ? undefined : d.state,
        picked: d.serial === this.adb.serial,
        device: d,
      })),
      { placeHolder: vscode.l10n.t('Select the device to mirror') },
    );
    if (picked) {
      await this.useDevice(picked.device);
      this.restart();
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    void vscode.commands.executeCommand('setContext', 'phonePane.paused', paused);
    this.post({ type: 'paused', paused });
    if (paused) {
      this.stop();
    } else {
      this.start();
    }
  }

  // ---- Capture loop -------------------------------------------------------

  private start(): void {
    if (!this.view?.visible || this.paused || this.isRunning) {
      return;
    }
    this.isRunning = true;
    const gen = ++this.generation;
    void this.tick(gen);
  }

  private stop(): void {
    this.isRunning = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private restart(): void {
    this.stop();
    this.lastFrame = undefined;
    this.start();
  }

  private schedule(gen: number, delay: number): void {
    if (gen !== this.generation) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick(gen);
    }, delay);
  }

  /** Captures right away instead of waiting for the next tick (used after input). */
  private kick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.tick(this.generation);
    }
  }

  private async tick(gen: number): Promise<void> {
    if (gen !== this.generation) {
      return;
    }
    try {
      if (!(await this.ensureDevice())) {
        this.post({ type: 'status', kind: 'noDevice', text: vscode.l10n.t('No Android device connected.') });
        this.lastFrame = undefined;
        this.schedule(gen, 2000);
        return;
      }

      const frame = await this.adb.screencap();
      if (gen !== this.generation) {
        return;
      }
      if (!this.lastFrame || !this.lastFrame.equals(frame)) {
        this.lastFrame = frame;
        // Copy into a standalone buffer so only the PNG bytes are transferred.
        await this.view?.webview.postMessage({ type: 'frame', data: new Uint8Array(frame) });
      }
      const interval = vscode.workspace.getConfiguration('phonePane').get<number>('frameInterval', 50);
      this.schedule(gen, Math.max(0, interval));
    } catch (err) {
      if (gen !== this.generation) {
        return;
      }
      this.post({ type: 'status', kind: 'error', text: this.describeError(err) });
      this.lastFrame = undefined;
      // The device may have been unplugged: look it up again on the next attempt.
      this.deviceReady = false;
      this.schedule(gen, 2000);
    }
  }

  /** Keeps the selected device if it is still online, otherwise picks the first one available. */
  private async ensureDevice(): Promise<boolean> {
    if (this.deviceReady) {
      return true;
    }
    const online = (await this.adb.devices()).filter((d) => d.state === 'device');
    const target = online.find((d) => d.serial === this.adb.serial) ?? online[0];
    if (!target) {
      return false;
    }
    await this.useDevice(target);
    return true;
  }

  private async useDevice(device: Device): Promise<void> {
    this.adb.serial = device.serial;
    this.deviceReady = true;
    await this.context.globalState.update(SERIAL_KEY, device.serial);
    this.post({ type: 'device', serial: device.serial, model: device.model ?? device.serial });
  }

  // ---- Input --------------------------------------------------------------

  private onMessage(m: ClientMessage): void {
    switch (m.type) {
      case 'ready':
        this.deviceReady = false;
        this.lastFrame = undefined;
        this.post({ type: 'paused', paused: this.paused });
        this.restart();
        return;
      case 'retry':
        this.restart();
        return;
      case 'tap':
        return this.input(() => this.adb.tap(m.x, m.y));
      case 'swipe':
        return this.input(() => this.adb.swipe(m.x1, m.y1, m.x2, m.y2, m.duration));
      case 'key':
        return this.input(() => this.adb.keyevent(m.code));
      case 'text':
        return this.input(() => this.adb.text(m.text));
    }
  }

  /** Runs input commands one after another so taps and keystrokes keep their order. */
  private input(action: () => Promise<unknown>): void {
    if (!this.adb.serial) {
      return;
    }
    this.inputQueue = this.inputQueue
      .then(action)
      .then(() => this.kick())
      .catch((err) => this.post({ type: 'toast', text: this.describeError(err) }));
  }

  // ---- Helpers ------------------------------------------------------------

  private describeError(err: unknown): string {
    if (err instanceof AdbError && err.notFound) {
      return vscode.l10n.t(
        'adb was not found at "{0}". Install Android platform-tools or set "phonePane.adbPath".',
        this.adb.bin,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/unauthorized/i.test(message)) {
      return vscode.l10n.t('Accept the USB debugging prompt on the device.');
    }
    return message;
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const t = {
      connecting: vscode.l10n.t('Connecting to the device…'),
      retry: vscode.l10n.t('Retry'),
      back: vscode.l10n.t('Back'),
      home: vscode.l10n.t('Home'),
      recents: vscode.l10n.t('Recent apps'),
      power: vscode.l10n.t('Power'),
      volumeUp: vscode.l10n.t('Volume up'),
      volumeDown: vscode.l10n.t('Volume down'),
      paused: vscode.l10n.t('Paused'),
    };
    return /* html */ `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
</head>
<body>
  <div id="stage">
    <canvas id="screen" tabindex="0" hidden></canvas>
    <div id="status">
      <p id="status-text">${t.connecting}</p>
      <button id="retry" hidden>${t.retry}</button>
    </div>
    <div id="paused-badge" hidden>${t.paused}</div>
  </div>
  <nav id="nav">
    <button data-key="25" title="${t.volumeDown}">${icons.volumeDown}</button>
    <button data-key="4" title="${t.back}">${icons.back}</button>
    <button data-key="3" title="${t.home}">${icons.home}</button>
    <button data-key="187" title="${t.recents}">${icons.recents}</button>
    <button data-key="24" title="${t.volumeUp}">${icons.volumeUp}</button>
    <button data-key="26" title="${t.power}">${icons.power}</button>
  </nav>
  <div id="toast" hidden></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.stop();
    this.disposables.forEach((d) => d.dispose());
  }
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const icons = {
  back: svg('<path d="M17 4 7 12l10 8z"/>'),
  home: svg('<circle cx="12" cy="12" r="7"/>'),
  recents: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  power: svg('<path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>'),
  volumeUp: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>'),
  volumeDown: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>'),
};
