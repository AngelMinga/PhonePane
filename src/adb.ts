import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Device {
  serial: string;
  state: string;
  model?: string;
}

const ADB_BIN = process.platform === 'win32' ? 'adb.exe' : 'adb';

/**
 * Finds adb. VS Code launched from the Dock on macOS does not inherit the
 * shell PATH, so besides PATH we also look at the usual SDK/Homebrew locations.
 */
export function resolveAdbPath(): string {
  const configured = vscode.workspace.getConfiguration('phonePane').get<string>('adbPath')?.trim();
  if (configured) {
    return configured;
  }

  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, ADB_BIN));
    }
  }
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const sdk = process.env[env];
    if (sdk) {
      candidates.push(path.join(sdk, 'platform-tools', ADB_BIN));
    }
  }
  const home = os.homedir();
  candidates.push(
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', ADB_BIN),
    path.join(home, 'Android', 'Sdk', 'platform-tools', ADB_BIN),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  );
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', ADB_BIN));
  }

  return candidates.find((c) => fs.existsSync(c)) ?? ADB_BIN;
}

export class Adb {
  constructor(public bin: string, public serial?: string) {}

  exec(args: string[], timeout = 10_000): Promise<Buffer> {
    const fullArgs = this.serial ? ['-s', this.serial, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        fullArgs,
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr?.toString().trim();
            const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            reject(new AdbError(detail || err.message, notFound));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  async devices(): Promise<Device[]> {
    const out = (await new Adb(this.bin).exec(['devices', '-l'])).toString();
    return out
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...rest] = line.split(/\s+/);
        const model = rest.find((p) => p.startsWith('model:'))?.slice('model:'.length).replace(/_/g, ' ');
        return { serial, state, model };
      });
  }

  screencap(): Promise<Buffer> {
    return this.exec(['exec-out', 'screencap', '-p']);
  }

  tap(x: number, y: number) {
    return this.exec(['shell', 'input', 'tap', `${x}`, `${y}`]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number) {
    return this.exec(['shell', 'input', 'swipe', `${x1}`, `${y1}`, `${x2}`, `${y2}`, `${Math.round(durationMs)}`]);
  }

  keyevent(code: number) {
    return this.exec(['shell', 'input', 'keyevent', `${code}`]);
  }

  /** `input text` only supports ASCII; spaces must be sent as %s. */
  text(value: string) {
    const escaped = value.replace(/'/g, `'\\''`).replace(/ /g, '%s');
    return this.exec(['shell', `input text '${escaped}'`]);
  }
}

export class AdbError extends Error {
  constructor(message: string, readonly notFound = false) {
    super(message);
  }
}
