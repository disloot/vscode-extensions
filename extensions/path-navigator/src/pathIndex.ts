import * as vscode from 'vscode';
import { createPathEntry, PathEntry } from './pathEntry';
import {
  hasExcludedFileExtension,
  normalizeExcludedFileExtensions,
} from './pathFilters';
import { PathSearchCatalog } from './pathSearchCatalog';
import { normalizeSearchText } from './search';

interface IndexSnapshot {
  readonly errors: readonly string[];
}

interface PendingDirectory {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly normalizedPath: string;
}

const DEFAULT_CONCURRENT_DIRECTORY_READS = 12;
const PROGRESS_ENTRY_BATCH_SIZE = 250;
const PROGRESS_INTERVAL_MS = 100;
const REBUILD_DEBOUNCE_MS = 750;

export class PathIndex implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<boolean>();
  private entries: readonly PathEntry[] = [];
  private searchCatalog = new PathSearchCatalog();
  private rebuildPromise: Promise<void> | undefined;
  private rebuildTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private building = false;
  private limited = false;

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeBuilding = this.statusEmitter.event;

  constructor() {
    this.disposables.push(this.changeEmitter, this.statusEmitter);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.resetWatchers();
        void this.rebuild();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('pathNavigator.autoRefreshIndex') &&
          !vscode.workspace
            .getConfiguration('pathNavigator')
            .get<boolean>('autoRefreshIndex', true) &&
          this.rebuildTimer
        ) {
          clearTimeout(this.rebuildTimer);
          this.rebuildTimer = undefined;
        }
        if (
          event.affectsConfiguration('pathNavigator.excludeDirectoryNames') ||
          event.affectsConfiguration('pathNavigator.excludeFileExtensions') ||
          event.affectsConfiguration('pathNavigator.maxIndexEntries') ||
          event.affectsConfiguration('pathNavigator.indexConcurrency')
        ) {
          void this.rebuild();
        }
      }),
    );
    this.resetWatchers();
  }

  get isBuilding(): boolean {
    return this.building;
  }

  get isLimited(): boolean {
    return this.limited;
  }

  get entryCount(): number {
    return this.searchCatalog.size;
  }

  get currentEntries(): readonly PathEntry[] {
    return this.entries;
  }

  get currentSearchCatalog(): PathSearchCatalog {
    return this.searchCatalog;
  }

  async ensureReady(): Promise<readonly PathEntry[]> {
    if (this.rebuildPromise) {
      await this.rebuildPromise;
    } else if (this.entries.length === 0) {
      await this.rebuild();
    }
    return this.entries;
  }

  rebuild(): Promise<void> {
    const requestedGeneration = ++this.generation;
    const promise = this.build(requestedGeneration);
    this.rebuildPromise = promise;
    void promise.finally(() => {
      if (this.rebuildPromise === promise) {
        this.rebuildPromise = undefined;
      }
    });
    return promise;
  }

  private async build(requestedGeneration: number): Promise<void> {
    this.setBuilding(true);
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const configuration = vscode.workspace.getConfiguration('pathNavigator');
      const excludedNames = new Set(
        configuration
          .get<string[]>('excludeDirectoryNames', [])
          .map((name) => name.toLocaleLowerCase()),
      );
      const excludedFileExtensions = normalizeExcludedFileExtensions(
        configuration.get<string[]>('excludeFileExtensions', []),
      );
      const configuredMaxEntries = configuration.get<number>('maxIndexEntries', 500_000);
      const maxEntries = Number.isFinite(configuredMaxEntries)
        ? Math.max(0, Math.floor(configuredMaxEntries))
        : 500_000;
      const configuredConcurrency = configuration.get<number>(
        'indexConcurrency',
        DEFAULT_CONCURRENT_DIRECTORY_READS,
      );
      const indexConcurrency = Number.isFinite(configuredConcurrency)
        ? Math.min(32, Math.max(1, Math.floor(configuredConcurrency)))
        : DEFAULT_CONCURRENT_DIRECTORY_READS;
      const collectedEntries: PathEntry[] = [];
      const buildingSearchCatalog = new PathSearchCatalog();
      let publishedEntryCount = 0;
      let lastPublishedAt = 0;
      let limitReached = false;

      const publishProgress = (force = false): void => {
        if (requestedGeneration !== this.generation) {
          return;
        }

        const now = Date.now();
        const addedEntryCount = collectedEntries.length - publishedEntryCount;
        if (
          !force &&
          publishedEntryCount > 0 &&
          addedEntryCount < PROGRESS_ENTRY_BATCH_SIZE &&
          now - lastPublishedAt < PROGRESS_INTERVAL_MS
        ) {
          return;
        }

        // Reuse the append-only array while indexing. Copying every published
        // prefix makes large indexes approach quadratic allocation cost.
        this.entries = collectedEntries;
        this.searchCatalog = buildingSearchCatalog;
        this.limited = limitReached;
        publishedEntryCount = collectedEntries.length;
        lastPublishedAt = now;
        this.changeEmitter.fire();
      };

      const snapshots = await Promise.all(
        folders.map((folder) =>
          this.scanWorkspaceFolder(
            folder,
            excludedNames,
            excludedFileExtensions,
            (entries) => {
              const remaining = maxEntries === 0
                ? entries.length
                : Math.max(0, maxEntries - collectedEntries.length);
              const acceptedEntries =
                remaining >= entries.length ? entries : entries.slice(0, remaining);
              if (acceptedEntries.length > 0) {
                collectedEntries.push(...acceptedEntries);
                buildingSearchCatalog.addEntries(acceptedEntries);
              }
              if (maxEntries > 0 && collectedEntries.length >= maxEntries) {
                limitReached = true;
              }
              publishProgress();
            },
            () => requestedGeneration === this.generation && !limitReached,
            indexConcurrency,
          ),
        ),
      );

      if (requestedGeneration !== this.generation) {
        return;
      }

      publishProgress(true);

      const errors = snapshots.flatMap((snapshot) => snapshot.errors);
      if (errors.length > 0) {
        const suffix =
          errors.length === 1 ? errors[0] : `${errors.length} directories could not be read.`;
        void vscode.window.showWarningMessage(`Path Navigator index is incomplete: ${suffix}`);
      }
    } finally {
      if (requestedGeneration === this.generation) {
        this.setBuilding(false);
      }
    }
  }

  private async scanWorkspaceFolder(
    workspaceFolder: vscode.WorkspaceFolder,
    excludedNames: ReadonlySet<string>,
    excludedFileExtensions: ReadonlySet<string>,
    onEntries: (entries: readonly PathEntry[]) => void,
    shouldContinue: () => boolean,
    concurrency: number,
  ): Promise<IndexSnapshot> {
    const errors: string[] = [];
    const workspaceName = workspaceFolder.name;
    const workspaceUri = workspaceFolder.uri.toString();
    const normalizedWorkspaceName = normalizeSearchText(workspaceName);
    let directories: PendingDirectory[] = [
      { uri: workspaceFolder.uri, relativePath: '', normalizedPath: '' },
    ];

    while (directories.length > 0 && shouldContinue()) {
      const currentLevel = directories;
      const nextLevel: PendingDirectory[] = [];
      let nextDirectoryIndex = 0;

      const scanNextDirectory = async (): Promise<void> => {
        while (shouldContinue()) {
          const directory = currentLevel[nextDirectoryIndex];
          nextDirectoryIndex += 1;
          if (!directory) {
            return;
          }

          let children: [string, vscode.FileType][];
          try {
            children = await vscode.workspace.fs.readDirectory(directory.uri);
          } catch (error) {
            errors.push(`${directory.uri.toString()}: ${String(error)}`);
            continue;
          }

          if (!shouldContinue()) {
            return;
          }

          const discoveredEntries: PathEntry[] = [];
          for (const [name, fileType] of children) {
            const normalizedName = normalizeSearchText(name);
            const relativePath = directory.relativePath
              ? `${directory.relativePath}/${name}`
              : name;
            const normalizedPath = directory.normalizedPath
              ? `${directory.normalizedPath}/${normalizedName}`
              : normalizedName;
            const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
            const isSymbolicLink = (fileType & vscode.FileType.SymbolicLink) !== 0;

            if (isDirectory) {
              if (excludedNames.has(normalizedName)) {
                continue;
              }
              const uri = vscode.Uri.joinPath(directory.uri, name);
              discoveredEntries.push(createPathEntry({
                uri,
                kind: 'directory',
                name,
                relativePath,
                workspaceName,
                workspaceUri,
                normalizedName,
                normalizedPath,
                normalizedWorkspaceName,
              }));
              if (!isSymbolicLink) {
                nextLevel.push({ uri, relativePath, normalizedPath });
              }
              continue;
            }

            if (hasExcludedFileExtension(normalizedName, excludedFileExtensions)) {
              continue;
            }
            const uri = vscode.Uri.joinPath(directory.uri, name);
            discoveredEntries.push(createPathEntry({
              uri,
              kind: 'file',
              name,
              relativePath,
              workspaceName,
              workspaceUri,
              normalizedName,
              normalizedPath,
              normalizedWorkspaceName,
            }));
          }

          if (discoveredEntries.length > 0) {
            onEntries(discoveredEntries);
          }
        }
      };

      const workerCount = Math.min(concurrency, currentLevel.length);
      await Promise.all(Array.from({ length: workerCount }, () => scanNextDirectory()));
      directories = nextLevel;
    }

    return { errors };
  }

  private resetWatchers(): void {
    for (const watcher of this.watchers.splice(0)) {
      watcher.dispose();
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/*'),
        false,
        true,
        false,
      );
      watcher.onDidCreate(() => this.scheduleRebuild(), this, this.disposables);
      watcher.onDidDelete(() => this.scheduleRebuild(), this, this.disposables);
      this.watchers.push(watcher);
    }
  }

  private scheduleRebuild(): void {
    const autoRefresh = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<boolean>('autoRefreshIndex', true);
    if (!autoRefresh) {
      return;
    }
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      void this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  private setBuilding(building: boolean): void {
    if (this.building !== building) {
      this.building = building;
      this.statusEmitter.fire(building);
    }
  }

  dispose(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
