import * as vscode from 'vscode';
import { PathIndex } from './pathIndex';
import { PathPicker } from './pathPicker';

export function activate(context: vscode.ExtensionContext): void {
  const index = new PathIndex();
  const picker = new PathPicker(index);

  context.subscriptions.push(
    index,
    vscode.commands.registerCommand('pathNavigator.open', () => picker.show()),
    vscode.commands.registerCommand('pathNavigator.completePath', () =>
      picker.completeSelectedPath(),
    ),
    vscode.commands.registerCommand('pathNavigator.refreshIndex', async () => {
      await index.rebuild();
      void vscode.window.showInformationMessage(
        `Path Navigator indexed ${index.currentEntries.length} paths.`,
      );
    }),
  );

  if (vscode.workspace.workspaceFolders?.length) {
    void index.rebuild();
  }
}

export function deactivate(): void {}
