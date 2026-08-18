import * as vscode from 'vscode';
import { PathEntry } from './pathEntry';
import { PathIndex } from './pathIndex';
import { searchPaths } from './pathSearchEngine';
import { RecentPathStore } from './recentPaths';
import {
  pathIdentity,
  pinActivePath,
  restoredActiveIndex,
  ResultUpdateGate,
} from './resultSelection';
import { parsePathInput } from './search';

interface PathQuickPickItem extends vscode.QuickPickItem {
  readonly entry: PathEntry;
}

const INDEX_RESULT_UPDATE_INTERVAL_MS = 200;

export class PathPicker {
  private activePicker: vscode.QuickPick<PathQuickPickItem> | undefined;
  private freezeActiveResults: (() => void) | undefined;
  private workspaceLock: { workspaceUri: string; anchorPath: string } | undefined;

  constructor(
    private readonly index: PathIndex,
    private readonly recentPaths: RecentPathStore,
  ) {}

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
    let scheduledIndexUpdate: NodeJS.Timeout | undefined;
    let searchGeneration = 0;
    let searchInProgress = false;
    let suppressActiveChange = false;
    const expectedProgrammaticActiveIdentities = new Set<string>();
    const resultUpdates = new ResultUpdateGate<PathEntry>();
    let programmaticTargetIdentity: string | undefined;
    let currentScopePath = '';
    let currentSearchTruncated = false;
    picker.placeholder = 'Type a name, then press Tab to complete the selected path';
    picker.title = 'Path Navigator';
    picker.buttons = [refreshButton];
    picker.busy = this.index.isBuilding;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;

    const clearScheduledIndexUpdate = (): void => {
      if (scheduledIndexUpdate) {
        clearTimeout(scheduledIndexUpdate);
        scheduledIndexUpdate = undefined;
      }
    };

    const updateBusyState = (): void => {
      picker.busy = this.index.isBuilding || searchInProgress;
    };

    const updateTitle = (): void => {
      const baseTitle = currentScopePath
        ? `Path Navigator — ${currentScopePath}/`
        : 'Path Navigator';
      if (resultUpdates.isFrozen) {
        picker.title = `${baseTitle} — results paused`;
      } else if (currentSearchTruncated) {
        picker.title = `${baseTitle} — limited search`;
      } else {
        picker.title = baseTitle;
      }
    };

    const freezeVisibleResults = (): void => {
      if (resultUpdates.isFrozen) {
        return;
      }
      resultUpdates.freeze();
      clearScheduledIndexUpdate();
      updateTitle();
    };
    this.freezeActiveResults = freezeVisibleResults;

    const consumeProgrammaticActiveChange = (
      activeIdentity: string | undefined,
    ): boolean => {
      if (
        !activeIdentity ||
        !expectedProgrammaticActiveIdentities.has(activeIdentity)
      ) {
        return false;
      }
      if (activeIdentity === programmaticTargetIdentity) {
        expectedProgrammaticActiveIdentities.clear();
        programmaticTargetIdentity = undefined;
      } else {
        expectedProgrammaticActiveIdentities.delete(activeIdentity);
      }
      return true;
    };

    const applyEntries = (
      entries: readonly PathEntry[],
      resetActiveItem: boolean,
      searchComplete: boolean,
    ): void => {
      if (!resultUpdates.shouldApply(entries)) {
        return;
      }

      const previousActiveItem = resetActiveItem
        ? undefined
        : (picker.activeItems[0] ?? picker.selectedItems[0]);
      const previousActiveIdentity = previousActiveItem
        ? pathIdentity(previousActiveItem.entry)
        : undefined;
      const previousActiveIndex = previousActiveItem
        ? picker.items.findIndex(
            (item) => pathIdentity(item.entry) === previousActiveIdentity,
          )
        : -1;
      const maxResults = vscode.workspace
        .getConfiguration('pathNavigator')
        .get<number>('maxResults', 200);
      const previousEntry = previousActiveItem?.entry;
      const activeEntryInResults = previousActiveIdentity
        ? entries.find((entry) => pathIdentity(entry) === previousActiveIdentity)
        : undefined;
      const activeEntryInCatalog = previousActiveIdentity
        ? this.index.currentSearchCatalog.getEntry(previousActiveIdentity)
        : undefined;
      const activeEntryToPin =
        activeEntryInResults ??
        activeEntryInCatalog ??
        (!searchComplete ? previousEntry : undefined);
      const visibleEntries = pinActivePath(entries, activeEntryToPin, maxResults);
      const nextItems = visibleEntries.map((item) =>
        this.toQuickPickItem(item, enterDirectoryButton),
      );
      suppressActiveChange = true;
      expectedProgrammaticActiveIdentities.clear();
      if (nextItems[0]) {
        expectedProgrammaticActiveIdentities.add(pathIdentity(nextItems[0].entry));
      }
      picker.items = nextItems;

      const nextActiveIndex = resetActiveItem
        ? nextItems.length > 0
          ? 0
          : -1
        : restoredActiveIndex(visibleEntries, previousActiveIdentity, previousActiveIndex);
      const nextActiveItem = nextActiveIndex >= 0 ? nextItems[nextActiveIndex] : undefined;
      if (nextActiveItem) {
        programmaticTargetIdentity = pathIdentity(nextActiveItem.entry);
        expectedProgrammaticActiveIdentities.add(programmaticTargetIdentity);
      } else {
        programmaticTargetIdentity = undefined;
      }
      picker.activeItems = nextActiveItem ? [nextActiveItem] : [];
      queueMicrotask(() => {
        suppressActiveChange = false;
      });
    };

