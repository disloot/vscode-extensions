import * as vscode from 'vscode';
import { createPathEntry, type PathEntry } from './pathEntry';
import type { PathUsage } from './pathSearchEngine';
import { pathIdentity } from './resultSelection';
import { normalizeSearchQuery } from './search';

interface StoredRecentPath {
  readonly uri: string;
  readonly kind: 'file' | 'directory';
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly lastOpenedAt: number;
  readonly openCount: number;
  readonly pinned?: boolean;
}

interface StoredQuerySelection {
  readonly query: string;
  readonly identity: string;
  readonly lastSelectedAt: number;
  readonly selectionCount: number;
}

const STORAGE_KEY = 'pathNavigator.recentPaths.v1';
const QUERY_STORAGE_KEY = 'pathNavigator.querySelections.v1';
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
    typeof candidate.openCount === 'number' &&
    (candidate.pinned === undefined || typeof candidate.pinned === 'boolean')
  );
}

function isStoredQuerySelection(value: unknown): value is StoredQuerySelection {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StoredQuerySelection>;
  return (
    typeof candidate.query === 'string' &&
    typeof candidate.identity === 'string' &&
    typeof candidate.lastSelectedAt === 'number' &&
    typeof candidate.selectionCount === 'number'
  );
}

export class RecentPathStore implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly paths = new Map<string, StoredRecentPath>();
  private readonly querySelections = new Map<string, StoredQuerySelection>();
  private cachedLimit = -1;
  private cachedUsages: readonly PathUsage[] | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private usageRevision = 0;

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
    const storedQuerySelections = workspaceState.get<unknown[]>(QUERY_STORAGE_KEY, []);
    for (const selection of storedQuerySelections) {
      if (!isStoredQuerySelection(selection)) {
        continue;
      }
      this.querySelections.set(this.querySelectionKey(selection.query, selection.identity), selection);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pathNavigator.recentPathsLimit')) {
          this.invalidateUsageCache();
        }
        if (event.affectsConfiguration('pathNavigator.queryHistoryLimit')) {
          this.pruneQuerySelections();
          this.invalidateUsageCache();
          this.schedulePersist();
        }
      }),
    );
  }

  get revision(): number {
    return this.usageRevision;
  }

  getUsages(query = ''): readonly PathUsage[] {
    const limit = this.configuredLimit();
    if (limit === 0) {
      return [];
    }
    if (!this.cachedUsages || this.cachedLimit !== limit) {
      this.cachedLimit = limit;
      this.cachedUsages = [...this.paths.values()]
        .sort((left, right) =>
          Number(right.pinned === true) - Number(left.pinned === true) ||
          right.lastOpenedAt - left.lastOpenedAt,
        )
        .slice(0, limit)
        .map((storedPath) => ({
          entry: createPathEntry({
            uri: vscode.Uri.parse(storedPath.uri),
            kind: storedPath.kind,
            name: storedPath.name,
            relativePath: storedPath.relativePath,
            workspaceName: storedPath.workspaceName,
            workspaceUri: storedPath.workspaceUri,
          }),
          lastOpenedAt: storedPath.lastOpenedAt,
          openCount: storedPath.openCount,
          pinned: storedPath.pinned === true,
        }));
    }

    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 2 || this.querySelections.size === 0) {
      return this.cachedUsages;
    }
    const affinityByIdentity = new Map<string, number>();
    for (const selection of this.querySelections.values()) {
      if (selection.query === normalizedQuery) {
        affinityByIdentity.set(selection.identity, selection.selectionCount);
      }
    }
    if (affinityByIdentity.size === 0) {
      return this.cachedUsages;
    }
    return this.cachedUsages.map((usage) => ({
      ...usage,
      queryAffinity: affinityByIdentity.get(pathIdentity(usage.entry)),
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
      uri: (
        entry.uri ??
        vscode.Uri.joinPath(vscode.Uri.parse(entry.workspaceUri), ...entry.relativePath.split('/'))
      ).toString(),
      kind: entry.kind,
      name: entry.name,
      relativePath: entry.relativePath,
      workspaceName: entry.workspaceName,
      workspaceUri: entry.workspaceUri,
      lastOpenedAt: openedAt,
      openCount: (previous?.openCount ?? 0) + (isDuplicateOpenEvent ? 0 : 1),
      pinned: previous?.pinned,
    });
    this.invalidateUsageCache();
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
    this.record(createPathEntry({
      uri,
      kind: 'file',
      name,
      relativePath,
      workspaceName: workspaceFolder.name,
      workspaceUri: workspaceFolder.uri.toString(),
    }));
  }

  recordQuerySelection(query: string, entry: PathEntry): void {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 2 || this.configuredQueryHistoryLimit() === 0) {
      return;
    }
    const identity = pathIdentity(entry);
    const key = this.querySelectionKey(normalizedQuery, identity);
    const previous = this.querySelections.get(key);
    this.querySelections.set(key, {
      query: normalizedQuery,
      identity,
      lastSelectedAt: Date.now(),
      selectionCount: (previous?.selectionCount ?? 0) + 1,
    });
    this.pruneQuerySelections();
    this.usageRevision += 1;
    this.schedulePersist();
  }

  isPinned(entry: PathEntry): boolean {
    return this.paths.get(pathIdentity(entry))?.pinned === true;
  }

  togglePinned(entry: PathEntry): boolean {
    const identity = pathIdentity(entry);
    const previous = this.paths.get(identity);
    const pinned = previous?.pinned !== true;
    const uri = (
      entry.uri ??
      vscode.Uri.joinPath(vscode.Uri.parse(entry.workspaceUri), ...entry.relativePath.split('/'))
    ).toString();
    this.paths.set(identity, {
      uri,
      kind: entry.kind,
      name: entry.name,
      relativePath: entry.relativePath,
      workspaceName: entry.workspaceName,
      workspaceUri: entry.workspaceUri,
      lastOpenedAt: previous?.lastOpenedAt ?? 0,
      openCount: previous?.openCount ?? 0,
      pinned,
    });
    this.invalidateUsageCache();
    this.prune();
    this.schedulePersist();
    return pinned;
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    void this.persist().catch(() => undefined);
  }

  private configuredLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<number>('recentPathsLimit', 200);
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 200;
  }

  private configuredQueryHistoryLimit(): number {
    const configured = vscode.workspace
      .getConfiguration('pathNavigator')
      .get<number>('queryHistoryLimit', 500);
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 500;
  }

  private prune(): void {
    const limit = this.configuredLimit();
    if (this.paths.size <= limit) {
      return;
    }
    const retained = [...this.paths.entries()]
      .sort((left, right) =>
        Number(right[1].pinned === true) - Number(left[1].pinned === true) ||
        right[1].lastOpenedAt - left[1].lastOpenedAt,
      )
      .slice(0, limit);
    this.paths.clear();
    for (const [identity, storedPath] of retained) {
      this.paths.set(identity, storedPath);
    }
  }

  private pruneQuerySelections(): void {
    const limit = this.configuredQueryHistoryLimit();
    if (this.querySelections.size <= limit) {
      return;
    }
    const retained = [...this.querySelections.values()]
      .sort((left, right) => right.lastSelectedAt - left.lastSelectedAt)
      .slice(0, limit);
    this.querySelections.clear();
    for (const selection of retained) {
      this.querySelections.set(
        this.querySelectionKey(selection.query, selection.identity),
        selection,
      );
    }
  }

  private querySelectionKey(query: string, identity: string): string {
    return `${query}\0${identity}`;
  }

  private invalidateUsageCache(): void {
    this.cachedUsages = undefined;
    this.cachedLimit = -1;
    this.usageRevision += 1;
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
    const storedQuerySelections = [...this.querySelections.values()].sort(
      (left, right) => right.lastSelectedAt - left.lastSelectedAt,
    );
    await Promise.all([
      this.workspaceState.update(STORAGE_KEY, storedPaths),
      this.workspaceState.update(QUERY_STORAGE_KEY, storedQuerySelections),
    ]);
  }
}
