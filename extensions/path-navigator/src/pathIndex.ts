import * as vscode from 'vscode';
import { PathEntry } from './pathEntry';
import { PathSearchCatalog } from './pathSearchCatalog';

interface IndexSnapshot {
  readonly errors: readonly string[];
}

interface PendingDirectory {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
}

const MAX_CONCURRENT_DIRECTORY_READS = 12;
const PROGRESS_ENTRY_BATCH_SIZE = 250;
const PROGRESS_INTERVAL_MS = 100;

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
        if (event.affectsConfiguration('pathNavigator.excludeDirectoryNames')) {
          void this.rebuild();
        }
      }),
    );
    this.resetWatchers();
  }

  get isBuilding(): boolean {
    return this.building;
  }

  get currentEntries(): readonly PathEntry[] {
    return this.entries;
  }

  get currentSearchCatalog(): PathSearchCatalog {
    return this.searchCatalog;
  }

  async ensureReady(): Promise<readonly PathEntry[]> {
    if (this.entries.length === 0) {
      await this.rebuild();
    } else if (this.rebuildPromise) {
      await this.rebuildPromise;
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
      const excludedNames = new Set(
        vscode.workspace
          .getConfiguration('pathNavigator')
          .get<string[]>('excludeDirectoryNames', [])
          .map((name) => name.toLocaleLowerCase()),
      );
      const collectedEntries: PathEntry[] = [];
      const buildingSearchCatalog = new PathSearchCatalog();
      let publishedEntryCount = 0;
      let lastPublishedAt = 0;

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

        this.entries = [...collectedEntries];
        this.searchCatalog = buildingSearchCatalog;
        publishedEntryCount = collectedEntries.length;
        lastPublishedAt = now;
        this.changeEmitter.fire();
      };

      const snapshots = await Promise.all(
        folders.map((folder) =>
          this.scanWorkspaceFolder(
            folder,
            excludedNames,
            (entries) => {
              collectedEntries.push(...entries);
              buildingSearchCatalog.addEntries(entries);
              publishProgress();
            },
            () => requestedGeneration === this.generation,
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
    onEntries: (entries: readonly PathEntry[]) => void,
    shouldContinue: () => boolean,
  ): Promise<IndexSnapshot> {
    const errors: string[] = [];
    let directories: PendingDirectory[] = [
      { uri: workspaceFolder.uri, relativePath: '' },
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
            const relativePath = directory.relativePath
              ? `${directory.relativePath}/${name}`
              : name;
            const uri = vscode.Uri.joinPath(directory.uri, name);
            const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
            const isSymbolicLink = (fileType & vscode.FileType.SymbolicLink) !== 0;

            if (isDirectory) {
              if (excludedNames.has(name.toLocaleLowerCase())) {
                continue;
              }
              discoveredEntries.push({
                uri,
                kind: 'directory',
                name,
                relativePath,
                workspaceName: workspaceFolder.name,
                workspaceUri: workspaceFolder.uri.toString(),
              });
              if (!isSymbolicLink) {
                nextLevel.push({ uri, relativePath });
              }
              continue;
            }

            discoveredEntries.push({
              uri,
              kind: 'file',
              name,
              relativePath,
              workspaceName: workspaceFolder.name,
              workspaceUri: workspaceFolder.uri.toString(),
            });
          }

          if (discoveredEntries.length > 0) {
            onEntries(discoveredEntries);
          }
        }
      };

      const workerCount = Math.min(MAX_CONCURRENT_DIRECTORY_READS, currentLevel.length);
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
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      void this.rebuild();
    }, 350);
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
