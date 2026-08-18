import * as vscode from 'vscode';
import {
  scanWithExternalBackend,
  type IndexingBackend,
  type ScannedExternalPath,
} from './externalPathScanner';
import { createPathEntry, PathEntry } from './pathEntry';
import {
  hasExcludedFileExtension,
  normalizeExcludedFileExtensions,
} from './pathFilters';
import { PathSearchCatalog } from './pathSearchCatalog';
import { PathIndexPersistence } from './pathIndexPersistence';
import { normalizeSearchText } from './search';

interface IndexSnapshot {
  readonly errors: readonly string[];
  readonly partial: boolean;
}

interface PendingDirectory {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly normalizedPath: string;
}

interface IndexConfiguration {
  readonly excludedNames: ReadonlySet<string>;
  readonly excludedFileExtensions: ReadonlySet<string>;
  readonly maxEntries: number;
  readonly indexConcurrency: number;
  readonly incrementalUpdateBatchLimit: number;
  readonly indexingBackend: IndexingBackend;
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
const CACHE_RESTORE_BATCH_SIZE = 5_000;

export class PathIndex implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<boolean>();
  private searchCatalog = new PathSearchCatalog();
  private rebuildPromise: Promise<void> | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  private readonly pendingChanges = new Map<string, PendingFileSystemChange>();
  private readonly persistence: PathIndexPersistence;
  private readonly expandedScopes = new Set<string>();
  private readonly scopeIndexPromises = new Map<string, Promise<void>>();
  private readonly normalizedWorkspaceNames = new Map<string, string>();
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
          event.affectsConfiguration('pathNavigator.incrementalUpdateBatchLimit') ||
          event.affectsConfiguration('pathNavigator.indexingBackend') ||
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

  get currentSearchCatalog(): PathSearchCatalog {
    return this.searchCatalog;
  }

