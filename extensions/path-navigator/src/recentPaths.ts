import * as vscode from 'vscode';
import type { PathEntry } from './pathEntry';
import type { PathUsage } from './pathSearchEngine';
import { pathIdentity } from './resultSelection';

interface StoredRecentPath {
  readonly uri: string;
  readonly kind: 'file' | 'directory';
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly lastOpenedAt: number;
  readonly openCount: number;
}

const STORAGE_KEY = 'pathNavigator.recentPaths.v1';
const PERSIST_DELAY_MS = 500;
const OPEN_EVENT_DEDUPLICATION_MS = 1_000;

function isStoredRecentPath(value: unknown): value is StoredRecentPath {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StoredRecentPath>;
  return (
    typeof candidate.uri === 'string' &&
    (candidate.kind === 'file' || candidate.kind === 'directory') &&
    typeof candidate.name === 'string' &&
    typeof candidate.relativePath === 'string' &&
    typeof candidate.workspaceName === 'string' &&
    typeof candidate.workspaceUri === 'string' &&
    typeof candidate.lastOpenedAt === 'number' &&
    typeof candidate.openCount === 'number'
  );
}

export class RecentPathStore implements vscode.Disposable {
  private readonly paths = new Map<string, StoredRecentPath>();
  private persistTimer: NodeJS.Timeout | undefined;

  constructor(private readonly workspaceState: vscode.Memento) {
    const storedPaths = workspaceState.get<unknown[]>(STORAGE_KEY, []);
    for (const storedPath of storedPaths) {
      if (!isStoredRecentPath(storedPath)) {
        continue;
      }
      this.paths.set(
        pathIdentity({
          kind: storedPath.kind,
          relativePath: storedPath.relativePath,
          workspaceUri: storedPath.workspaceUri,
        }),
        storedPath,
      );
    }
  }

  getUsages(): PathUsage[] {
    const limit = this.configuredLimit();
    if (limit === 0) {
      return [];
    }
    return [...this.paths.values()]
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
      .slice(0, limit)
      .map((storedPath) => ({
        entry: {
          uri: vscode.Uri.parse(storedPath.uri),
          kind: storedPath.kind,
          name: storedPath.name,
          relativePath: storedPath.relativePath,
          workspaceName: storedPath.workspaceName,
          workspaceUri: storedPath.workspaceUri,
        },
        lastOpenedAt: storedPath.lastOpenedAt,
        openCount: storedPath.openCount,
      }));
  }

  record(entry: PathEntry): void {
    if (this.configuredLimit() === 0) {
      return;
    }
    const identity = pathIdentity(entry);
    const previous = this.paths.get(identity);
    const openedAt = Date.now();
    const isDuplicateOpenEvent =
      previous !== undefined &&
      openedAt - previous.lastOpenedAt < OPEN_EVENT_DEDUPLICATION_MS;
    this.paths.set(identity, {
      uri: entry.uri.toString(),
      kind: entry.kind,
      name: entry.name,
      relativePath: entry.relativePath,
      workspaceName: entry.workspaceName,
      workspaceUri: entry.workspaceUri,
      lastOpenedAt: openedAt,
      openCount: (previous?.openCount ?? 0) + (isDuplicateOpenEvent ? 0 : 1),
    });
    this.prune();
    this.schedulePersist();
  }

  recordUri(uri: vscode.Uri): void {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return;
    }
    const relativePath = vscode.workspace
      .asRelativePath(uri, false)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    const name = relativePath.split('/').at(-1);
    if (!name || !relativePath) {
      return;
    }
    this.record({
      uri,
      kind: 'file',
      name,
      relativePath,
      workspaceName: workspaceFolder.name,
      workspaceUri: workspaceFolder.uri.toString(),
    });
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    void this.persist().catch(() => undefined);
  }

  private configuredLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<number>('recentPathsLimit', 200);
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 200;
  }

  private prune(): void {
    const limit = this.configuredLimit();
    if (this.paths.size <= limit) {
      return;
    }
    const retained = [...this.paths.entries()]
      .sort((left, right) => right[1].lastOpenedAt - left[1].lastOpenedAt)
      .slice(0, limit);
    this.paths.clear();
    for (const [identity, storedPath] of retained) {
      this.paths.set(identity, storedPath);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch(() => undefined);
    }, PERSIST_DELAY_MS);
  }

  private async persist(): Promise<void> {
    const storedPaths = [...this.paths.values()].sort(
      (left, right) => right.lastOpenedAt - left.lastOpenedAt,
    );
    await this.workspaceState.update(STORAGE_KEY, storedPaths);
  }
}
