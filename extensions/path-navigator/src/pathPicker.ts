import * as vscode from 'vscode';
import { PathEntry } from './pathEntry';
import { PathIndex } from './pathIndex';
import {
  isDescendantOfScope,
  isDirectChild,
  parsePathInput,
  rankPaths,
} from './search';

interface PathQuickPickItem extends vscode.QuickPickItem {
  readonly entry: PathEntry;
}

export class PathPicker {
  private activePicker: vscode.QuickPick<PathQuickPickItem> | undefined;
  private workspaceLock: { workspaceUri: string; anchorPath: string } | undefined;

  constructor(private readonly index: PathIndex) {}

  async show(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage('Path Navigator requires an open workspace folder.');
      return;
    }

    if (this.activePicker) {
      this.activePicker.show();
      return;
    }

    const picker = vscode.window.createQuickPick<PathQuickPickItem>();
    this.activePicker = picker;
    this.workspaceLock = undefined;
    const refreshButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('refresh'),
      tooltip: 'Refresh path index',
    };
    const enterDirectoryButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('arrow-right'),
      tooltip: 'Enter directory',
    };
    const disposables: vscode.Disposable[] = [];
    picker.placeholder = 'Type a name, then press Tab to complete the selected path';
    picker.title = 'Path Navigator';
    picker.buttons = [refreshButton];
    picker.busy = this.index.isBuilding;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;

    const updateItems = (): void => {
      this.reconcileWorkspaceLock(picker.value);
      const { scopePath, query } = parsePathInput(picker.value);
      const maxResults = vscode.workspace
        .getConfiguration('pathNavigator')
        .get<number>('maxResults', 200);
      const candidates = this.index.currentEntries.filter(
        (entry) =>
          (query
            ? isDescendantOfScope(entry.relativePath, scopePath)
            : isDirectChild(entry.relativePath, scopePath)) &&
          (!this.workspaceLock || entry.workspaceUri === this.workspaceLock.workspaceUri),
      );
      picker.items = rankPaths(candidates, query, maxResults).map(({ item }) =>
        this.toQuickPickItem(item, enterDirectoryButton),
      );
      picker.title = scopePath ? `Path Navigator — ${scopePath}/` : 'Path Navigator';
      picker.activeItems = picker.items.length > 0 ? [picker.items[0]] : [];
    };

    disposables.push(
      picker.onDidChangeValue(updateItems),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0] ?? picker.activeItems[0];
        if (!selected) {
          return;
        }
        picker.hide();
        void this.openEntry(selected.entry);
      }),
      picker.onDidTriggerButton((button) => {
        if (button === refreshButton) {
          void this.index.rebuild();
        }
      }),
      picker.onDidTriggerItemButton((event) => {
        if (event.button === enterDirectoryButton) {
          this.completeEntry(event.item.entry, picker);
        }
      }),
      picker.onDidHide(() => {
        for (const disposable of disposables.splice(0)) {
          disposable.dispose();
        }
        this.activePicker = undefined;
        this.workspaceLock = undefined;
        void vscode.commands.executeCommand('setContext', 'pathNavigator.active', false);
        picker.dispose();
      }),
      this.index.onDidChange(updateItems),
      this.index.onDidChangeBuilding((building) => {
        picker.busy = building;
      }),
    );

    picker.show();
    await vscode.commands.executeCommand('setContext', 'pathNavigator.active', true);
    updateItems();
    await this.index.ensureReady();
    if (this.activePicker === picker) {
      updateItems();
    }
  }

  completeSelectedPath(): void {
    const picker = this.activePicker;
    if (!picker) {
      return;
    }
    const selected = picker.activeItems[0] ?? picker.selectedItems[0] ?? picker.items[0];
    if (selected) {
      this.completeEntry(selected.entry, picker);
    }
  }

  private completeEntry(entry: PathEntry, picker: vscode.QuickPick<PathQuickPickItem>): void {
    if (!this.workspaceLock) {
      this.workspaceLock = {
        workspaceUri: entry.workspaceUri,
        anchorPath: entry.relativePath.toLocaleLowerCase(),
      };
    }
    picker.value = `${entry.relativePath}${entry.kind === 'directory' ? '/' : ''}`;
  }

  private reconcileWorkspaceLock(value: string): void {
    if (!this.workspaceLock) {
      return;
    }
    const normalizedValue = value
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
      .toLocaleLowerCase();
    const { anchorPath } = this.workspaceLock;
    if (normalizedValue !== anchorPath && !normalizedValue.startsWith(`${anchorPath}/`)) {
      this.workspaceLock = undefined;
    }
  }

  private toQuickPickItem(
    entry: PathEntry,
    enterDirectoryButton: vscode.QuickInputButton,
  ): PathQuickPickItem {
    const multipleRoots = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return {
      label: `$(${entry.kind === 'directory' ? 'folder' : 'file'}) ${entry.name}`,
      description: entry.relativePath,
      detail: multipleRoots ? `Workspace: ${entry.workspaceName}` : undefined,
      alwaysShow: true,
      buttons: entry.kind === 'directory' ? [enterDirectoryButton] : undefined,
      entry,
    };
  }

  private async openEntry(entry: PathEntry): Promise<void> {
    if (entry.kind === 'file') {
      const preview = vscode.workspace
        .getConfiguration('pathNavigator')
        .get<boolean>('openFilesInPreview', false);
      try {
        await vscode.commands.executeCommand('vscode.open', entry.uri, { preview });
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not open ${entry.relativePath}: ${String(error)}`);
      }
      return;
    }

    try {
      await vscode.commands.executeCommand('revealInExplorer', entry.uri);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not reveal ${entry.relativePath} in Explorer: ${String(error)}`,
      );
    }
  }
}
