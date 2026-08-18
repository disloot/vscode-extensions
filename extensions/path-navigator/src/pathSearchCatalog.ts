import type { PathEntry } from './pathEntry';
import { pathIdentity } from './resultSelection';
import { normalizeSearchQuery, normalizeSearchText } from './search';

function bucketKey(workspaceUri: string, token: string): string {
  return `${workspaceUri}\0${token}`;
}

function uniqueNgrams(value: string, size: number): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size));
  }
  return grams;
}

export class PathSearchCatalog {
  private static nextInstanceId = 1;
  private readonly byIdentity = new Map<string, PathEntry>();
  private readonly workspaceUris = new Set<string>();
  private readonly entriesByWorkspace = new Map<string, PathEntry[]>();
  private readonly childrenByParent = new Map<string, PathEntry[]>();
  private readonly entriesByExactName = new Map<string, PathEntry[]>();
  private readonly entriesByNamePrefix = new Map<string, PathEntry[]>();
  private readonly entriesByBigram = new Map<string, PathEntry[]>();
  readonly instanceId = PathSearchCatalog.nextInstanceId++;
  private catalogRevision = 0;

  get size(): number {
    return this.byIdentity.size;
  }

  get revision(): number {
    return this.catalogRevision;
  }

  addEntries(entries: readonly PathEntry[]): void {
    let addedEntries = false;
    for (const entry of entries) {
      const identity = pathIdentity(entry);
      if (this.byIdentity.has(identity)) {
        continue;
      }

      addedEntries = true;
      const normalizedName = entry.normalizedName ?? normalizeSearchText(entry.name);
      const normalizedPath = entry.normalizedPath ?? normalizeSearchText(entry.relativePath);
      const separatorIndex = normalizedPath.lastIndexOf('/');
      const normalizedParentPath =
        separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex);

      this.byIdentity.set(identity, entry);
      this.workspaceUris.add(entry.workspaceUri);
      this.pushToBucket(this.entriesByWorkspace, entry.workspaceUri, entry);
      this.pushToBucket(
        this.childrenByParent,
        bucketKey(entry.workspaceUri, normalizedParentPath),
        entry,
      );

      if (normalizedName) {
        this.pushToBucket(
          this.entriesByExactName,
          bucketKey(entry.workspaceUri, normalizedName),
          entry,
        );
        for (let size = 1; size <= Math.min(3, normalizedName.length); size += 1) {
          this.pushToBucket(
            this.entriesByNamePrefix,
            bucketKey(entry.workspaceUri, normalizedName.slice(0, size)),
            entry,
          );
        }
      }
      for (const gram of uniqueNgrams(normalizedName, 2)) {
        this.pushToBucket(
          this.entriesByBigram,
          bucketKey(entry.workspaceUri, gram),
          entry,
        );
      }
    }
    if (addedEntries) {
      this.catalogRevision += 1;
    }
  }

  getEntry(identity: string): PathEntry | undefined {
    return this.byIdentity.get(identity);
  }

  isWithinScope(entry: PathEntry, scopePath: string, directChildrenOnly = false): boolean {
    const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
    return this.isWithinNormalizedScope(entry, normalizedScope, directChildrenOnly);
  }

  isWithinNormalizedScope(
    entry: PathEntry,
    normalizedScope: string,
    directChildrenOnly = false,
  ): boolean {
    const normalizedPath = entry.normalizedPath ?? normalizeSearchText(entry.relativePath);
    const separatorIndex = normalizedPath.lastIndexOf('/');
    const normalizedParentPath =
      separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex);

    if (directChildrenOnly) {
      return normalizedParentPath === normalizedScope;
    }
    return normalizedScope.length === 0 || normalizedPath.startsWith(`${normalizedScope}/`);
  }

  directChildren(scopePath: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
    return this.bucketEntries(this.childrenByParent, normalizedScope, workspaceUri);
  }

  exactNameCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
      return [];
    }
    return this.bucketEntries(this.entriesByExactName, normalizedQuery, workspaceUri);
  }

  prefixCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
      return [];
    }
    const prefix = normalizedQuery.slice(0, Math.min(3, normalizedQuery.length));
    return this.bucketEntries(this.entriesByNamePrefix, prefix, workspaceUri);
  }

  bigramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 2) {
      return [];
    }
    return this.bucketEntries(this.entriesByBigram, normalizedQuery.slice(0, 2), workspaceUri);
  }

  ngramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 2) {
      return [];
    }
    const workspaceUris = [...this.selectedWorkspaceUris(workspaceUri)];
    let rarestBigram: string | undefined;
    let rarestCount = Number.POSITIVE_INFINITY;
    for (const bigram of uniqueNgrams(normalizedQuery, 2)) {
      const count = workspaceUris.reduce(
        (total, uri) =>
          total + (this.entriesByBigram.get(bucketKey(uri, bigram))?.length ?? 0),
        0,
      );
      if (count < rarestCount) {
        rarestBigram = bigram;
        rarestCount = count;
      }
    }
    return rarestBigram
      ? this.bucketEntries(this.entriesByBigram, rarestBigram, workspaceUri)
      : [];
  }

  workspaceCandidates(workspaceUri?: string): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const uri of catalog.selectedWorkspaceUris(workspaceUri)) {
        yield* catalog.entriesByWorkspace.get(uri) ?? [];
      }
    })();
  }

  private bucketEntries(
    buckets: ReadonlyMap<string, readonly PathEntry[]>,
    token: string,
    workspaceUri?: string,
  ): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const uri of catalog.selectedWorkspaceUris(workspaceUri)) {
        yield* buckets.get(bucketKey(uri, token)) ?? [];
      }
    })();
  }

  private selectedWorkspaceUris(workspaceUri?: string): Iterable<string> {
    return workspaceUri ? [workspaceUri] : this.workspaceUris;
  }

  private pushToBucket(
    buckets: Map<string, PathEntry[]>,
    key: string,
    entry: PathEntry,
  ): void {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }
}
