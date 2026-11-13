import * as vscode from 'vscode';
import { MirrorViewProvider } from './mirrorView';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('PhonePane', { log: true });
  const provider = new MirrorViewProvider(context, log);

  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider(MirrorViewProvider.viewId, provider),
    vscode.window.registerWebviewViewProvider(MirrorViewProvider.rightViewId, provider),
    vscode.commands.registerCommand('phonePane.selectDevice', () => provider.selectDevice()),
    vscode.commands.registerCommand('phonePane.pause', () => provider.setPaused(true)),
    vscode.commands.registerCommand('phonePane.resume', () => provider.setPaused(false)),
    vscode.commands.registerCommand('phonePane.showLog', () => provider.showLog()),
    vscode.commands.registerCommand('phonePane.moveLeft', () => provider.moveTo('left')),
    vscode.commands.registerCommand('phonePane.moveRight', () => provider.moveTo('right')),
  );
}

export function deactivate(): void {}
