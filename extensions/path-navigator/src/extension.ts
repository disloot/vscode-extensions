import * as vscode from 'vscode';
import { PathIndex } from './pathIndex';
import { PathPicker } from './pathPicker';
import { RecentPathStore } from './recentPaths';

export function activate(context: vscode.ExtensionContext): void {
  const recentPaths = new RecentPathStore(context.workspaceState);
  const index = new PathIndex(
    context.storageUri,
    () => recentPaths.getUsages().map(({ entry }) => entry),
    context.workspaceState,
  );
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
    vscode.commands.registerCommand('pathNavigator.goToParent', () =>
      picker.goToParentDirectory(),
    ),
    vscode.commands.registerCommand('pathNavigator.refreshPicker', () =>
      picker.refreshIndex(),
    ),
    vscode.commands.registerCommand('pathNavigator.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:Disloot.path-navigator',
      ),
    ),
    vscode.commands.registerCommand('pathNavigator.configureKeyboardShortcuts', () =>
      vscode.commands.executeCommand(
        'workbench.action.openGlobalKeybindings',
        'Path Navigator',
      ),
    ),
    vscode.commands.registerCommand('pathNavigator.refreshIndex', async () => {
      await index.rebuild();
      const limitSuffix = index.isLimited ? ' (configured index limit reached)' : '';
      void vscode.window.showInformationMessage(
        `Path Navigator indexed ${index.entryCount} paths${limitSuffix}.`,
      );
    }),
  );

  if (vscode.window.activeTextEditor) {
    recentPaths.recordUri(vscode.window.activeTextEditor.document.uri);
  }

  if (vscode.workspace.workspaceFolders?.length) {
    void index.initialize();
  }
}

export function deactivate(): void {}
