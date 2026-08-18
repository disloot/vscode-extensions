import * as vscode from 'vscode';
import { PathIndex } from './pathIndex';
import { PathPicker } from './pathPicker';
import { RecentPathStore } from './recentPaths';

export function activate(context: vscode.ExtensionContext): void {
  const index = new PathIndex();
  const recentPaths = new RecentPathStore(context.workspaceState);
  const picker = new PathPicker(index, recentPaths);

  context.subscriptions.push(
    index,
    recentPaths,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        recentPaths.recordUri(editor.document.uri);
      }
    }),
    vscode.commands.registerCommand('pathNavigator.open', () => picker.show()),
    vscode.commands.registerCommand('pathNavigator.completePath', () =>
      picker.completeSelectedPath(),
    ),
    vscode.commands.registerCommand('pathNavigator.selectNext', () =>
      picker.navigateSelection('next'),
    ),
    vscode.commands.registerCommand('pathNavigator.selectPrevious', () =>
      picker.navigateSelection('previous'),
    ),
    vscode.commands.registerCommand('pathNavigator.refreshIndex', async () => {
      await index.rebuild();
      void vscode.window.showInformationMessage(
        `Path Navigator indexed ${index.currentEntries.length} paths.`,
      );
    }),
  );

  if (vscode.window.activeTextEditor) {
    recentPaths.recordUri(vscode.window.activeTextEditor.document.uri);
  }

  if (vscode.workspace.workspaceFolders?.length) {
    void index.rebuild();
  }
}

export function deactivate(): void {}
