import * as vscode from 'vscode';
import {
  createCompactPathEntry,
  createPathWorkspaceMetadata,
  PathEntry,
  type PathWorkspaceMetadata,
} from './pathEntry';
import {
  hasExcludedFileExtension,
  normalizeExcludedFileExtensions,
} from './pathFilters';
import {
  PartitionedPathSearchCatalog,
  PathSearchCatalog,
  type PathSearchIndex,
} from './pathSearchCatalog';
import { PathIndexPersistence } from './pathIndexPersistence';
import { normalizeSearchText } from './search';

interface IndexSnapshot {
  readonly errors: readonly string[];
  readonly partial: boolean;
  readonly durationMs?: number;
  readonly pathCount?: number;
}


interface PendingDirectory {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly normalizedPath: string;
  readonly depth: number;
}

interface IndexConfiguration {
  readonly excludedNames: ReadonlySet<string>;
  readonly excludedFileExtensions: ReadonlySet<string>;
  readonly maxEntries: number;
  readonly indexConcurrency: number;
  readonly adaptiveRemoteConcurrency: boolean;
  readonly incrementalUpdateBatchLimit: number;
  readonly initialIndexDepth: number;
  readonly persistIndex: boolean;
  readonly persistentIndexMaxAgeHours: number;
  readonly refreshPersistentIndexInBackground: boolean;
}

interface PendingFileSystemChange {
  readonly kind: 'create' | 'delete';
  readonly uri: vscode.Uri;
  readonly workspaceFolder: vscode.WorkspaceFolder;
}

const DEFAULT_CONCURRENT_DIRECTORY_READS = 12;
const PROGRESS_ENTRY_BATCH_SIZE = 250;
const PROGRESS_INTERVAL_MS = 100;
const INCREMENTAL_UPDATE_DEBOUNCE_MS = 150;
const DEFAULT_INCREMENTAL_UPDATE_BATCH_LIMIT = 2_000;
const CATALOG_COMPACTION_TOMBSTONE_RATIO = 0.2;
const CACHE_SAVE_DEBOUNCE_MS = 2_000;

async function scanDirectoryWorkQueue(
  initialDirectories: readonly PendingDirectory[],
  maxConcurrency: number,
  adaptiveConcurrency: boolean,
  shouldContinue: () => boolean,
  isPriority: (directory: PendingDirectory) => boolean,
  scan: (directory: PendingDirectory) => Promise<readonly PendingDirectory[]>,
): Promise<void> {
  const priorityQueue: PendingDirectory[] = [];
  const normalQueue = [...initialDirectories];
  let normalIndex = 0;
  let activeWorkers = 0;
  let targetConcurrency = adaptiveConcurrency
    ? Math.min(maxConcurrency, 4)
    : maxConcurrency;
  let latencyEwma = 0;
  let bestLatencyEwma = Number.POSITIVE_INFINITY;
  let observedDirectories = 0;

  const takeNext = (): PendingDirectory | undefined =>
    priorityQueue.pop() ?? normalQueue[normalIndex++];
  const hasPending = (): boolean =>
    priorityQueue.length > 0 || normalIndex < normalQueue.length;

  await new Promise<void>((resolve) => {
    const schedule = (): void => {
      while (activeWorkers < targetConcurrency && hasPending() && shouldContinue()) {
        const directory = takeNext();
        if (!directory) {
          break;
        }
        activeWorkers += 1;
        const startedAt = performance.now();
        void scan(directory)
          .then((children) => {
            for (const child of children) {
              if (isPriority(child)) {
                priorityQueue.push(child);
              } else {
                normalQueue.push(child);
              }
            }
          })
          .finally(() => {
            const durationMs = performance.now() - startedAt;
            latencyEwma = latencyEwma === 0
              ? durationMs
              : latencyEwma * 0.8 + durationMs * 0.2;
            bestLatencyEwma = Math.min(bestLatencyEwma, latencyEwma);
            observedDirectories += 1;
            if (adaptiveConcurrency && observedDirectories % 8 === 0) {
              if (
                latencyEwma > bestLatencyEwma * 2.5 &&
                targetConcurrency > 2
              ) {
                targetConcurrency = Math.max(2, Math.floor(targetConcurrency * 0.75));
              } else if (hasPending()) {
                targetConcurrency = Math.min(maxConcurrency, targetConcurrency + 2);
              }
            }
            activeWorkers -= 1;
            if (activeWorkers === 0 && (!hasPending() || !shouldContinue())) {
              resolve();
            } else {
              schedule();
            }
          });
      }
      if (activeWorkers === 0 && (!hasPending() || !shouldContinue())) {
        resolve();
      }
    };
    schedule();
  });
}

