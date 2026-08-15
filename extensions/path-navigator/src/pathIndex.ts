import * as vscode from 'vscode';
import { PathEntry } from './pathEntry';

interface IndexSnapshot {
  readonly entries: readonly PathEntry[];
  readonly errors: readonly string[];
}

export class PathIndex implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<boolean>();
  private entries: readonly PathEntry[] = [];
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
    const folders = vscode.workspace.workspaceFolders ?? [];
    const excludedNames = new Set(
      vscode.workspace
        .getConfiguration('pathNavigator')
        .get<string[]>('excludeDirectoryNames', [])
        .map((name) => name.toLocaleLowerCase()),
    );

    const snapshots = await Promise.all(
      folders.map((folder) => this.scanWorkspaceFolder(folder, excludedNames)),
    );

    if (requestedGeneration !== this.generation) {
      return;
    }

    this.entries = snapshots.flatMap((snapshot) => snapshot.entries);
    this.changeEmitter.fire();
    this.setBuilding(false);

    const errors = snapshots.flatMap((snapshot) => snapshot.errors);
    if (errors.length > 0) {
      const suffix = errors.length === 1 ? errors[0] : `${errors.length} directories could not be read.`;
      void vscode.window.showWarningMessage(`Path Navigator index is incomplete: ${suffix}`);
    }
  }

  private async scanWorkspaceFolder(
    workspaceFolder: vscode.WorkspaceFolder,
    excludedNames: ReadonlySet<string>,
  ): Promise<IndexSnapshot> {
    const entries: PathEntry[] = [];
    const errors: string[] = [];
    const queue: Array<{ uri: vscode.Uri; relativePath: string }> = [
      { uri: workspaceFolder.uri, relativePath: '' },
    ];

    for (let index = 0; index < queue.length; index += 1) {
      const directory = queue[index];
      let children: [string, vscode.FileType][];

      try {
        children = await vscode.workspace.fs.readDirectory(directory.uri);
      } catch (error) {
        errors.push(`${directory.uri.toString()}: ${String(error)}`);
        continue;
      }

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
          entries.push({
            uri,
            kind: 'directory',
            name,
            relativePath,
            workspaceName: workspaceFolder.name,
            workspaceUri: workspaceFolder.uri.toString(),
          });
          if (!isSymbolicLink) {
            queue.push({ uri, relativePath });
          }
          continue;
        }

        entries.push({
          uri,
          kind: 'file',
          name,
          relativePath,
          workspaceName: workspaceFolder.name,
          workspaceUri: workspaceFolder.uri.toString(),
        });
      }
    }

    return { entries, errors };
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