    const startSearch = (resetActiveItem: boolean): void => {
      clearScheduledIndexUpdate();
      if (resetActiveItem) {
        resultUpdates.reset();
      }
      this.reconcileWorkspaceLock(picker.value);
      const { scopePath, query } = parsePathInput(picker.value);
      currentScopePath = scopePath;
      currentSearchTruncated = false;
      updateTitle();

      const generation = ++searchGeneration;
      searchInProgress = true;
      updateBusyState();
      let firstProgress = true;
      const configuration = vscode.workspace.getConfiguration('pathNavigator');
      const maxResults = configuration.get<number>('maxResults', 200);
      const maxCandidates = configuration.get<number>('maxSearchCandidates', 10_000);
      const timeBudgetMs = configuration.get<number>('searchTimeBudgetMs', 150);

      void searchPaths({
        catalog: this.index.currentSearchCatalog,
        scopePath,
        query,
        workspaceUri: this.workspaceLock?.workspaceUri,
        maxResults,
        maxCandidates,
        timeBudgetMs,
        recentPaths: this.recentPaths.getUsages(),
        allowUnindexedRecentPaths: this.index.isBuilding,
        isCancelled: () =>
          generation !== searchGeneration || this.activePicker !== picker,
        onProgress: (progress) => {
          if (generation !== searchGeneration || this.activePicker !== picker) {
            return;
          }
          const isInitialBackgroundProgress =
            !resetActiveItem && firstProgress && !progress.complete;
          const shouldResetActiveItem = resetActiveItem && firstProgress;
          firstProgress = false;
          if (!isInitialBackgroundProgress) {
            applyEntries(progress.entries, shouldResetActiveItem, progress.complete);
          }
          currentSearchTruncated = progress.complete && progress.truncated;
          updateTitle();
          if (progress.complete) {
            searchInProgress = false;
            updateBusyState();
          }
        },
      })
        .catch((error: unknown) => {
          if (generation === searchGeneration && this.activePicker === picker) {
            void vscode.window.showErrorMessage(`Path Navigator search failed: ${String(error)}`);
          }
        })
        .finally(() => {
          if (generation === searchGeneration) {
            searchInProgress = false;
            updateBusyState();
          }
        });
    };

    const flushIndexUpdate = (): void => {
      clearScheduledIndexUpdate();
      if (this.activePicker === picker && !resultUpdates.isFrozen) {
        startSearch(false);
      }
    };

    const scheduleIndexUpdate = (): void => {
      if (scheduledIndexUpdate || resultUpdates.isFrozen) {
        return;
      }
      scheduledIndexUpdate = setTimeout(flushIndexUpdate, INDEX_RESULT_UPDATE_INTERVAL_MS);
    };

    disposables.push(
      picker.onDidChangeValue(() => {
        clearScheduledIndexUpdate();
        expectedProgrammaticActiveIdentities.clear();
        programmaticTargetIdentity = undefined;
        startSearch(true);
      }),
      picker.onDidChangeActive((items) => {
        const activeIdentity = items[0] ? pathIdentity(items[0].entry) : undefined;
        if (suppressActiveChange) {
          consumeProgrammaticActiveChange(activeIdentity);
          return;
        }
        if (consumeProgrammaticActiveChange(activeIdentity)) {
          return;
        }
        if (activeIdentity) {
          freezeVisibleResults();
        }
      }),
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
          resultUpdates.reset();
          updateTitle();
          void this.index.rebuild();
        }
      }),
      picker.onDidTriggerItemButton((event) => {
        if (event.button === enterDirectoryButton) {
          this.completeEntry(event.item.entry, picker);
        }
      }),
      picker.onDidHide(() => {
        searchGeneration += 1;
        clearScheduledIndexUpdate();
        for (const disposable of disposables.splice(0)) {
          disposable.dispose();
        }
        this.activePicker = undefined;
        this.freezeActiveResults = undefined;
        this.workspaceLock = undefined;
        void vscode.commands.executeCommand('setContext', 'pathNavigator.active', false);
        picker.dispose();
      }),
      this.index.onDidChange(scheduleIndexUpdate),
      this.index.onDidChangeBuilding((building) => {
        updateBusyState();
        if (!building) {
          flushIndexUpdate();
        }
      }),
    );

    picker.show();
    await vscode.commands.executeCommand('setContext', 'pathNavigator.active', true);
    startSearch(true);
    await this.index.ensureReady();
    if (this.activePicker === picker && !resultUpdates.isFrozen) {
      flushIndexUpdate();
    }
  }

  navigateSelection(direction: 'next' | 'previous'): void {
    if (!this.activePicker) {
      return;
    }

    // Freeze synchronously, before VS Code changes the active item. Relying only
    // on onDidChangeActive leaves a race in which an in-flight result update can
    // replace the list between the key press and the active-item event.
    this.freezeActiveResults?.();
    const command =
      direction === 'next'
        ? 'workbench.action.quickOpenSelectNext'
        : 'workbench.action.quickOpenSelectPrevious';
    void vscode.commands.executeCommand(command);
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
        this.recentPaths.record(entry);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not open ${entry.relativePath}: ${String(error)}`);
      }
      return;
    }

    try {
      await vscode.commands.executeCommand('revealInExplorer', entry.uri);
      this.recentPaths.record(entry);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not reveal ${entry.relativePath} in Explorer: ${String(error)}`,
      );
    }
  }
}
