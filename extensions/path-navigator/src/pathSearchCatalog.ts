import type { PathEntry } from './pathEntry';
import { normalizeSearchQuery, normalizeSearchText } from './search';

const PACK_BUCKET_THRESHOLD = 32;
const NGRAM_INTERSECTION_BUCKETS = 3;
const MIN_PACKED_TAIL_MERGE_SIZE = 4_096;

interface PackedIdBucket {
  readonly packed: Uint32Array;
  tail?: number[];
}

type IdBucket = number | number[] | PackedIdBucket;
type BucketMap = Map<string, IdBucket>;

interface WorkspaceCatalog {
  readonly uri: string;
  entryIds: IdBucket | undefined;
  readonly idsByNormalizedPath: BucketMap;
  readonly childrenByParent: BucketMap;
  readonly entriesByExactName: BucketMap;
  readonly entriesByNamePrefix: BucketMap;
  readonly entriesByBigram: BucketMap;
}

function appendId(bucket: IdBucket | undefined, entryId: number): IdBucket {
  if (bucket === undefined) {
    return entryId;
  }
  if (typeof bucket === 'number') {
    return [bucket, entryId];
  }
  if (Array.isArray(bucket)) {
    bucket.push(entryId);
    return bucket;
  } else if (bucket.tail) {
    bucket.tail.push(entryId);
  } else {
    bucket.tail = [entryId];
  }
  return bucket;
}

function appendToBucket(buckets: BucketMap, key: string, entryId: number): void {
  buckets.set(key, appendId(buckets.get(key), entryId));
}

function* bucketIds(bucket: IdBucket | undefined): IterableIterator<number> {
  if (bucket === undefined) {
    return;
  }
  if (typeof bucket === 'number') {
    yield bucket;
    return;
  }
  if (Array.isArray(bucket)) {
    yield* bucket;
    return;
  }
  yield* bucket.packed;
  if (bucket.tail) {
    yield* bucket.tail;
  }
}

function bucketLength(bucket: IdBucket | undefined): number {
  if (bucket === undefined) {
    return 0;
  }
  if (typeof bucket === 'number') {
    return 1;
  }
  return Array.isArray(bucket)
    ? bucket.length
    : bucket.packed.length + (bucket.tail?.length ?? 0);
}

function packBuckets(buckets: BucketMap): void {
  for (const [key, bucket] of buckets) {
    if (Array.isArray(bucket) && bucket.length >= PACK_BUCKET_THRESHOLD) {
      buckets.set(key, { packed: Uint32Array.from(bucket) });
    } else if (
      typeof bucket === 'object' &&
      !Array.isArray(bucket) &&
      bucket.tail &&
      bucket.tail.length >= Math.max(MIN_PACKED_TAIL_MERGE_SIZE, bucket.packed.length / 4)
    ) {
      const merged = new Uint32Array(bucket.packed.length + bucket.tail.length);
      merged.set(bucket.packed);
      merged.set(bucket.tail, bucket.packed.length);
      buckets.set(key, { packed: merged });
    }
  }
}

function packStandaloneBucket(bucket: IdBucket | undefined): IdBucket | undefined {
  if (Array.isArray(bucket) && bucket.length >= PACK_BUCKET_THRESHOLD) {
    return { packed: Uint32Array.from(bucket) };
  }
  if (
    bucket &&
    typeof bucket === 'object' &&
    !Array.isArray(bucket) &&
    bucket.tail &&
    bucket.tail.length >= Math.max(MIN_PACKED_TAIL_MERGE_SIZE, bucket.packed.length / 4)
  ) {
    const merged = new Uint32Array(bucket.packed.length + bucket.tail.length);
    merged.set(bucket.packed);
    merged.set(bucket.tail, bucket.packed.length);
    return { packed: merged };
  }
  return bucket;
}

function uniqueNgrams(value: string, size: number): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    grams.add(value.slice(index, index + size));
  }
  return grams;
}

function createWorkspaceCatalog(uri: string): WorkspaceCatalog {
  return {
    uri,
    entryIds: undefined,
    idsByNormalizedPath: new Map(),
    childrenByParent: new Map(),
    entriesByExactName: new Map(),
    entriesByNamePrefix: new Map(),
    entriesByBigram: new Map(),
  };
}

export class PathSearchCatalog {
  private static nextInstanceId = 1;
  private readonly entries: Array<PathEntry | undefined> = [];
  private readonly workspaces = new Map<string, WorkspaceCatalog>();
  private activeEntryCount = 0;
  private removedEntryCount = 0;
  readonly instanceId = PathSearchCatalog.nextInstanceId++;
  private catalogRevision = 0;

