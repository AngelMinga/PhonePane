import { ChildProcess, execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { Adb } from './adb';
import { InputMessage, MirrorSource, Post, TouchAction } from './protocol';

const REMOTE_JAR = '/data/local/tmp/phonepane-scrcpy.jar';

/** scrcpy uses -2 for a finger that is not a mouse (POINTER_ID_GENERIC_FINGER). */
const GENERIC_FINGER = -2n;

const enum ControlType {
  InjectKeycode = 0,
  InjectText = 1,
  InjectTouch = 2,
  InjectScroll = 3,
  ResetVideo = 17,
}

const enum KeyAction {
  Down = 0,
  Up = 1,
}

export interface ScrcpyServer {
  path: string;
  version: string;
}

// ---- Locating the server --------------------------------------------------

/**
 * Finds the scrcpy-server that ships with an installed scrcpy, plus its version.
 * The server only accepts clients that announce exactly its own version.
 */
export async function findScrcpyServer(): Promise<ScrcpyServer | undefined> {
  const config = vscode.workspace.getConfiguration('phonePane');
  const candidates = [
    config.get<string>('scrcpyServerPath')?.trim(),
    process.env.SCRCPY_SERVER_PATH,
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server',
    '/snap/scrcpy/current/usr/share/scrcpy/scrcpy-server',
  ].filter((c): c is string => !!c);

  const file = candidates.find((c) => fs.existsSync(c));
  if (!file) {
    return undefined;
  }
  const version = versionFromPath(file) ?? (await versionFromCli(file));
  return version ? { path: file, version } : undefined;
}

/** Homebrew keeps the version in the real path: .../Cellar/scrcpy/5.0.1/share/scrcpy/scrcpy-server */
function versionFromPath(file: string): string | undefined {
  try {
    return /scrcpy[\\/](\d+(?:\.\d+)+)[\\/]/.exec(fs.realpathSync(file))?.[1];
  } catch {
    return undefined;
  }
}

async function versionFromCli(serverFile: string): Promise<string | undefined> {
  const bins = [
    path.resolve(path.dirname(fs.realpathSync(serverFile)), '..', '..', 'bin', 'scrcpy'),
    '/opt/homebrew/bin/scrcpy',
    '/usr/local/bin/scrcpy',
    '/usr/bin/scrcpy',
    'scrcpy',
  ];
  for (const bin of bins) {
    const out = await new Promise<string>((resolve) =>
      execFile(bin, ['--version'], { timeout: 5000 }, (_err, stdout) => resolve(stdout ?? '')),
    );
    const match = /scrcpy (\d+(?:\.\d+)+)/.exec(out);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

// ---- Session --------------------------------------------------------------

export interface ScrcpyOptions {
  maxSize: number;
  bitRate: number;
}

/**
 * Runs scrcpy-server on the device and talks to it directly:
 * the video socket carries H.264 (forwarded to the webview, decoded with WebCodecs)
 * and the control socket receives touch, scroll, key and text events.
 */
export class ScrcpySource implements MirrorSource {
  readonly mode = 'scrcpy';

  private proc?: ChildProcess;
  private video?: net.Socket;
  private control?: net.Socket;
  private port?: number;
  private started = false;
  private closed = false;

  // Video stream parser state
  private pending: Buffer = Buffer.alloc(0);
  private codecRead = false;
  private config?: Buffer;
  private codec = 'avc1.42001f';
  private streaming = false;
  private lastReset = 0;

  constructor(
    private readonly adb: Adb,
    private readonly server: ScrcpyServer,
    private readonly options: ScrcpyOptions,
    private readonly post: Post,
    private readonly log: vscode.LogOutputChannel,
    private readonly onFail: (err: Error) => void,
  ) {}

  async start(): Promise<void> {
    try {
      // cleanup=true deletes the jar when the server stops, so push it every time.
      await this.adb.exec(['push', this.server.path, REMOTE_JAR], 30_000);
      const scid = (crypto.randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0');
      this.port = await freePort();
      await this.adb.exec(['forward', `tcp:${this.port}`, `localabstract:scrcpy_${scid}`]);

      const serverArgs = [
        `CLASSPATH=${REMOTE_JAR}`,
        'app_process',
        '/',
        'com.genymobile.scrcpy.Server',
        this.server.version,
        `scid=${scid}`,
        'log_level=info',
        'tunnel_forward=true',
        'audio=false',
        'control=true',
        'video_codec=h264',
        `max_size=${this.options.maxSize}`,
        `video_bit_rate=${this.options.bitRate}`,
        'send_device_meta=false',
        'cleanup=true',
      ];
      this.log.info(`Starting scrcpy-server ${this.server.version} on ${this.adb.serial} (${this.server.path})`);
      const proc = spawn(this.adb.bin, this.adb.withSerial(['shell', ...serverArgs]));
      this.proc = proc;
      const logLines = (data: Buffer) =>
        data
          .toString()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((l) => this.log.info(l));
      proc.stdout?.on('data', logLines);
      proc.stderr?.on('data', logLines);
      proc.on('error', (err) => this.close(err));
      proc.on('exit', (code) => this.close(new Error(`scrcpy-server exited with code ${code}`)));

      const { socket, rest } = await this.connectVideo();
      this.video = socket;
      this.control = await connect(this.port);
      this.control.on('data', () => undefined); // device messages (clipboard…) are not used
      this.control.on('error', (err) => this.close(err));
      this.control.on('close', () => this.close(new Error('scrcpy control socket closed')));

      socket.on('data', (chunk: Buffer) => this.onVideoData(chunk));
      socket.on('error', (err) => this.close(err));
      socket.on('close', () => this.close(new Error('scrcpy video socket closed')));
      if (rest.length) {
        this.onVideoData(rest);
      }
      socket.resume();
      this.started = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.close(error);
      throw error;
    }
  }

  stop(): void {
    this.close();
  }

  // ---- Video ----------------------------------------------------------------

  /**
   * adb accepts the forwarded connection even before the server listens, and closes it
   * right away in that case. The server writes a dummy byte once it really is connected.
   */
  private async connectVideo(): Promise<{ socket: net.Socket; rest: Buffer }> {
    for (let attempt = 0; attempt < 100 && !this.closed; attempt++) {
      const result = await tryConnectWithDummyByte(this.port!);
      if (result) {
        return result;
      }
      await delay(100);
    }
    throw new Error(this.closed ? 'scrcpy-server stopped' : 'Could not connect to scrcpy-server');
  }

  /**
   * Stream format (scrcpy 3+): 4-byte codec id, then packets with a 12-byte header.
   * Bit 63 of the first 8 bytes marks a session packet (new video size, no payload),
   * bit 62 a codec config packet (SPS/PPS) and bit 61 a key frame.
   */
  private onVideoData(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (!this.codecRead) {
        if (this.pending.length < 4) {
          return;
        }
        const codecId = this.pending.subarray(0, 4).toString('latin1');
        this.pending = this.pending.subarray(4);
        this.codecRead = true;
        if (codecId !== 'h264') {
          this.close(new Error(`Unexpected video codec: ${codecId}`));
          return;
        }
        continue;
      }

      if (this.pending.length < 12) {
        return;
      }
      const flags = this.pending.readUInt32BE(0);
      if (flags & 0x8000_0000) {
        const width = this.pending.readUInt32BE(4);
        const height = this.pending.readUInt32BE(8);
        this.pending = this.pending.subarray(12);
        this.post({ type: 'videoSize', width, height });
        continue;
      }

      const length = this.pending.readUInt32BE(8);
      if (this.pending.length < 12 + length) {
        return;
      }
      const payload = Buffer.from(this.pending.subarray(12, 12 + length));
      this.pending = this.pending.subarray(12 + length);

      if (flags & 0x4000_0000) {
        this.config = payload;
        this.codec = codecFromConfig(payload) ?? this.codec;
        continue;
      }
      const key = (flags & 0x2000_0000) !== 0;
      // WebCodecs decodes Annex B without a description when key frames carry SPS/PPS.
      const data = key && this.config ? Buffer.concat([this.config, payload]) : payload;
      this.streaming = true;
      this.post({ type: 'chunk', key, codec: this.codec, data: new Uint8Array(data) });
    }
  }

  videoError(): void {
    // Ask the server for a fresh config + key frame. Resetting before the first frame
    // makes the server drop the video socket, and decoder errors can come in bursts.
    const now = Date.now();
    if (!this.streaming || now - this.lastReset < 1000) {
      return;
    }
    this.lastReset = now;
    this.send(Buffer.from([ControlType.ResetVideo]));
  }

  // ---- Control ----------------------------------------------------------------

  input(m: InputMessage): void {
    switch (m.type) {
      case 'touch':
        return this.touch(m.action, m.x, m.y, m.w, m.h);
      case 'scroll':
        return this.scroll(m.x, m.y, m.w, m.h, m.dx, m.dy);
      case 'key':
        this.keycode(KeyAction.Down, m.code);
        this.keycode(KeyAction.Up, m.code);
        return;
      case 'text':
        return this.text(m.text);
    }
  }

  private touch(action: TouchAction, x: number, y: number, w: number, h: number): void {
    const b = Buffer.alloc(32);
    b.writeUInt8(ControlType.InjectTouch, 0);
    b.writeUInt8(action, 1);
    b.writeBigInt64BE(GENERIC_FINGER, 2);
    writePosition(b, 10, x, y, w, h);
    b.writeUInt16BE(action === TouchAction.Up ? 0 : 0xffff, 22); // pressure
    b.writeInt32BE(0, 24); // action button
    b.writeInt32BE(0, 28); // buttons
    this.send(b);
  }

  private scroll(x: number, y: number, w: number, h: number, dx: number, dy: number): void {
    const b = Buffer.alloc(21);
    b.writeUInt8(ControlType.InjectScroll, 0);
    writePosition(b, 1, x, y, w, h);
    b.writeInt16BE(toI16FixedPoint(dx / 16), 13);
    b.writeInt16BE(toI16FixedPoint(dy / 16), 15);
    b.writeInt32BE(0, 17);
    this.send(b);
  }

  private keycode(action: KeyAction, code: number): void {
    const b = Buffer.alloc(14);
    b.writeUInt8(ControlType.InjectKeycode, 0);
    b.writeUInt8(action, 1);
    b.writeInt32BE(code, 2);
    b.writeInt32BE(0, 6); // repeat
    b.writeInt32BE(0, 10); // meta state
    this.send(b);
  }

  private text(value: string): void {
    const text = Buffer.from(value, 'utf8');
    const b = Buffer.alloc(5);
    b.writeUInt8(ControlType.InjectText, 0);
    b.writeUInt32BE(text.length, 1);
    this.send(Buffer.concat([b, text]));
  }

  private send(data: Buffer): void {
    if (this.control && !this.closed) {
      this.control.write(data);
    }
  }

  // ---- Teardown ---------------------------------------------------------------

  private close(err?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.proc?.kill();
    if (this.port) {
      this.adb.exec(['forward', '--remove', `tcp:${this.port}`]).catch(() => undefined);
    }
    if (err) {
      this.log.warn(`scrcpy session ended: ${err.message}`);
    }
    // Only report failures of a running session; start() reports its own by throwing.
    if (err && this.started) {
      this.onFail(err);
    }
  }
}

// ---- Helpers ------------------------------------------------------------------

function writePosition(b: Buffer, offset: number, x: number, y: number, w: number, h: number): void {
  b.writeInt32BE(Math.round(x), offset);
  b.writeInt32BE(Math.round(y), offset + 4);
  b.writeUInt16BE(w, offset + 8);
  b.writeUInt16BE(h, offset + 10);
}

function toI16FixedPoint(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(clamped * 0x8000)));
}

/** Builds the WebCodecs codec string (avc1.PPCCLL) from the SPS inside the config packet. */
function codecFromConfig(config: Buffer): string | undefined {
  for (let i = 0; i + 7 < config.length; i++) {
    const startCode = config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1;
    if (startCode && (config[i + 3] & 0x1f) === 7) {
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(config[i + 4])}${hex(config[i + 5])}${hex(config[i + 6])}`;
    }
  }
  return undefined;
}

function tryConnectWithDummyByte(port: number): Promise<{ socket: net.Socket; rest: Buffer } | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const fail = () => {
      socket.destroy();
      resolve(undefined);
    };
    const timer = setTimeout(fail, 2000);
    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('data', (data: Buffer) => {
      clearTimeout(timer);
      socket.pause();
      socket.removeListener('error', fail);
      socket.removeListener('close', fail);
      resolve({ socket, rest: data.subarray(1) });
    });
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