  discardEntry(entry: PathEntry): void {
    if (this.searchCatalog.removePath(entry.workspaceUri, entry.relativePath, true) === 0) {
      return;
    }
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
      const publishIncompleteCatalog = !this.ready || this.searchCatalog.size === 0;
      const buildingSearchCatalog = new PathSearchCatalog();
      let acceptedEntryCount = 0;
      let publishedEntryCount = 0;
      let lastPublishedAt = 0;
      let limitReached = false;

      const publishProgress = (force = false): void => {
        if (requestedGeneration !== this.generation) {
          return;
        }

        // A restored or previously completed catalog remains a consistent search
        // snapshot while its replacement is built. First-time indexes still stream
        // partial results so a new workspace becomes usable immediately.
        if (!force && !publishIncompleteCatalog) {
          return;
        }

        const now = Date.now();
        const addedEntryCount = acceptedEntryCount - publishedEntryCount;
        if (
          !force &&
          publishedEntryCount > 0 &&
          addedEntryCount < PROGRESS_ENTRY_BATCH_SIZE &&
          now - lastPublishedAt < PROGRESS_INTERVAL_MS
        ) {
          return;
        }

        this.searchCatalog = buildingSearchCatalog;
        this.limited = limitReached;
        publishedEntryCount = acceptedEntryCount;
        lastPublishedAt = now;
        this.changeEmitter.fire();
      };

      const acceptEntries = (entries: readonly PathEntry[]): void => {
        const uniqueEntries = entries.filter(
          (entry) =>
            !buildingSearchCatalog.getEntryByPath(entry.workspaceUri, entry.relativePath),
        );
        const remaining = maxEntries === 0
          ? uniqueEntries.length
          : Math.max(0, maxEntries - acceptedEntryCount);
        const acceptedEntries =
          remaining >= uniqueEntries.length
            ? uniqueEntries
            : uniqueEntries.slice(0, remaining);
        if (acceptedEntries.length > 0) {
          acceptedEntryCount += buildingSearchCatalog.addEntries(acceptedEntries);
        }
        if (maxEntries > 0 && acceptedEntryCount >= maxEntries) {
          limitReached = true;
        }
        publishProgress();
      };
      const snapshots = await Promise.all(
        folders.map((folder) =>
          this.scanWorkspaceFolderWithConfiguredBackend(
            folder,
            configuration,
            acceptEntries,
            () => requestedGeneration === this.generation && !limitReached,
          ),
        ),
      );

      if (requestedGeneration !== this.generation) {
        return;
      }

      buildingSearchCatalog.seal();
      this.partial = snapshots.some((snapshot) => snapshot.partial);
      this.ready = true;
      this.expandedScopes.clear();
      publishProgress(true);
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
  ): Promise<IndexSnapshot> {
    const errors: string[] = [];
    let partial = false;
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
                kind: 'directory',
                name,
                relativePath,
                workspaceName,
                workspaceUri,
                normalizedName,
                normalizedPath,
                normalizedWorkspaceName,
              }));
              const pathDepth = relativePath.split('/').length;
              if (!isSymbolicLink && (initialDepth === 0 || pathDepth < initialDepth)) {
                nextLevel.push({ uri, relativePath, normalizedPath });
              } else if (!isSymbolicLink && initialDepth > 0) {
                partial = true;
              }
              continue;
            }

            if (hasExcludedFileExtension(normalizedName, excludedFileExtensions)) {
              continue;
            }
            discoveredEntries.push(createPathEntry({
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
      const prioritized: PendingDirectory[] = [];
      const remaining: PendingDirectory[] = [];
      for (const directory of nextLevel) {
        (priorityDirectories.has(directory.normalizedPath) ? prioritized : remaining).push(
          directory,
        );
      }
      directories = [...prioritized, ...remaining];
    }

    return { errors, partial };
  }

  private async scanWorkspaceFolderWithConfiguredBackend(
    workspaceFolder: vscode.WorkspaceFolder,
    configuration: IndexConfiguration,
    onEntries: (entries: readonly PathEntry[]) => void,
    shouldContinue: () => boolean,
  ): Promise<IndexSnapshot> {
    if (configuration.indexingBackend !== 'workspaceFs' && configuration.initialIndexDepth === 0) {
      const externalResult = await scanWithExternalBackend({
        backend: configuration.indexingBackend,
        workspaceFolder,
        excludedNames: configuration.excludedNames,
        excludedFileExtensions: configuration.excludedFileExtensions,
        initialDepth: configuration.initialIndexDepth,
        shouldContinue,
        onPaths: (paths) => onEntries(this.createEntriesFromExternalPaths(workspaceFolder, paths)),
      });
      if (externalResult.handled) {
        return { errors: [], partial: false };
      }
    }

    return this.scanWorkspaceFolder(
      workspaceFolder,
      configuration.excludedNames,
      configuration.excludedFileExtensions,
      onEntries,
      shouldContinue,
      configuration.indexConcurrency,
      configuration.initialIndexDepth,
      this.priorityDirectoriesForWorkspace(workspaceFolder.uri.toString()),
    );
  }

  private createEntriesFromExternalPaths(
    workspaceFolder: vscode.WorkspaceFolder,
    paths: readonly ScannedExternalPath[],
  ): PathEntry[] {
    return paths.map(({ relativePath, kind }) =>
      this.createEntry(workspaceFolder, relativePath, kind),
    );
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

  private cacheFingerprint(configuration: IndexConfiguration): string {
    return JSON.stringify({
      version: 3,
      workspaces: (vscode.workspace.workspaceFolders ?? []).map((folder) => [
        folder.uri.toString(),
        folder.name,
      ]),
      excludedNames: [...configuration.excludedNames].sort(),
      excludedFileExtensions: [...configuration.excludedFileExtensions].sort(),
      maxEntries: configuration.maxEntries,
      indexingBackend: configuration.indexingBackend,
      initialIndexDepth: configuration.initialIndexDepth,
    });
  }

  private async restorePersistentIndex(configuration: IndexConfiguration): Promise<boolean> {
    const cached = await this.persistence.load(
      this.cacheFingerprint(configuration),
      configuration.persistentIndexMaxAgeHours,
    );
    if (!cached) {
      return false;
    }

    const requestedGeneration = ++this.generation;
    this.setBuilding(true);
    try {
      const catalog = new PathSearchCatalog();
      const normalizedWorkspaceNames = cached.workspaces.map((workspace) =>
        normalizeSearchText(workspace.name),
      );
      for (let offset = 0; offset < cached.entries.length; offset += CACHE_RESTORE_BATCH_SIZE) {
        if (requestedGeneration !== this.generation) {
          return false;
        }
        const batch = cached.entries
          .slice(offset, offset + CACHE_RESTORE_BATCH_SIZE)
          .map((cachedEntry) => {
            const workspace = cached.workspaces[cachedEntry.workspaceIndex];
            return createPathEntry({
              kind: cachedEntry.kind,
              name: cachedEntry.relativePath.slice(
                cachedEntry.relativePath.lastIndexOf('/') + 1,
              ),
              relativePath: cachedEntry.relativePath,
              workspaceName: workspace.name,
              workspaceUri: workspace.uri,
              normalizedWorkspaceName:
                normalizedWorkspaceNames[cachedEntry.workspaceIndex],
            });
          });
        catalog.addEntries(batch);
        this.searchCatalog = catalog;
        this.limited = cached.limited;
        this.partial = cached.partial;
        this.changeEmitter.fire();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      catalog.seal();
      this.searchCatalog = catalog;
      this.limited = cached.limited;
      this.partial = cached.partial;
      this.ready = true;
      this.changeEmitter.fire();
      return true;
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
    const workspaceIndexByUri = new Map(
      folders.map((folder, index) => [folder.uri.toString(), index]),
    );
    const catalog = this.searchCatalog;
    const catalogRevision = catalog.revision;
    const activeEntries = catalog.activeEntriesSnapshot();
    const entries: Array<{
      workspaceIndex: number;
      kind: PathEntry['kind'];
      relativePath: string;
    }> = [];
    for (let index = 0; index < activeEntries.length; index += 1) {
      const entry = activeEntries[index];
      const workspaceIndex = workspaceIndexByUri.get(entry.workspaceUri);
      if (workspaceIndex !== undefined) {
        entries.push({ workspaceIndex, kind: entry.kind, relativePath: entry.relativePath });
      }
      if (index > 0 && index % CACHE_RESTORE_BATCH_SIZE === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (this.searchCatalog !== catalog || catalog.revision !== catalogRevision) {
      this.scheduleCacheSave();
      return;
    }
    await this.persistence.save({
      createdAt: Date.now(),
      fingerprint: this.cacheFingerprint(configuration),
      limited: this.limited,
      partial: this.partial,
      workspaces: folders.map((folder) => ({
        uri: folder.uri.toString(),
        name: folder.name,
      })),
      entries,
    });
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
      incrementalUpdateBatchLimit: Number.isFinite(configuredBatchLimit)
        ? Math.max(1, Math.floor(configuredBatchLimit))
        : DEFAULT_INCREMENTAL_UPDATE_BATCH_LIMIT,
      indexingBackend: configuration.get<IndexingBackend>(
        'indexingBackend',
        'workspaceFs',
      ),
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
    let directories = [initialDirectory];
    let added = false;
    while (directories.length > 0 && !this.limitReached(configuration.maxEntries)) {
      const currentLevel = directories;
      const nextLevel: PendingDirectory[] = [];
      let nextDirectoryIndex = 0;
      const scanNextDirectory = async (): Promise<void> => {
        while (!this.limitReached(configuration.maxEntries)) {
          const directory = currentLevel[nextDirectoryIndex];
          nextDirectoryIndex += 1;
          if (!directory) {
            return;
          }
          let children: [string, vscode.FileType][];
          try {
            children = await vscode.workspace.fs.readDirectory(directory.uri);
          } catch {
            continue;
          }
          const discoveredEntries: PathEntry[] = [];
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
                nextLevel.push({ uri: childUri, relativePath, normalizedPath });
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
        }
      };
      const workerCount = Math.min(configuration.indexConcurrency, currentLevel.length);
      await Promise.all(Array.from({ length: workerCount }, () => scanNextDirectory()));
      directories = nextLevel;
    }
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
    if (maxEntries > 0 && this.searchCatalog.size >= maxEntries) {
      this.limited = true;
    }
    return addedCount;
  }

  private limitReached(maxEntries: number): boolean {
    return maxEntries > 0 && this.searchCatalog.size >= maxEntries;
  }

  private compactCatalog(): void {
    const activeEntries = this.searchCatalog.activeEntriesSnapshot();
    const compactedCatalog = new PathSearchCatalog();
    compactedCatalog.addEntries(activeEntries);
    compactedCatalog.seal();
    this.searchCatalog = compactedCatalog;
  }

  private createEntry(
    workspaceFolder: vscode.WorkspaceFolder,
    relativePath: string,
    kind: PathEntry['kind'],
  ): PathEntry {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    const workspaceUri = workspaceFolder.uri.toString();
    let normalizedWorkspaceName = this.normalizedWorkspaceNames.get(workspaceUri);
    if (!normalizedWorkspaceName) {
      normalizedWorkspaceName = normalizeSearchText(workspaceFolder.name);
      this.normalizedWorkspaceNames.set(workspaceUri, normalizedWorkspaceName);
    }
    return createPathEntry({
      kind,
      name,
      relativePath,
      workspaceName: workspaceFolder.name,
      workspaceUri,
      normalizedWorkspaceName,
    });
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