  get size(): number {
    return this.activeEntryCount;
  }

  get revision(): number {
    return this.catalogRevision;
  }

  get tombstoneRatio(): number {
    return this.entries.length === 0 ? 0 : this.removedEntryCount / this.entries.length;
  }

  addEntries(entries: readonly PathEntry[]): number {
    let addedCount = 0;
    for (const entry of entries) {
      const existingWorkspace = this.workspaces.get(entry.workspaceUri);
      if (
        existingWorkspace &&
        this.findExactPathEntryId(existingWorkspace, entry.relativePath) !== undefined
      ) {
        continue;
      }

      const entryId = this.entries.length;
      const normalizedName = entry.normalizedName ?? normalizeSearchText(entry.name);
      const normalizedPath = entry.normalizedPath ?? normalizeSearchText(entry.relativePath);
      const separatorIndex = normalizedPath.lastIndexOf('/');
      const normalizedParentPath =
        separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex);
      let workspace = this.workspaces.get(entry.workspaceUri);
      if (!workspace) {
        workspace = createWorkspaceCatalog(entry.workspaceUri);
        this.workspaces.set(entry.workspaceUri, workspace);
      }

      this.entries.push(entry);
      this.activeEntryCount += 1;
      addedCount += 1;
      workspace.entryIds = appendId(workspace.entryIds, entryId);
      appendToBucket(workspace.idsByNormalizedPath, normalizedPath, entryId);
      appendToBucket(workspace.childrenByParent, normalizedParentPath, entryId);

      if (normalizedName) {
        appendToBucket(workspace.entriesByExactName, normalizedName, entryId);
        for (let size = 1; size <= Math.min(3, normalizedName.length); size += 1) {
          appendToBucket(
            workspace.entriesByNamePrefix,
            normalizedName.slice(0, size),
            entryId,
          );
        }
      }
      for (const gram of uniqueNgrams(normalizedName, 2)) {
        appendToBucket(workspace.entriesByBigram, gram, entryId);
      }
    }
    if (addedCount > 0) {
      this.catalogRevision += 1;
    }
    return addedCount;
  }

  /** Packs large posting lists after a full build while keeping small buckets allocation-light. */
  seal(): void {
    for (const workspace of this.workspaces.values()) {
      workspace.entryIds = packStandaloneBucket(workspace.entryIds);
      packBuckets(workspace.childrenByParent);
      packBuckets(workspace.entriesByExactName);
      packBuckets(workspace.entriesByNamePrefix);
      packBuckets(workspace.entriesByBigram);
    }
  }

  getEntry(identity: string): PathEntry | undefined {
    const workspaceSeparator = identity.indexOf('\0');
    const kindSeparator = identity.indexOf('\0', workspaceSeparator + 1);
    if (workspaceSeparator < 0 || kindSeparator < 0) {
      return undefined;
    }
    const workspaceUri = identity.slice(0, workspaceSeparator);
    const kind = identity.slice(workspaceSeparator + 1, kindSeparator);
    const entry = this.getEntryByPath(workspaceUri, identity.slice(kindSeparator + 1));
    return entry?.kind === kind ? entry : undefined;
  }

  getEntryByPath(workspaceUri: string, relativePath: string): PathEntry | undefined {
    const workspace = this.workspaces.get(workspaceUri);
    if (!workspace) {
      return undefined;
    }
    const entryId = this.findPathEntryId(workspace, relativePath);
    return entryId === undefined ? undefined : this.entries[entryId];
  }

  removePath(workspaceUri: string, relativePath: string, recursive = true): number {
    const workspace = this.workspaces.get(workspaceUri);
    if (!workspace) {
      return 0;
    }
    const rootId = this.findPathEntryId(workspace, relativePath.replace(/\/$/, ''));
    if (rootId === undefined) {
      return 0;
    }

    const pendingIds = [rootId];
    const idsToRemove: number[] = [];
    for (let index = 0; index < pendingIds.length; index += 1) {
      const entryId = pendingIds[index];
      const entry = this.entries[entryId];
      if (!entry) {
        continue;
      }
      idsToRemove.push(entryId);
      if (recursive && entry.kind === 'directory') {
        const childIds = workspace.childrenByParent.get(
          entry.normalizedPath ?? normalizeSearchText(entry.relativePath),
        );
        for (const childId of bucketIds(childIds)) {
          if (this.entries[childId]) {
            pendingIds.push(childId);
          }
        }
      }
    }

    for (const entryId of idsToRemove) {
      const entry = this.entries[entryId];
      if (!entry) {
        continue;
      }
      this.entries[entryId] = undefined;
      this.activeEntryCount -= 1;
      this.removedEntryCount += 1;
    }
    if (idsToRemove.length > 0) {
      this.catalogRevision += 1;
    }
    return idsToRemove.length;
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
    return this.bucketEntries('childrenByParent', normalizedScope, workspaceUri);
  }

  exactNameCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    return normalizedQuery
      ? this.bucketEntries('entriesByExactName', normalizedQuery, workspaceUri)
      : [];
  }

  prefixCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
      return [];
    }
    const prefix = normalizedQuery.slice(0, Math.min(3, normalizedQuery.length));
    return this.bucketEntries('entriesByNamePrefix', prefix, workspaceUri);
  }

  bigramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    return normalizedQuery.length < 2
      ? []
      : this.bucketEntries('entriesByBigram', normalizedQuery.slice(0, 2), workspaceUri);
  }

  ngramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 2) {
      return [];
    }
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        let rarestBucket: IdBucket | undefined;
        let rarestCount = Number.POSITIVE_INFINITY;
        for (const gram of uniqueNgrams(normalizedQuery, 2)) {
          const bucket = workspace.entriesByBigram.get(gram);
          const count = bucketLength(bucket);
          if (count < rarestCount) {
            rarestBucket = bucket;
            rarestCount = count;
          }
        }
        yield* catalog.activeEntries(bucketIds(rarestBucket));
      }
    })();
  }

  intersectingNgramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 3) {
      return [];
    }
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        const buckets = [...uniqueNgrams(normalizedQuery, 2)]
          .map((gram) => workspace.entriesByBigram.get(gram))
          .filter((bucket): bucket is IdBucket => bucket !== undefined)
          .sort((left, right) => bucketLength(left) - bucketLength(right))
          .slice(0, NGRAM_INTERSECTION_BUCKETS);
        if (buckets.length < 2) {
          continue;
        }
        const membership = buckets.slice(1).map((bucket) => new Set(bucketIds(bucket)));
        for (const entryId of bucketIds(buckets[0])) {
          if (membership.every((ids) => ids.has(entryId))) {
            const entry = catalog.entries[entryId];
            if (entry) {
              yield entry;
            }
          }
        }
      }
    })();
  }

  workspaceCandidates(workspaceUri?: string): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        yield* catalog.activeEntries(bucketIds(workspace.entryIds));
      }
    })();
  }

  activeEntriesSnapshot(): PathEntry[] {
    return this.entries.filter((entry): entry is PathEntry => entry !== undefined);
  }

  private *activeEntries(entryIds: Iterable<number>): IterableIterator<PathEntry> {
    for (const entryId of entryIds) {
      const entry = this.entries[entryId];
      if (entry) {
        yield entry;
      }
    }
  }

  private findPathEntryId(
    workspace: WorkspaceCatalog,
    relativePath: string,
  ): number | undefined {
    return (
      this.findExactPathEntryId(workspace, relativePath) ??
      this.findNormalizedPathEntryId(workspace, relativePath)
    );
  }

  private findExactPathEntryId(
    workspace: WorkspaceCatalog,
    relativePath: string,
  ): number | undefined {
    const normalizedPath = normalizeSearchText(relativePath).replace(/\/$/, '');
    for (const entryId of bucketIds(workspace.idsByNormalizedPath.get(normalizedPath))) {
      const entry = this.entries[entryId];
      if (entry?.relativePath === relativePath) {
        return entryId;
      }
    }
    return undefined;
  }

  private findNormalizedPathEntryId(
    workspace: WorkspaceCatalog,
    relativePath: string,
  ): number | undefined {
    const normalizedPath = normalizeSearchText(relativePath).replace(/\/$/, '');
    for (const entryId of bucketIds(workspace.idsByNormalizedPath.get(normalizedPath))) {
      if (this.entries[entryId]) {
        return entryId;
      }
    }
    return undefined;
  }

  private bucketEntries(
    bucketName:
      | 'childrenByParent'
      | 'entriesByExactName'
      | 'entriesByNamePrefix'
      | 'entriesByBigram',
    token: string,
    workspaceUri?: string,
  ): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        yield* catalog.activeEntries(bucketIds(workspace[bucketName].get(token)));
      }
    })();
  }

  private selectedWorkspaces(workspaceUri?: string): Iterable<WorkspaceCatalog> {
    if (!workspaceUri) {
      return this.workspaces.values();
    }
    const workspace = this.workspaces.get(workspaceUri);
    return workspace ? [workspace] : [];
  }
}