export class PathIndex implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<boolean>();
  private searchCatalog = new PartitionedPathSearchCatalog();
  private rebuildPromise: Promise<void> | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly pendingChanges = new Map<string, PendingFileSystemChange>();
  private readonly persistence: PathIndexPersistence;
  private readonly expandedScopes = new Set<string>();
  private readonly scopeIndexPromises = new Map<string, Promise<void>>();
  private readonly workspaceMetadata = new Map<string, PathWorkspaceMetadata>();
  private readonly dirtyWorkspaceUris = new Set<string>();
  private cacheSaveTimer: NodeJS.Timeout | undefined;
  private generation = 0;
  private building = false;
  private limited = false;
  private partial = false;
  private ready = false;

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeBuilding = this.statusEmitter.event;

  constructor(
    storageUri?: vscode.Uri,
    private readonly priorityPathsProvider?: () => readonly PathEntry[],
  ) {
    this.persistence = new PathIndexPersistence(storageUri);
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
          this.updateTimer
        ) {
          clearTimeout(this.updateTimer);
          this.updateTimer = undefined;
          this.pendingChanges.clear();
        }
        if (
          event.affectsConfiguration('pathNavigator.excludeDirectoryNames') ||
          event.affectsConfiguration('pathNavigator.excludeFileExtensions') ||
          event.affectsConfiguration('pathNavigator.maxIndexEntries') ||
          event.affectsConfiguration('pathNavigator.indexConcurrency') ||
          event.affectsConfiguration('pathNavigator.adaptiveRemoteConcurrency') ||
          event.affectsConfiguration('pathNavigator.incrementalUpdateBatchLimit') ||
          event.affectsConfiguration('pathNavigator.initialIndexDepth')
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

  get isPartial(): boolean {
    return this.partial;
  }

  get entryCount(): number {
    return this.searchCatalog.size;
  }

  get currentSearchCatalog(): PathSearchIndex {
    return this.searchCatalog;
  }

  discardEntry(entry: PathEntry): void {
    if (this.searchCatalog.removePath(entry.workspaceUri, entry.relativePath, true) === 0) {
      return;
    }
    this.dirtyWorkspaceUris.add(entry.workspaceUri);
    this.changeEmitter.fire();
    this.scheduleCacheSave();
  }

  async initialize(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }
    const configuration = this.readConfiguration();
    let restored = false;
    if (configuration.persistIndex) {
      restored = await this.restorePersistentIndex(configuration);
    }
    if (!restored || configuration.refreshPersistentIndexInBackground) {
      await this.rebuild();
    }
  }

  async ensureReady(): Promise<void> {
    if (this.rebuildPromise) {
      await this.rebuildPromise;
    } else if (!this.ready) {
      await this.rebuild();
    }
  }

  ensureScopeIndexed(workspaceUri: string | undefined, scopePath: string): Promise<void> {
    const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
    if (!normalizedScope || !this.partial) {
      return Promise.resolve();
    }
    const key = `${workspaceUri ?? '*'}\0${normalizedScope}`;
    if (this.expandedScopes.has(key)) {
      return Promise.resolve();
    }
    const existing = this.scopeIndexPromises.get(key);
    if (existing) {
      return existing;
    }
    const promise = this.indexScope(workspaceUri, scopePath, key);
    this.scopeIndexPromises.set(key, promise);
    void promise.finally(() => this.scopeIndexPromises.delete(key));
    return promise;
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
      const configuration = this.readConfiguration();
      const { maxEntries } = configuration;
      const orderedFolders = folders
        .map((folder, originalIndex) => ({
          folder,
          originalIndex,
          estimatedSize:
            this.searchCatalog.workspaceCatalog(folder.uri.toString())?.size ??
            Number.POSITIVE_INFINITY,
        }))
        .sort((left, right) =>
          left.estimatedSize - right.estimatedSize || left.originalIndex - right.originalIndex,
        )
        .map(({ folder }) => folder);
      const snapshots: IndexSnapshot[] = [];
      const workspaceUris = new Set(folders.map((folder) => folder.uri.toString()));
      let totalAccepted = 0;
      let indexBudgetConstrained = false;
      const firstBuild = !this.ready || this.searchCatalog.size === 0;

      // Refresh one root at a time. The completed roots already serve new results,
      // unchanged roots keep serving their previous partitions, and peak memory is
      // bounded by the old index plus only the partition currently being rebuilt.
      for (let index = 0; index < orderedFolders.length; index += 1) {
        if (requestedGeneration !== this.generation) {
          return;
        }
        const folder = orderedFolders[index];
        const workspaceUri = folder.uri.toString();
        const remainingRootCount = orderedFolders.length - index;
        const workspaceLimit = maxEntries === 0
          ? Number.POSITIVE_INFINITY
          : Math.ceil(Math.max(0, maxEntries - totalAccepted) / remainingRootCount);
        const partition = new PathSearchCatalog();
        let accepted = 0;
        let partitionLimited = false;
        let published = 0;
        let lastPublishedAt = 0;

        if (firstBuild) {
          this.searchCatalog.replaceWorkspace(workspaceUri, partition);
        }
        const publishProgress = (): void => {
          if (!firstBuild || requestedGeneration !== this.generation) {
            return;
          }
          const now = Date.now();
          if (
            published > 0 &&
            accepted - published < PROGRESS_ENTRY_BATCH_SIZE &&
            now - lastPublishedAt < PROGRESS_INTERVAL_MS
          ) {
            return;
          }
          published = accepted;
          lastPublishedAt = now;
          this.searchCatalog.markWorkspaceChanged();
          this.changeEmitter.fire();
        };
        const snapshot = await this.scanWorkspaceFolder(
          folder,
          configuration.excludedNames,
          configuration.excludedFileExtensions,
          (entries) => {
            const remaining = Math.max(0, workspaceLimit - accepted);
            const acceptedEntries = remaining >= entries.length
              ? entries
              : entries.slice(0, remaining);
            accepted += partition.addEntries(acceptedEntries);
            publishProgress();
          },
          () => {
            if (requestedGeneration !== this.generation) {
              return false;
            }
            if (accepted >= workspaceLimit) {
              partitionLimited = true;
              return false;
            }
            return true;
          },
          configuration.indexConcurrency,
          configuration.initialIndexDepth,
          this.priorityDirectoriesForWorkspace(workspaceUri),
          configuration.adaptiveRemoteConcurrency,
        );
        if (requestedGeneration !== this.generation) {
          return;
        }
        partition.seal();
        if (maxEntries > 0 && partitionLimited) {
          indexBudgetConstrained = true;
        }
        totalAccepted += accepted;
        snapshots.push(snapshot);
        if (!firstBuild) {
          this.searchCatalog.replaceWorkspace(workspaceUri, partition);
        } else {
          this.searchCatalog.markWorkspaceChanged();
        }
        this.dirtyWorkspaceUris.add(workspaceUri);
        this.changeEmitter.fire();
      }

      for (const workspaceUri of this.searchCatalog.workspaceUris()) {
        if (!workspaceUris.has(workspaceUri)) {
          this.searchCatalog.removeWorkspace(workspaceUri);
          this.dirtyWorkspaceUris.delete(workspaceUri);
        }
      }

      this.limited = maxEntries > 0 && (totalAccepted >= maxEntries || indexBudgetConstrained);
      this.partial = snapshots.some((snapshot) => snapshot.partial);
      this.ready = true;
      this.expandedScopes.clear();
      this.scheduleCacheSave();

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
    initialDepth: number,
    priorityDirectories: ReadonlySet<string>,
    adaptiveRemoteConcurrency: boolean,
  ): Promise<IndexSnapshot> {
    const startedAt = performance.now();
    const errors: string[] = [];
    let partial = false;
    let pathCount = 0;
    const workspaceName = workspaceFolder.name;
    const workspaceUri = workspaceFolder.uri.toString();
    const sharedWorkspace = this.workspaceMetadataFor(workspaceFolder);
    await scanDirectoryWorkQueue(
      [{ uri: workspaceFolder.uri, relativePath: '', normalizedPath: '', depth: 0 }],
      concurrency,
      adaptiveRemoteConcurrency && workspaceFolder.uri.scheme === 'vscode-remote',
      shouldContinue,
      (directory) => priorityDirectories.has(directory.normalizedPath),
      async (directory) => {
          let children: [string, vscode.FileType][];
          try {
            children = await vscode.workspace.fs.readDirectory(directory.uri);
          } catch (error) {
            errors.push(`${directory.uri.toString()}: ${String(error)}`);
            return [];
          }

          if (!shouldContinue()) {
            return [];
          }

          const discoveredEntries: PathEntry[] = [];
          const childDirectories: PendingDirectory[] = [];
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
              discoveredEntries.push(createCompactPathEntry({
                kind: 'directory',
                name,
                relativePath,
                workspaceName,
                workspaceUri,
                normalizedPath,
              }, sharedWorkspace));
              const pathDepth = directory.depth + 1;
              if (!isSymbolicLink && (initialDepth === 0 || pathDepth < initialDepth)) {
                childDirectories.push({
                  uri,
                  relativePath,
                  normalizedPath,
                  depth: pathDepth,
                });
              } else if (!isSymbolicLink && initialDepth > 0) {
                partial = true;
              }
              continue;
            }

            if (hasExcludedFileExtension(normalizedName, excludedFileExtensions)) {
              continue;
            }
            discoveredEntries.push(createCompactPathEntry({
              kind: 'file',
              name,
              relativePath,
              workspaceName,
              workspaceUri,
              normalizedPath,
            }, sharedWorkspace));
          }

          if (discoveredEntries.length > 0) {
            pathCount += discoveredEntries.length;
            onEntries(discoveredEntries);
          }
          return childDirectories;
      },
    );

    return {
      errors,
      partial,
      durationMs: performance.now() - startedAt,
      pathCount,
    };
  }

  private priorityDirectoriesForWorkspace(workspaceUri: string): ReadonlySet<string> {
    const priorityDirectories = new Set<string>();
    for (const entry of this.priorityPathsProvider?.() ?? []) {
      if (entry.workspaceUri !== workspaceUri) {
        continue;
      }
      const segments = normalizeSearchText(entry.relativePath).split('/');
      const directoryLength = entry.kind === 'directory' ? segments.length : segments.length - 1;
      for (let length = 1; length <= directoryLength; length += 1) {
        priorityDirectories.add(segments.slice(0, length).join('/'));
      }
    }
    return priorityDirectories;
  }

  private cacheFingerprint(
    configuration: IndexConfiguration,
    workspaceFolder: vscode.WorkspaceFolder,
  ): string {
    return JSON.stringify({
      version: 5,
      workspace: [workspaceFolder.uri.toString(), workspaceFolder.name],
      excludedNames: [...configuration.excludedNames].sort(),
      excludedFileExtensions: [...configuration.excludedFileExtensions].sort(),
      maxEntries: configuration.maxEntries,
      initialIndexDepth: configuration.initialIndexDepth,
    });
  }

  private async restorePersistentIndex(configuration: IndexConfiguration): Promise<boolean> {
    const requestedGeneration = ++this.generation;
    this.setBuilding(true);
    try {
      const catalog = new PartitionedPathSearchCatalog();
      const folders = vscode.workspace.workspaceFolders ?? [];
      let restoredWorkspaceCount = 0;
      let restoredLimited = false;
      let restoredPartial = false;
      for (const folder of folders) {
        if (requestedGeneration !== this.generation) {
          return false;
        }
        const workspaceUri = folder.uri.toString();
        const workspaceMetadata = this.workspaceMetadataFor(folder);
        const partition = new PathSearchCatalog();
        let installed = false;
        const cached = await this.persistence.loadBatches(
          this.cacheFingerprint(configuration, folder),
          configuration.persistentIndexMaxAgeHours,
          async (header, cachedEntries) => {
            if (requestedGeneration !== this.generation) {
              return false;
            }
            const entries = cachedEntries.map((cachedEntry) =>
              createCompactPathEntry({
                kind: cachedEntry.kind,
                name: cachedEntry.relativePath.slice(
                  cachedEntry.relativePath.lastIndexOf('/') + 1,
                ),
                relativePath: cachedEntry.relativePath,
                workspaceName: folder.name,
                workspaceUri,
              }, workspaceMetadata),
            );
            partition.addEntries(entries);
            if (!installed) {
              catalog.replaceWorkspace(workspaceUri, partition);
              installed = true;
            } else {
              catalog.markWorkspaceChanged();
            }
            this.searchCatalog = catalog;
            restoredLimited ||= header.limited;
            restoredPartial ||= header.partial;
            this.limited = restoredLimited;
            this.partial = restoredPartial;
            this.changeEmitter.fire();
            await new Promise<void>((resolve) => setImmediate(resolve));
            return true;
          },
          workspaceUri,
        );
        if (!cached) {
          continue;
        }
        if (!installed) {
          catalog.replaceWorkspace(workspaceUri, partition);
        }
        partition.seal();
        restoredWorkspaceCount += 1;
        restoredLimited ||= cached.limited;
        restoredPartial ||= cached.partial;
      }
      if (restoredWorkspaceCount === 0 || requestedGeneration !== this.generation) {
        return false;
      }
      this.searchCatalog = catalog;
      this.limited = restoredLimited;
      this.partial = restoredPartial;
      this.ready = true;
      this.changeEmitter.fire();
      return restoredWorkspaceCount === folders.length;
    } finally {
      if (requestedGeneration === this.generation) {
        this.setBuilding(false);
      }
    }
  }

  private scheduleCacheSave(): void {
    const configuration = this.readConfiguration();
    if (!configuration.persistIndex) {
      return;
    }
    if (this.dirtyWorkspaceUris.size === 0) {
      return;
    }
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
    }
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = undefined;
      void this.savePersistentIndex().catch(() => undefined);
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  private async savePersistentIndex(): Promise<void> {
    const configuration = this.readConfiguration();
    if (!configuration.persistIndex) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const foldersByUri = new Map(folders.map((folder) => [folder.uri.toString(), folder]));
    const dirtyWorkspaceUris = [...this.dirtyWorkspaceUris];
    for (const workspaceUri of dirtyWorkspaceUris) {
      const folder = foldersByUri.get(workspaceUri);
      const partition = this.searchCatalog.workspaceCatalog(workspaceUri);
      if (!folder || !partition) {
        this.dirtyWorkspaceUris.delete(workspaceUri);
        continue;
      }
      const partitionRevision = partition.revision;
      const entries = (function* (): IterableIterator<{
        workspaceIndex: number;
        kind: PathEntry['kind'];
        relativePath: string;
      }> {
        for (const entry of partition.activeEntries()) {
          yield { workspaceIndex: 0, kind: entry.kind, relativePath: entry.relativePath };
        }
      })();
      await this.persistence.save({
        createdAt: Date.now(),
        fingerprint: this.cacheFingerprint(configuration, folder),
        limited: this.limited,
        partial: this.partial,
        workspaces: [{ uri: workspaceUri, name: folder.name }],
        entries,
      }, workspaceUri);
      if (
        this.searchCatalog.workspaceCatalog(workspaceUri) === partition &&
        partition.revision === partitionRevision
      ) {
        this.dirtyWorkspaceUris.delete(workspaceUri);
      }
    }
    if (this.dirtyWorkspaceUris.size > 0) {
      this.scheduleCacheSave();
    }
  }

  private async indexScope(
    workspaceUri: string | undefined,
    scopePath: string,
    key: string,
  ): Promise<void> {
    if (this.rebuildPromise) {
      await this.rebuildPromise;
    }
    const configuration = this.readConfiguration();
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => !workspaceUri || folder.uri.toString() === workspaceUri,
    );
    const operationGeneration = this.generation;
    let changed = false;
    this.setBuilding(true);
    try {
      for (const folder of folders) {
        const normalizedScope = scopePath
          .replace(/\\/g, '/')
          .replace(/^\/+|\/+$/g, '');
        const directoryUri = vscode.Uri.joinPath(folder.uri, ...normalizedScope.split('/'));
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(directoryUri);
        } catch {
          continue;
        }
        if ((stat.type & vscode.FileType.Directory) === 0) {
          continue;
        }
        if (!this.searchCatalog.getEntryByPath(folder.uri.toString(), normalizedScope)) {
          changed =
            this.addLiveEntries(
              [this.createEntry(folder, normalizedScope, 'directory')],
              configuration.maxEntries,
            ) > 0 || changed;
        }
        changed =
          (await this.scanDirectoryIntoLiveIndex(
            folder,
            {
              uri: directoryUri,
              relativePath: normalizedScope,
              normalizedPath: normalizeSearchText(normalizedScope),
              depth: normalizedScope ? normalizedScope.split('/').length : 0,
            },
            { ...configuration, initialIndexDepth: 0 },
          )) || changed;
      }
      if (operationGeneration !== this.generation) {
        return;
      }
      this.expandedScopes.add(key);
      if (changed) {
        this.searchCatalog.seal();
        this.changeEmitter.fire();
        this.scheduleCacheSave();
      }
    } finally {
      if (operationGeneration === this.generation) {
        this.setBuilding(false);
      }
    }
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
      watcher.onDidCreate(
        (uri) => this.scheduleIncrementalUpdate('create', uri, folder),
        this,
        this.disposables,
      );
      watcher.onDidDelete(
        (uri) => this.scheduleIncrementalUpdate('delete', uri, folder),
        this,
        this.disposables,
      );
      this.watchers.push(watcher);
    }
  }

  private readConfiguration(): IndexConfiguration {
    const configuration = vscode.workspace.getConfiguration('pathNavigator');
    const configuredMaxEntries = configuration.get<number>('maxIndexEntries', 500_000);
    const configuredConcurrency = configuration.get<number>(
      'indexConcurrency',
      DEFAULT_CONCURRENT_DIRECTORY_READS,
    );
    const configuredBatchLimit = configuration.get<number>(
      'incrementalUpdateBatchLimit',
      DEFAULT_INCREMENTAL_UPDATE_BATCH_LIMIT,
    );
    const configuredInitialDepth = configuration.get<number>('initialIndexDepth', 0);
    const configuredCacheAge = configuration.get<number>(
      'persistentIndexMaxAgeHours',
      168,
    );
    return {
      excludedNames: new Set(
        configuration
          .get<string[]>('excludeDirectoryNames', [])
          .map((name) => name.toLocaleLowerCase()),
      ),
      excludedFileExtensions: normalizeExcludedFileExtensions(
        configuration.get<string[]>('excludeFileExtensions', []),
      ),
      maxEntries: Number.isFinite(configuredMaxEntries)
        ? Math.max(0, Math.floor(configuredMaxEntries))
        : 500_000,
      indexConcurrency: Number.isFinite(configuredConcurrency)
        ? Math.min(32, Math.max(1, Math.floor(configuredConcurrency)))
        : DEFAULT_CONCURRENT_DIRECTORY_READS,
      adaptiveRemoteConcurrency: configuration.get<boolean>(
        'adaptiveRemoteConcurrency',
        true,
      ),
      incrementalUpdateBatchLimit: Number.isFinite(configuredBatchLimit)
        ? Math.max(1, Math.floor(configuredBatchLimit))
        : DEFAULT_INCREMENTAL_UPDATE_BATCH_LIMIT,
      initialIndexDepth: Number.isFinite(configuredInitialDepth)
        ? Math.min(20, Math.max(0, Math.floor(configuredInitialDepth)))
        : 0,
      persistIndex: configuration.get<boolean>('persistIndex', true),
      persistentIndexMaxAgeHours: Number.isFinite(configuredCacheAge)
        ? Math.max(0, configuredCacheAge)
        : 168,
      refreshPersistentIndexInBackground: configuration.get<boolean>(
        'refreshPersistentIndexInBackground',
        true,
      ),
    };
  }

  private async applyPendingChanges(): Promise<void> {
    if (this.pendingChanges.size === 0) {
      return;
    }
    if (this.building && !this.rebuildPromise) {
      if (!this.updateTimer) {
        this.updateTimer = setTimeout(() => {
          this.updateTimer = undefined;
          void this.applyPendingChanges();
        }, INCREMENTAL_UPDATE_DEBOUNCE_MS);
      }
      return;
    }
    if (this.rebuildPromise) {
      await this.rebuildPromise;
    }
    const changes = [...this.pendingChanges.values()];
    this.pendingChanges.clear();
    const configuration = this.readConfiguration();
    if (changes.length > configuration.incrementalUpdateBatchLimit) {
      await this.rebuild();
      return;
    }

    const operationGeneration = this.generation;
    let changed = false;
    this.setBuilding(true);
    try {
      for (const change of changes) {
        if (change.kind !== 'delete') {
          continue;
        }
        const relativePath = this.relativePathForUri(change.workspaceFolder, change.uri);
        if (
          relativePath &&
          this.searchCatalog.removePath(
            change.workspaceFolder.uri.toString(),
            relativePath,
            true,
          ) > 0
        ) {
          this.dirtyWorkspaceUris.add(change.workspaceFolder.uri.toString());
          changed = true;
        }
      }

      const creates = changes
        .filter((change) => change.kind === 'create')
        .sort((left, right) => left.uri.path.length - right.uri.path.length);
      for (const change of creates) {
        if (operationGeneration !== this.generation) {
          return;
        }
        changed =
          (await this.addCreatedPath(change.workspaceFolder, change.uri, configuration)) ||
          changed;
      }

      if (changed && operationGeneration === this.generation) {
        if (this.searchCatalog.tombstoneRatio >= CATALOG_COMPACTION_TOMBSTONE_RATIO) {
          this.compactCatalog();
        } else {
          this.searchCatalog.seal();
        }
        this.changeEmitter.fire();
        this.scheduleCacheSave();
      }
    } finally {
      if (operationGeneration === this.generation) {
        this.setBuilding(false);
      }
      if (this.pendingChanges.size > 0 && !this.updateTimer) {
        this.updateTimer = setTimeout(() => {
          this.updateTimer = undefined;
          void this.applyPendingChanges();
        }, INCREMENTAL_UPDATE_DEBOUNCE_MS);
      }
    }
  }

  private async addCreatedPath(
    workspaceFolder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
    configuration: IndexConfiguration,
  ): Promise<boolean> {
    const relativePath = this.relativePathForUri(workspaceFolder, uri);
    if (!relativePath) {
      return false;
    }

    let fileType: vscode.FileType;
    try {
      fileType = (await vscode.workspace.fs.stat(uri)).type;
    } catch {
      return false;
    }
    const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
    const isSymbolicLink = (fileType & vscode.FileType.SymbolicLink) !== 0;
    if (this.isExcludedPath(relativePath, isDirectory, configuration)) {
      return false;
    }

    // A delete/create pair can be coalesced into one create event. Removing the
    // previous path first also handles a file being replaced by a directory.
    const workspaceUri = workspaceFolder.uri.toString();
    const removed = this.searchCatalog.removePath(workspaceUri, relativePath, true);
    if (removed > 0) {
      this.dirtyWorkspaceUris.add(workspaceUri);
    }
    const rootEntry = this.createEntry(
      workspaceFolder,
      relativePath,
      isDirectory ? 'directory' : 'file',
    );
    let added = this.addLiveEntries([rootEntry], configuration.maxEntries) > 0;
    if (isDirectory && !isSymbolicLink && !this.limitReached(configuration.maxEntries)) {
      added =
        (await this.scanDirectoryIntoLiveIndex(
          workspaceFolder,
          {
            uri,
            relativePath,
            normalizedPath: normalizeSearchText(relativePath),
            depth: relativePath.split('/').length,
          },
          configuration,
        )) || added;
    }
    return removed > 0 || added;
  }

  private async scanDirectoryIntoLiveIndex(
    workspaceFolder: vscode.WorkspaceFolder,
    initialDirectory: PendingDirectory,
    configuration: IndexConfiguration,
  ): Promise<boolean> {
    let added = false;
    await scanDirectoryWorkQueue(
      [initialDirectory],
      configuration.indexConcurrency,
      configuration.adaptiveRemoteConcurrency &&
        workspaceFolder.uri.scheme === 'vscode-remote',
      () => !this.limitReached(configuration.maxEntries),
      () => false,
      async (directory) => {
          let children: [string, vscode.FileType][];
          try {
            children = await vscode.workspace.fs.readDirectory(directory.uri);
          } catch {
            return [];
          }
          const discoveredEntries: PathEntry[] = [];
          const childDirectories: PendingDirectory[] = [];
          for (const [name, fileType] of children) {
            const normalizedName = normalizeSearchText(name);
            const relativePath = `${directory.relativePath}/${name}`;
            const normalizedPath = `${directory.normalizedPath}/${normalizedName}`;
            const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
            const isSymbolicLink = (fileType & vscode.FileType.SymbolicLink) !== 0;
            if (isDirectory) {
              if (configuration.excludedNames.has(normalizedName)) {
                continue;
              }
              const childUri = vscode.Uri.joinPath(directory.uri, name);
              discoveredEntries.push(
                this.createEntry(workspaceFolder, relativePath, 'directory'),
              );
              if (!isSymbolicLink) {
                childDirectories.push({
                  uri: childUri,
                  relativePath,
                  normalizedPath,
                  depth: directory.depth + 1,
                });
              }
            } else if (
              !hasExcludedFileExtension(
                normalizedName,
                configuration.excludedFileExtensions,
              )
            ) {
              discoveredEntries.push(
                this.createEntry(workspaceFolder, relativePath, 'file'),
              );
            }
          }
          if (this.addLiveEntries(discoveredEntries, configuration.maxEntries) > 0) {
            added = true;
          }
          return childDirectories;
      },
    );
    return added;
  }

  private addLiveEntries(entries: readonly PathEntry[], maxEntries: number): number {
    const remaining = maxEntries === 0
      ? entries.length
      : Math.max(0, maxEntries - this.searchCatalog.size);
    if (remaining === 0) {
      this.limited = maxEntries > 0;
      return 0;
    }
    const uniqueEntries = entries.filter(
      (entry) => !this.searchCatalog.getEntryByPath(entry.workspaceUri, entry.relativePath),
    );
    const accepted =
      remaining >= uniqueEntries.length ? uniqueEntries : uniqueEntries.slice(0, remaining);
    const addedCount = this.searchCatalog.addEntries(accepted);
    if (addedCount > 0) {
      for (const entry of accepted) {
        this.dirtyWorkspaceUris.add(entry.workspaceUri);
      }
    }
    if (maxEntries > 0 && this.searchCatalog.size >= maxEntries) {
      this.limited = true;
    }
    return addedCount;
  }

  private limitReached(maxEntries: number): boolean {
    return maxEntries > 0 && this.searchCatalog.size >= maxEntries;
  }

  private compactCatalog(): void {
    for (const workspaceUri of this.searchCatalog.workspaceUris()) {
      const workspaceCatalog = this.searchCatalog.workspaceCatalog(workspaceUri);
      if (workspaceCatalog && workspaceCatalog.tombstoneRatio >= CATALOG_COMPACTION_TOMBSTONE_RATIO) {
        this.searchCatalog.compactWorkspace(workspaceUri);
      }
    }
  }

  private createEntry(
    workspaceFolder: vscode.WorkspaceFolder,
    relativePath: string,
    kind: PathEntry['kind'],
  ): PathEntry {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    const workspaceUri = workspaceFolder.uri.toString();
    return createCompactPathEntry({
      kind,
      name,
      relativePath,
      workspaceName: workspaceFolder.name,
      workspaceUri,
    }, this.workspaceMetadataFor(workspaceFolder));
  }

  private workspaceMetadataFor(
    workspaceFolder: vscode.WorkspaceFolder,
  ): PathWorkspaceMetadata {
    const workspaceUri = workspaceFolder.uri.toString();
    const existing = this.workspaceMetadata.get(workspaceUri);
    if (existing?.workspaceName === workspaceFolder.name) {
      return existing;
    }
    const metadata = createPathWorkspaceMetadata(workspaceFolder.name, workspaceUri);
    this.workspaceMetadata.set(workspaceUri, metadata);
    return metadata;
  }

  private relativePathForUri(
    workspaceFolder: vscode.WorkspaceFolder,
    uri: vscode.Uri,
  ): string | undefined {
    const rootPath = workspaceFolder.uri.path.replace(/\/$/, '');
    if (uri.scheme !== workspaceFolder.uri.scheme || !uri.path.startsWith(`${rootPath}/`)) {
      return undefined;
    }
    return uri.path.slice(rootPath.length + 1).replace(/\\/g, '/').replace(/\/$/, '');
  }

  private isExcludedPath(
    relativePath: string,
    isDirectory: boolean,
    configuration: IndexConfiguration,
  ): boolean {
    const segments = normalizeSearchText(relativePath).split('/');
    const directorySegments = isDirectory ? segments : segments.slice(0, -1);
    if (directorySegments.some((segment) => configuration.excludedNames.has(segment))) {
      return true;
    }
    return (
      !isDirectory &&
      hasExcludedFileExtension(
        segments.at(-1) ?? '',
        configuration.excludedFileExtensions,
      )
    );
  }

  private scheduleIncrementalUpdate(
    kind: PendingFileSystemChange['kind'],
    uri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
  ): void {
    const autoRefresh = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<boolean>('autoRefreshIndex', true);
    if (!autoRefresh) {
      return;
    }
    this.pendingChanges.set(uri.toString(), { kind, uri, workspaceFolder });
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.applyPendingChanges();
    }, INCREMENTAL_UPDATE_DEBOUNCE_MS);
  }

  private setBuilding(building: boolean): void {
    if (this.building !== building) {
      this.building = building;
      this.statusEmitter.fire(building);
    }
  }

  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
