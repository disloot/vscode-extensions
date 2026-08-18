import * as vscode from 'vscode';
import { LruCache } from './lruCache';
import { PathEntry } from './pathEntry';
import { PathIndex } from './pathIndex';
import type { PathEntryId } from './pathSearchCatalog';
import { searchPaths, type PathSearchProgress } from './pathSearchEngine';
import { RecentPathStore } from './recentPaths';
import {
  pathIdentity,
  pinActivePath,
  restoredActiveIndex,
  ResultUpdateGate,
  samePathOrder,
} from './resultSelection';
import {
  normalizeSearchQuery,
  normalizeSearchText,
  parentDirectoryInput,
  parsePathInput,
} from './search';

interface PathQuickPickItem extends vscode.QuickPickItem {
  readonly entry: PathEntry;
}

type DirectoryAction = 'reveal' | 'enter';
type ResultPathDisplay = 'parent' | 'full' | 'hidden';

const INDEX_RESULT_UPDATE_INTERVAL_MS = 300;
const SEARCH_CACHE_SIZE = 32;

interface ReusableSearchState {
  readonly contextKey: string;
  readonly normalizedQuery: string;
  readonly entryIds: readonly PathEntryId[];
  readonly exhaustive: boolean;
}

export class PathPicker {
  private activePicker: vscode.QuickPick<PathQuickPickItem> | undefined;
  private freezeActiveResults: (() => void) | undefined;
  private refreshActivePicker: (() => void) | undefined;
  private readonly searchCache = new LruCache<string, PathSearchProgress>(SEARCH_CACHE_SIZE);
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
    const settingsButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('gear'),
      tooltip: 'Open Path Navigator settings',
    };
    let showFiles = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<boolean>('showFiles', true);
    let showDirectories = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<boolean>('showDirectories', true);
    let fileFilterButton: vscode.QuickInputButton;
    let directoryFilterButton: vscode.QuickInputButton;
    const enterDirectoryButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('arrow-right'),
      tooltip: 'Enter directory',
    };
    const pinButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('star-empty'),
      tooltip: 'Pin this path',
    };
    const unpinButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('star-full'),
      tooltip: 'Unpin this path',
    };
    const disposables: vscode.Disposable[] = [];
    let scheduledIndexUpdate: NodeJS.Timeout | undefined;
    let searchGeneration = 0;
    let searchInProgress = false;
    let suppressActiveChange = false;
    const expectedProgrammaticActiveIdentities = new Set<string>();
    const resultUpdates = new ResultUpdateGate<PathEntry>();
    let programmaticTargetIdentity: string | undefined;
    let currentVisibleEntries: readonly PathEntry[] = [];
    let currentScopePath = '';
    let currentSearchTruncated = false;
    let reusableSearch: ReusableSearchState | undefined;
    picker.placeholder = 'Search paths · // global path · Tab enter directory';
    picker.title = 'Path Navigator';
    const updateFilterButtons = (): void => {
      fileFilterButton = {
        iconPath: new vscode.ThemeIcon(showFiles ? 'files' : 'circle-slash'),
        tooltip: showFiles ? 'Hide files' : 'Show files',
      };
      directoryFilterButton = {
        iconPath: new vscode.ThemeIcon(showDirectories ? 'folder' : 'circle-slash'),
        tooltip: showDirectories ? 'Hide directories' : 'Show directories',
      };
      picker.buttons = [
        fileFilterButton,
        directoryFilterButton,
        refreshButton,
        settingsButton,
      ];
    };
    updateFilterButtons();
    picker.busy = this.index.isBuilding;
    picker.ignoreFocusOut = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<boolean>('keepOpenOnFocusLost', false);
    picker.keepScrollPosition = true;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;

    const clearScheduledIndexUpdate = (): void => {
      if (scheduledIndexUpdate) {
        clearTimeout(scheduledIndexUpdate);
        scheduledIndexUpdate = undefined;
      }
    };

    const updateBusyState = (): void => {
      picker.busy = !resultUpdates.isFrozen && (this.index.isBuilding || searchInProgress);
    };

    const updatePrompt = (): void => {
      const showStatusPrompt = vscode.workspace
        .getConfiguration('pathNavigator')
        .get<boolean>('showStatusPrompt', true);
      if (!showStatusPrompt) {
        picker.prompt = undefined;
        return;
      }
      const resultCount = currentVisibleEntries.length;
      if (resultUpdates.isFrozen) {
        picker.prompt = `${resultCount} results paused · Type to resume updates`;
      } else if (this.index.isBuilding) {
        picker.prompt = `Indexing workspace · ${this.index.entryCount.toLocaleString()} paths ready`;
      } else if (searchInProgress) {
        picker.prompt = 'Searching indexed paths…';
      } else if (this.index.isLimited) {
        picker.prompt = `${resultCount} matches · index limited at ${this.index.entryCount.toLocaleString()} paths`;
      } else if (this.index.isPartial) {
        picker.prompt = `${resultCount} matches · partial index, enter a directory to load it`;
      } else if (currentSearchTruncated) {
        picker.prompt = `${resultCount} best matches · search budget reached`;
      } else if (resultCount === 0) {
        picker.prompt = 'No matching paths';
      } else {
        picker.prompt = `${resultCount} matches · ↑↓ navigate · Tab enter directory`;
      }
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
      const freezeOnNavigation = vscode.workspace
        .getConfiguration('pathNavigator')
        .get<boolean>('freezeResultsOnNavigation', true);
      if (!freezeOnNavigation) {
        return;
      }
      if (resultUpdates.isFrozen) {
        return;
      }
      resultUpdates.freeze();
      clearScheduledIndexUpdate();
      updateTitle();
      updateBusyState();
      updatePrompt();
    };
    this.freezeActiveResults = freezeVisibleResults;

    const refreshPicker = (): void => {
      resultUpdates.reset();
      this.searchCache.clear();
      updateTitle();
      updateBusyState();
      updatePrompt();
      void this.index.rebuild();
    };
    this.refreshActivePicker = refreshPicker;

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
      const configuration = vscode.workspace.getConfiguration('pathNavigator');
      const maxResults = configuration.get<number>('maxResults', 200);
      const resultPathDisplay = configuration.get<ResultPathDisplay>(
        'resultPathDisplay',
        'parent',
      );
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
      const nextVisibleEntries = pinActivePath(entries, activeEntryToPin, maxResults);
      if (!resetActiveItem && samePathOrder(nextVisibleEntries, currentVisibleEntries)) {
        return;
      }
      const nextItems = nextVisibleEntries.map((item) =>
        this.toQuickPickItem(
          item,
          enterDirectoryButton,
          pinButton,
          unpinButton,
          resultPathDisplay,
        ),
      );
      currentVisibleEntries = nextVisibleEntries;
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
        : restoredActiveIndex(nextVisibleEntries, previousActiveIdentity, previousActiveIndex);
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
      const { scopePath, query, mode } = parsePathInput(picker.value);
      void this.index.ensureScopeIndexed(this.workspaceLock?.workspaceUri, scopePath);
      currentScopePath = scopePath;
      currentSearchTruncated = false;
      updateTitle();

      const generation = ++searchGeneration;
      const configuration = vscode.workspace.getConfiguration('pathNavigator');
      const maxResults = configuration.get<number>('maxResults', 200);
      const maxCandidates = configuration.get<number>('maxSearchCandidates', 10_000);
      const timeBudgetMs = configuration.get<number>('searchTimeBudgetMs', 150);
      const includeFiles = showFiles;
      const includeDirectories = showDirectories;
      const fuzzyMatching = configuration.get<boolean>('fuzzyMatching', true);
      const progressiveSearchResults = configuration.get<boolean>(
        'progressiveSearchResults',
        false,
      );
      const catalog = this.index.currentSearchCatalog;
      const catalogRevision = catalog.revision;
      const workspaceUri = this.workspaceLock?.workspaceUri;
      const recentPaths = this.recentPaths.getUsages();
      const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
      const normalizedQuery = normalizeSearchQuery(query);
      const reuseContextKey = JSON.stringify([
        catalog.instanceId,
        catalogRevision,
        normalizedScope,
        workspaceUri ?? '',
        includeFiles,
        includeDirectories,
        fuzzyMatching,
        mode,
        progressiveSearchResults,
      ]);
      const previousReusableSearch = reusableSearch;
      const canReusePrevious =
        previousReusableSearch !== undefined &&
        previousReusableSearch.contextKey === reuseContextKey &&
        normalizedQuery.length > previousReusableSearch.normalizedQuery.length &&
        normalizedQuery.startsWith(previousReusableSearch.normalizedQuery);
      const reuse = canReusePrevious
        ? {
            entryIds: previousReusableSearch.entryIds,
            exhaustive: previousReusableSearch.exhaustive,
          }
        : undefined;
      const cacheKey = JSON.stringify([
        catalog.instanceId,
        catalogRevision,
        normalizedScope,
        normalizedQuery,
        workspaceUri ?? '',
        maxResults,
        maxCandidates,
        timeBudgetMs,
        includeFiles,
        includeDirectories,
        fuzzyMatching,
        mode,
        progressiveSearchResults,
        this.recentPaths.revision,
      ]);
      const cachedResult = !this.index.isBuilding ? this.searchCache.get(cacheKey) : undefined;
      if (cachedResult) {
        currentSearchTruncated = cachedResult.truncated;
        searchInProgress = false;
        applyEntries(cachedResult.entries, resetActiveItem, true);
        updateTitle();
        updateBusyState();
        updatePrompt();
        return;
      }

      searchInProgress = true;
      updateBusyState();
      updatePrompt();
      let firstProgress = true;

      void searchPaths({
        catalog,
        scopePath,
        query,
        workspaceUri,
        maxResults,
        maxCandidates,
        timeBudgetMs,
        recentPaths,
        allowUnindexedRecentPaths: this.index.isBuilding,
        includeFiles,
        includeDirectories,
        fuzzyMatching,
        globalPathQuery: mode === 'globalPath',
        publishIntermediateResults: progressiveSearchResults,
        reuse,
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
          if (progress.complete) {
            searchInProgress = false;
            reusableSearch = {
              contextKey: reuseContextKey,
              normalizedQuery,
              entryIds: progress.reusableCandidateIds ?? [],
              exhaustive:
                normalizedQuery.length >= 3 &&
                !progress.truncated &&
                progress.reusableCandidateIds !== undefined,
            };
            if (
              !this.index.isBuilding &&
              this.index.currentSearchCatalog === catalog &&
              catalog.revision === catalogRevision
            ) {
              this.searchCache.set(cacheKey, {
                entries: progress.entries,
                complete: true,
                processedCandidates: progress.processedCandidates,
                truncated: progress.truncated,
              });
            }
          }
          updateTitle();
          updateBusyState();
          updatePrompt();
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
            updatePrompt();
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
        const directoryAction = vscode.workspace
          .getConfiguration('pathNavigator')
          .get<DirectoryAction>('directoryAction', 'reveal');
        if (selected.entry.kind === 'directory' && directoryAction === 'enter') {
          this.completeEntry(selected.entry, picker);
          return;
        }
        picker.hide();
        void this.openEntry(selected.entry);
      }),
      picker.onDidTriggerButton((button) => {
        if (button === fileFilterButton) {
          if (showFiles && !showDirectories) {
            return;
          }
          showFiles = !showFiles;
          updateFilterButtons();
          this.searchCache.clear();
          startSearch(true);
        } else if (button === directoryFilterButton) {
          if (showDirectories && !showFiles) {
            return;
          }
          showDirectories = !showDirectories;
          updateFilterButtons();
          this.searchCache.clear();
          startSearch(true);
        } else if (button === refreshButton) {
          refreshPicker();
        } else if (button === settingsButton) {
          void vscode.commands.executeCommand('pathNavigator.openSettings');
        }
      }),
      picker.onDidTriggerItemButton((event) => {
        if (event.button === enterDirectoryButton) {
          this.completeEntry(event.item.entry, picker);
        } else if (event.button === pinButton || event.button === unpinButton) {
          this.recentPaths.togglePinned(event.item.entry);
          resultUpdates.reset();
          this.searchCache.clear();
          startSearch(false);
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
        this.refreshActivePicker = undefined;
        this.workspaceLock = undefined;
        void vscode.commands.executeCommand('setContext', 'pathNavigator.active', false);
        picker.dispose();
      }),
      this.index.onDidChange(() => {
        this.searchCache.clear();
        updatePrompt();
        scheduleIndexUpdate();
      }),
      this.index.onDidChangeBuilding((building) => {
        updateBusyState();
        updatePrompt();
        if (!building) {
          flushIndexUpdate();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const configuration = vscode.workspace.getConfiguration('pathNavigator');
        if (event.affectsConfiguration('pathNavigator.keepOpenOnFocusLost')) {
          picker.ignoreFocusOut = configuration.get<boolean>('keepOpenOnFocusLost', false);
        }
        if (event.affectsConfiguration('pathNavigator.showStatusPrompt')) {
          updatePrompt();
        }
        const searchKeys = [
          'pathNavigator.showFiles',
          'pathNavigator.showDirectories',
          'pathNavigator.fuzzyMatching',
          'pathNavigator.resultPathDisplay',
          'pathNavigator.maxResults',
          'pathNavigator.maxSearchCandidates',
          'pathNavigator.searchTimeBudgetMs',
          'pathNavigator.recentPathsLimit',
          'pathNavigator.progressiveSearchResults',
        ];
        if (searchKeys.some((key) => event.affectsConfiguration(key))) {
          if (event.affectsConfiguration('pathNavigator.showFiles')) {
            showFiles = configuration.get<boolean>('showFiles', true);
          }
          if (event.affectsConfiguration('pathNavigator.showDirectories')) {
            showDirectories = configuration.get<boolean>('showDirectories', true);
          }
          updateFilterButtons();
          this.searchCache.clear();
          startSearch(true);
        } else if (
          event.affectsConfiguration('pathNavigator.freezeResultsOnNavigation') &&
          !configuration.get<boolean>('freezeResultsOnNavigation', true) &&
          resultUpdates.isFrozen
        ) {
          resultUpdates.reset();
          updateTitle();
          startSearch(false);
        }
      }),
    );

    picker.show();
    await vscode.commands.executeCommand('setContext', 'pathNavigator.active', true);
    startSearch(true);
    await this.index.ensureReady();
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

  goToParentDirectory(): void {
    const picker = this.activePicker;
    if (!picker) {
      return;
    }
    const parentInput = parentDirectoryInput(picker.value);
    if (parentInput !== picker.value) {
      picker.value = parentInput;
    }
  }

  refreshIndex(): void {
    if (this.refreshActivePicker) {
      this.refreshActivePicker();
    } else {
      void this.index.rebuild();
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
    pinButton: vscode.QuickInputButton,
    unpinButton: vscode.QuickInputButton,
    pathDisplay: ResultPathDisplay,
  ): PathQuickPickItem {
    const multipleRoots = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const separatorIndex = entry.relativePath.lastIndexOf('/');
    const parentPath = separatorIndex < 0 ? './' : entry.relativePath.slice(0, separatorIndex);
    const displayedPath = pathDisplay === 'full'
      ? entry.relativePath
      : pathDisplay === 'parent'
        ? parentPath
        : undefined;
    const description = displayedPath
      ? multipleRoots
        ? `${entry.workspaceName} · ${displayedPath}`
        : displayedPath
      : multipleRoots
        ? entry.workspaceName
        : undefined;
    const pinToggleButton = this.recentPaths.isPinned(entry) ? unpinButton : pinButton;
    return {
      label: `$(${entry.kind === 'directory' ? 'folder' : 'file'}) ${entry.name}`,
      description,
      alwaysShow: true,
      buttons: entry.kind === 'directory'
        ? [enterDirectoryButton, pinToggleButton]
        : [pinToggleButton],
      entry,
    };
  }

  private async openEntry(entry: PathEntry): Promise<void> {
    const entryUri = entry.uri ?? vscode.Uri.joinPath(
      vscode.Uri.parse(entry.workspaceUri),
      ...entry.relativePath.split('/'),
    );
    try {
      const stat = await vscode.workspace.fs.stat(entryUri);
      const expectedType = entry.kind === 'directory'
        ? vscode.FileType.Directory
        : vscode.FileType.File;
      if ((stat.type & expectedType) === 0) {
        throw new Error(`Path is no longer a ${entry.kind}.`);
      }
    } catch (error) {
      this.index.discardEntry(entry);
      void vscode.window.showWarningMessage(
        `Path Navigator removed a stale result: ${entry.relativePath} (${String(error)})`,
      );
      return;
    }
    if (entry.kind === 'file') {
      const preview = vscode.workspace
        .getConfiguration('pathNavigator')
        .get<boolean>('openFilesInPreview', false);
      try {
        await vscode.commands.executeCommand('vscode.open', entryUri, { preview });
        this.recentPaths.record(entry);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not open ${entry.relativePath}: ${String(error)}`);
      }
      return;
    }

    try {
      await vscode.commands.executeCommand('revealInExplorer', entryUri);
      this.recentPaths.record(entry);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not reveal ${entry.relativePath} in Explorer: ${String(error)}`,
      );
    }
  }
}
