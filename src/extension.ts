import * as vscode from 'vscode';
import { MirrorViewProvider } from './mirrorView';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MirrorViewProvider(context);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(MirrorViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand('phonePane.selectDevice', () => provider.selectDevice()),
    vscode.commands.registerCommand('phonePane.pause', () => provider.setPaused(true)),
    vscode.commands.registerCommand('phonePane.resume', () => provider.setPaused(false)),
  );
}

export function deactivate(): void {}
