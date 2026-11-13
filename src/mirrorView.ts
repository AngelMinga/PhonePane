import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Adb, AdbError, Device, resolveAdbPath } from './adb';
import { ClientMessage, MirrorSource } from './protocol';
import { ScreencapSource } from './screencap';
import { findScrcpyServer, ScrcpySource } from './scrcpy';

const SERIAL_KEY = 'phonePane.serial';
const RETRY_MS = 2000;
const SIDE_KEY = 'phonePane.side';

type Mode = 'auto' | 'scrcpy' | 'screencap';

export class MirrorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'phonePane.mirror';
  static readonly rightViewId = 'phonePane.mirrorRight';

  private view?: vscode.WebviewView;
  private readonly adb = new Adb(resolveAdbPath());
  private source?: MirrorSource;
  private paused = false;

  /** Whether the webview can decode H.264; unknown until it says it is ready. */
  private webviewH264?: boolean;
  /** Set when scrcpy failed to start, so `auto` stops retrying it until the user asks. */
  private scrcpyFailed = false;

  /** Bumped by stop() so a start() still in progress knows it is stale. */
  private generation = 0;
  private starting = false;
  private retryTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.adb.serial = context.globalState.get<string>(SERIAL_KEY);
    void vscode.commands.executeCommand('setContext', 'phonePane.paused', false);
    void vscode.commands.executeCommand('setContext', 'phonePane.side', context.globalState.get(SIDE_KEY, 'left'));

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('phonePane.adbPath')) {
          this.adb.bin = resolveAdbPath();
        }
        if (
          ['adbPath', 'mode', 'scrcpyServerPath', 'maxSize', 'videoBitRate'].some((k) =>
            e.affectsConfiguration(`phonePane.${k}`),
          )
        ) {
          this.scrcpyFailed = false;
          this.restart();
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // Moving the view to another side bar resolves a new webview; drop the old one first.
    if (this.view && this.view !== view) {
      this.stop();
      this.webviewH264 = undefined;
    }
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this.html(view.webview, mediaRoot);

    // Events of an old webview (one that was moved or disposed) must not touch the current one.
    const isCurrent = () => this.view === view;
    view.webview.onDidReceiveMessage(
      (m: ClientMessage) => isCurrent() && this.onMessage(m),
      null,
      this.disposables,
    );
    view.onDidChangeVisibility(
      () => {
        // The webview is torn down while hidden; it says "ready" again when shown.
        if (isCurrent() && !view.visible) {
          this.webviewH264 = undefined;
          this.stop();
        }
      },
      null,
      this.disposables,
    );
    view.onDidDispose(
      () => {
        if (isCurrent()) {
          this.stop();
          this.view = undefined;
          this.webviewH264 = undefined;
        }
      },
      null,
      this.disposables,
    );
  }

  /**
   * Shows the panel in the primary (left) or secondary (right) side bar. There is one view
   * in each side bar and the `phonePane.side` context key decides which one is visible.
   */
  async moveTo(side: 'left' | 'right'): Promise<void> {
    await this.context.globalState.update(SIDE_KEY, side);
    await vscode.commands.executeCommand('setContext', 'phonePane.side', side);
    const viewId = side === 'left' ? MirrorViewProvider.viewId : MirrorViewProvider.rightViewId;
    await vscode.commands.executeCommand(`${viewId}.focus`);
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
        device: d,
      })),
      { placeHolder: vscode.l10n.t('Select the device to mirror') },
    );
    if (picked) {
      this.adb.serial = picked.device.serial;
      await this.context.globalState.update(SERIAL_KEY, picked.device.serial);
      this.scrcpyFailed = false;
      this.restart();
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    void vscode.commands.executeCommand('setContext', 'phonePane.paused', paused);
    void this.post({ type: 'paused', paused });
    if (paused) {
      this.stop();
    } else {
      void this.start();
    }
  }

  showLog(): void {
    this.log.show();
  }

  // ---- Lifecycle ----------------------------------------------------------

  private async start(): Promise<void> {
    if (
      !this.view?.visible ||
      this.paused ||
      this.source ||
      this.starting ||
      this.webviewH264 === undefined
    ) {
      return;
    }
    this.starting = true;
    const gen = this.generation;
    try {
      const device = await this.pickDevice();
      if (gen !== this.generation) {
        return;
      }
      if (!device) {
        void this.post({ type: 'status', text: vscode.l10n.t('No Android device connected.') });
        this.retryLater();
        return;
      }
      const source = await this.createSource();
      if (gen !== this.generation) {
        source.stop();
        return;
      }
      this.source = source;
      void this.post({
        type: 'mode',
        mode: source.mode,
        label: source.mode === 'scrcpy' ? 'scrcpy' : vscode.l10n.t('Screenshots'),
      });
    } catch (err) {
      if (gen === this.generation) {
        this.log.error(this.describeError(err));
        void this.post({ type: 'status', text: this.describeError(err) });
        this.retryLater();
      }
    } finally {
      this.starting = false;
      // stop() + start() may have happened while we were busy.
      if (gen !== this.generation) {
        void this.start();
      }
    }
  }

  private stop(): void {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.source?.stop();
    this.source = undefined;
  }

  private restart(): void {
    this.stop();
    void this.start();
  }

  private retryLater(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.start();
    }, RETRY_MS);
  }

  /** A running source broke (device unplugged, server crashed…): show it and retry. */
  private onSourceFailed(source: MirrorSource, err: Error): void {
    if (source !== this.source) {
      return;
    }
    this.source = undefined;
    this.log.warn(`${source.mode} stopped: ${err.message}`);
    void this.post({ type: 'status', text: this.describeError(err) });
    this.retryLater();
  }

  /** Keeps the selected device if it is still online, otherwise picks the first one available. */
  private async pickDevice(): Promise<Device | undefined> {
    const online = (await this.adb.devices()).filter((d) => d.state === 'device');
    const device = online.find((d) => d.serial === this.adb.serial) ?? online[0];
    if (device) {
      if (device.serial !== this.adb.serial) {
        this.adb.serial = device.serial;
        await this.context.globalState.update(SERIAL_KEY, device.serial);
      }
      void this.post({ type: 'device', serial: device.serial, model: device.model ?? device.serial });
    }
    return device;
  }

  private async createSource(): Promise<MirrorSource> {
    const config = vscode.workspace.getConfiguration('phonePane');
    const mode = config.get<Mode>('mode', 'auto');

    if (mode !== 'screencap' && !(mode === 'auto' && this.scrcpyFailed)) {
      const server = await findScrcpyServer();
      let problem: string | undefined;
      if (!server) {
        problem = vscode.l10n.t('scrcpy-server was not found. Install scrcpy or set "phonePane.scrcpyServerPath".');
      } else if (!this.webviewH264) {
        problem = vscode.l10n.t('This VS Code cannot decode H.264 video in webviews.');
      } else {
        void this.post({ type: 'status', text: vscode.l10n.t('Starting scrcpy…') });
        const source: ScrcpySource = new ScrcpySource(
          this.adb,
          server,
          { maxSize: config.get<number>('maxSize', 1280), bitRate: config.get<number>('videoBitRate', 8_000_000) },
          (m) => this.post(m),
          this.log,
          (err) => this.onSourceFailed(source, err),
        );
        try {
          await source.start();
          return source;
        } catch (err) {
          this.scrcpyFailed = true;
          problem = vscode.l10n.t('scrcpy could not start: {0}', this.describeError(err));
        }
      }

      if (mode === 'scrcpy') {
        throw new Error(problem);
      }
      this.log.warn(`${problem} Falling back to screencap.`);
      void this.post({ type: 'toast', text: vscode.l10n.t('{0} Using screenshots instead (slower).', problem) });
    }

    const source: ScreencapSource = new ScreencapSource(
      this.adb,
      (m) => this.post(m),
      (err) => this.onSourceFailed(source, err),
      (err) => this.describeError(err),
    );
    source.start();
    return source;
  }

  // ---- Webview messages ---------------------------------------------------

  private onMessage(m: ClientMessage): void {
    switch (m.type) {
      case 'ready':
        this.webviewH264 = m.h264;
        this.log.info(`Webview ready (H.264 decoding ${m.h264 ? 'available' : 'not available'})`);
        void this.post({ type: 'paused', paused: this.paused });
        this.restart();
        return;
      case 'retry':
        this.scrcpyFailed = false;
        this.restart();
        return;
      case 'videoError':
        this.log.warn(`Webview video decoder error: ${m.message}`);
        this.source?.videoError?.();
        return;
      default:
        this.source?.input(m);
    }
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

  private post(message: Record<string, unknown>): Thenable<unknown> {
    return this.view?.webview.postMessage(message) ?? Promise.resolve(false);
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
    <div id="badges">
      <span id="mode-badge" hidden></span>
      <span id="paused-badge" hidden>${t.paused}</span>
    </div>
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
