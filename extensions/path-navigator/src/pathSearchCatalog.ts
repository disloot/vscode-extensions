import {
  createCompactPathEntry,
  createPathWorkspaceMetadata,
  type PathEntry,
  type PathEntryKind,
  type PathWorkspaceMetadata,
} from './pathEntry';
import { LruCache } from './lruCache';
import {
  normalizeSearchQuery,
  normalizeSearchText,
  scorePathValuesWithNormalizedQuery,
} from './search';

const PACK_BUCKET_THRESHOLD = 32;
const NGRAM_INTERSECTION_BUCKETS = 3;
const MIN_PACKED_TAIL_MERGE_SIZE = 4_096;
const COLUMN_CHUNK_SIZE = 16_384;
const FILE_KIND = 0;
const DIRECTORY_KIND = 1;
const DIRECTORY_SUFFIX_CACHE_SIZE = 128;
const DIRECTORY_SUFFIX_CANDIDATE_LIMIT = 2_000;

interface PackedIdBucket {
  readonly packed: Uint32Array;
  tail?: number[];
}

type IdBucket = number | number[] | PackedIdBucket;
type BucketMap = Map<string, IdBucket>;
export type PathEntryId = number;

export interface PathSearchIndex {
  readonly size: number;
  readonly revision: number;
  readonly instanceId: number;
  getEntry(identity: string): PathEntry | undefined;
  getEntryId(identity: string): PathEntryId | undefined;
  getEntryById(entryId: PathEntryId): PathEntry | undefined;
  entryKindById(entryId: PathEntryId): PathEntryKind | undefined;
  entryRelativePathById(entryId: PathEntryId): string | undefined;
  scoreEntryById(
    entryId: PathEntryId,
    normalizedQuery: string,
    fuzzyMatching?: boolean,
  ): number | undefined;
  isEntryIdWithinNormalizedScope(
    entryId: PathEntryId,
    normalizedScope: string,
    directChildrenOnly?: boolean,
  ): boolean;
  getEntryByPath(workspaceUri: string, relativePath: string): PathEntry | undefined;
  resolveUniqueDirectorySuffix(
    pathQuery: string,
    workspaceUri?: string,
  ): PathEntry | undefined;
  normalizedWorkspaceNameForEntry(entry: PathEntry): string;
  isWithinNormalizedScope(
    entry: PathEntry,
    normalizedScope: string,
    directChildrenOnly?: boolean,
  ): boolean;
  directChildIds(scopePath: string, workspaceUri?: string): Iterable<PathEntryId>;
  exactNameCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId>;
  prefixCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId>;
  bigramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId>;
  ngramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId>;
  intersectingNgramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId>;
  pathSegmentCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId>;
  workspaceCandidateIds(workspaceUri?: string): Iterable<PathEntryId>;
}

interface WorkspaceCatalog {
  readonly id: number;
  readonly name: string;
  readonly uri: string;
  readonly normalizedWorkspaceName: string;
  readonly metadata: PathWorkspaceMetadata;
  entryIds: IdBucket | undefined;
  readonly idsByNormalizedPath: BucketMap;
  readonly childrenByParent: BucketMap;
  readonly entriesByExactName: BucketMap;
  readonly entriesByNamePrefix: BucketMap;
  readonly entriesByBigram: BucketMap;
  readonly entriesBySegmentPrefix: BucketMap;
}

class ChunkedUint8Column {
  private readonly chunks: Uint8Array[] = [];
  length = 0;

  push(value: number): void {
    const chunkIndex = Math.floor(this.length / COLUMN_CHUNK_SIZE);
    if (chunkIndex === this.chunks.length) {
      this.chunks.push(new Uint8Array(COLUMN_CHUNK_SIZE));
    }
    this.chunks[chunkIndex][this.length % COLUMN_CHUNK_SIZE] = value;
    this.length += 1;
  }

  get(index: number): number | undefined {
    return index < 0 || index >= this.length
      ? undefined
      : this.chunks[Math.floor(index / COLUMN_CHUNK_SIZE)][index % COLUMN_CHUNK_SIZE];
  }
}

class ChunkedUint16Column {
  private readonly chunks: Uint16Array[] = [];
  length = 0;

  push(value: number): void {
    if (value > 0xffff) {
      throw new Error('Path Navigator supports at most 65,536 workspace columns.');
    }
    const chunkIndex = Math.floor(this.length / COLUMN_CHUNK_SIZE);
    if (chunkIndex === this.chunks.length) {
      this.chunks.push(new Uint16Array(COLUMN_CHUNK_SIZE));
    }
    this.chunks[chunkIndex][this.length % COLUMN_CHUNK_SIZE] = value;
    this.length += 1;
  }

  get(index: number): number | undefined {
    return index < 0 || index >= this.length
      ? undefined
      : this.chunks[Math.floor(index / COLUMN_CHUNK_SIZE)][index % COLUMN_CHUNK_SIZE];
  }
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

function sortedValuesContain(values: ArrayLike<number>, target: number): boolean {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = values[middle];
    if (value === target) {
      return true;
    }
    if (value < target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
}

function bucketContains(bucket: IdBucket, entryId: number): boolean {
  if (typeof bucket === 'number') {
    return bucket === entryId;
  }
  if (Array.isArray(bucket)) {
    return sortedValuesContain(bucket, entryId);
  }
  return (
    sortedValuesContain(bucket.packed, entryId) ||
    (bucket.tail !== undefined && sortedValuesContain(bucket.tail, entryId))
  );
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

function uniqueSegmentPrefixes(value: string): Set<string> {
  const prefixes = new Set<string>();
  for (const segment of value.split('/')) {
    if (!segment) {
      continue;
    }
    for (let size = 1; size <= Math.min(3, segment.length); size += 1) {
      prefixes.add(segment.slice(0, size));
    }
  }
  return prefixes;
}

function isNormalizedPathWithinScope(
  normalizedPath: string,
  normalizedScope: string,
  directChildrenOnly: boolean,
): boolean {
  if (directChildrenOnly) {
    const separatorIndex = normalizedPath.lastIndexOf('/');
    return (separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex)) === normalizedScope;
  }
  return normalizedScope.length === 0 || normalizedPath.startsWith(`${normalizedScope}/`);
}

function createWorkspaceCatalog(
  id: number,
  name: string,
  uri: string,
  normalizedWorkspaceName: string,
): WorkspaceCatalog {
  return {
    id,
    name,
    uri,
    normalizedWorkspaceName,
    metadata: createPathWorkspaceMetadata(name, uri),
    entryIds: undefined,
    idsByNormalizedPath: new Map(),
    childrenByParent: new Map(),
    entriesByExactName: new Map(),
    entriesByNamePrefix: new Map(),
    entriesByBigram: new Map(),
    entriesBySegmentPrefix: new Map(),
  };
}

export class PathSearchCatalog implements PathSearchIndex {
  private static nextInstanceId = 1;
  private readonly relativePaths: Array<string | undefined> = [];
  private readonly normalizedPaths: Array<string | undefined> = [];
  private readonly kinds = new ChunkedUint8Column();
  private readonly workspaceIds = new ChunkedUint16Column();
  private readonly workspaces = new Map<string, WorkspaceCatalog>();
  private readonly workspacesById: WorkspaceCatalog[] = [];
  private readonly directorySuffixCache = new LruCache<string, PathEntry | null>(
    DIRECTORY_SUFFIX_CACHE_SIZE,
  );
  private activeEntryCount = 0;
  private removedEntryCount = 0;
  readonly instanceId = PathSearchCatalog.nextInstanceId++;
  private catalogRevision = 0;

  get size(): number {
    return this.activeEntryCount;
  }

  get capacity(): number {
    return this.relativePaths.length;
  }

  get revision(): number {
    return this.catalogRevision;
  }

  get tombstoneRatio(): number {
    return this.relativePaths.length === 0
      ? 0
      : this.removedEntryCount / this.relativePaths.length;
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

      const entryId = this.relativePaths.length;
      const normalizedPath = entry.normalizedPath ?? normalizeSearchText(entry.relativePath);
      const normalizedName = entry.normalizedName ?? normalizeSearchText(entry.name);
      const separatorIndex = normalizedPath.lastIndexOf('/');
      const normalizedParentPath =
        separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex);
      let workspace = this.workspaces.get(entry.workspaceUri);
      if (!workspace) {
        workspace = createWorkspaceCatalog(
          this.workspacesById.length,
          entry.workspaceName,
          entry.workspaceUri,
          entry.normalizedWorkspaceName ?? normalizeSearchText(entry.workspaceName),
        );
        this.workspaces.set(entry.workspaceUri, workspace);
        this.workspacesById.push(workspace);
      }

      this.relativePaths.push(entry.relativePath);
      this.normalizedPaths.push(normalizedPath);
      this.kinds.push(entry.kind === 'directory' ? DIRECTORY_KIND : FILE_KIND);
      this.workspaceIds.push(workspace.id);
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
      for (const prefix of uniqueSegmentPrefixes(normalizedPath)) {
        appendToBucket(workspace.entriesBySegmentPrefix, prefix, entryId);
      }
    }
    if (addedCount > 0) {
      this.catalogRevision += 1;
      this.directorySuffixCache.clear();
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
      packBuckets(workspace.entriesBySegmentPrefix);
    }
  }

  getEntry(identity: string): PathEntry | undefined {
    const entryId = this.getEntryId(identity);
    return entryId === undefined ? undefined : this.getEntryById(entryId);
  }

  getEntryId(identity: string): PathEntryId | undefined {
    const workspaceSeparator = identity.indexOf('\0');
    const kindSeparator = identity.indexOf('\0', workspaceSeparator + 1);
    if (workspaceSeparator < 0 || kindSeparator < 0) {
      return undefined;
    }
    const workspaceUri = identity.slice(0, workspaceSeparator);
    const kind = identity.slice(workspaceSeparator + 1, kindSeparator);
    const workspace = this.workspaces.get(workspaceUri);
    if (!workspace) {
      return undefined;
    }
    const entryId = this.findPathEntryId(
      workspace,
      identity.slice(kindSeparator + 1),
    );
    return entryId !== undefined && this.entryKindById(entryId) === kind
      ? entryId
      : undefined;
  }

  getEntryById(entryId: PathEntryId): PathEntry | undefined {
    const relativePath = this.relativePaths[entryId];
    const normalizedPath = this.normalizedPaths[entryId];
    const workspaceId = this.workspaceIds.get(entryId);
    const kind = this.entryKindById(entryId);
    if (
      relativePath === undefined ||
      normalizedPath === undefined ||
      workspaceId === undefined ||
      kind === undefined
    ) {
      return undefined;
    }
    const workspace = this.workspacesById[workspaceId];
    if (!workspace) {
      return undefined;
    }
    const separatorIndex = relativePath.lastIndexOf('/');
    return createCompactPathEntry({
      kind,
      name: relativePath.slice(separatorIndex + 1),
      relativePath,
      workspaceName: workspace.name,
      workspaceUri: workspace.uri,
      normalizedPath,
    }, workspace.metadata);
  }

  entryKindById(entryId: PathEntryId): PathEntryKind | undefined {
    if (!this.isActive(entryId)) {
      return undefined;
    }
    return this.kinds.get(entryId) === DIRECTORY_KIND ? 'directory' : 'file';
  }

  entryRelativePathById(entryId: PathEntryId): string | undefined {
    return this.relativePaths[entryId];
  }

  scoreEntryById(
    entryId: PathEntryId,
    normalizedQuery: string,
    fuzzyMatching = true,
  ): number | undefined {
    const normalizedPath = this.normalizedPaths[entryId];
    const workspaceId = this.workspaceIds.get(entryId);
    const kind = this.entryKindById(entryId);
    if (normalizedPath === undefined || workspaceId === undefined || kind === undefined) {
      return undefined;
    }
    const workspace = this.workspacesById[workspaceId];
    if (!workspace) {
      return undefined;
    }
    return scorePathValuesWithNormalizedQuery(
      kind,
      normalizedPath,
      normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1),
      workspace.normalizedWorkspaceName,
      normalizedQuery,
      fuzzyMatching,
    );
  }

  isEntryIdWithinNormalizedScope(
    entryId: PathEntryId,
    normalizedScope: string,
    directChildrenOnly = false,
  ): boolean {
    const normalizedPath = this.normalizedPaths[entryId];
    if (normalizedPath === undefined) {
      return false;
    }
    return isNormalizedPathWithinScope(normalizedPath, normalizedScope, directChildrenOnly);
  }

  normalizedWorkspaceNameForEntry(entry: PathEntry): string {
    return this.workspaces.get(entry.workspaceUri)?.normalizedWorkspaceName ??
      normalizeSearchText(entry.workspaceName);
  }

  getEntryByPath(workspaceUri: string, relativePath: string): PathEntry | undefined {
    const workspace = this.workspaces.get(workspaceUri);
    if (!workspace) {
      return undefined;
    }
    const entryId = this.findPathEntryId(workspace, relativePath);
    return entryId === undefined ? undefined : this.getEntryById(entryId);
  }

  resolveUniqueDirectorySuffix(
    pathQuery: string,
    workspaceUri?: string,
  ): PathEntry | undefined {
    const normalizedQuery = normalizeSearchQuery(pathQuery).replace(/^\/+|\/+$/g, '');
    if (!normalizedQuery.includes('/')) {
      return undefined;
    }
    const cacheKey = `${this.catalogRevision}\0${workspaceUri ?? '*'}\0${normalizedQuery}`;
    const cached = this.directorySuffixCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    let exactEntry: PathEntry | undefined;
    for (const workspace of this.selectedWorkspaces(workspaceUri)) {
      const candidate = this.getEntryByPath(workspace.uri, normalizedQuery);
      if (candidate?.kind !== 'directory') {
        continue;
      }
      if (exactEntry) {
        this.directorySuffixCache.set(cacheKey, null);
        return undefined;
      }
      exactEntry = candidate;
    }
    if (exactEntry) {
      this.directorySuffixCache.set(cacheKey, exactEntry);
      return exactEntry;
    }

    const terminalName = normalizedQuery.slice(normalizedQuery.lastIndexOf('/') + 1);
    let suffixEntryId: PathEntryId | undefined;
    let inspectedCandidates = 0;
    for (const entryId of this.exactNameCandidateIds(terminalName, workspaceUri)) {
      inspectedCandidates += 1;
      if (inspectedCandidates > DIRECTORY_SUFFIX_CANDIDATE_LIMIT) {
        this.directorySuffixCache.set(cacheKey, null);
        return undefined;
      }
      if (this.entryKindById(entryId) !== 'directory') {
        continue;
      }
      const normalizedPath = this.normalizedPaths[entryId];
      if (!normalizedPath?.endsWith(`/${normalizedQuery}`)) {
        continue;
      }
      if (suffixEntryId !== undefined && suffixEntryId !== entryId) {
        this.directorySuffixCache.set(cacheKey, null);
        return undefined;
      }
      suffixEntryId = entryId;
    }
    const resolved = suffixEntryId === undefined ? undefined : this.getEntryById(suffixEntryId);
    this.directorySuffixCache.set(cacheKey, resolved ?? null);
    return resolved;
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
      const normalizedPath = this.normalizedPaths[entryId];
      if (normalizedPath === undefined) {
        continue;
      }
      idsToRemove.push(entryId);
      if (recursive && this.entryKindById(entryId) === 'directory') {
        const childIds = workspace.childrenByParent.get(normalizedPath);
        for (const childId of bucketIds(childIds)) {
          if (this.isActive(childId)) {
            pendingIds.push(childId);
          }
        }
      }
    }

    for (const entryId of idsToRemove) {
      if (!this.isActive(entryId)) {
        continue;
      }
      this.relativePaths[entryId] = undefined;
      this.normalizedPaths[entryId] = undefined;
      this.activeEntryCount -= 1;
      this.removedEntryCount += 1;
    }
    if (idsToRemove.length > 0) {
      this.catalogRevision += 1;
      this.directorySuffixCache.clear();
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
    return isNormalizedPathWithinScope(normalizedPath, normalizedScope, directChildrenOnly);
  }

  directChildren(scopePath: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
    return this.bucketEntries('childrenByParent', normalizedScope, workspaceUri);
  }

  directChildIds(scopePath: string, workspaceUri?: string): Iterable<PathEntryId> {
    const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
    return this.bucketEntryIds('childrenByParent', normalizedScope, workspaceUri);
  }

  exactNameCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    return normalizedQuery
      ? this.bucketEntries('entriesByExactName', normalizedQuery, workspaceUri)
      : [];
  }

  exactNameCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    const normalizedQuery = normalizeSearchQuery(query);
    return normalizedQuery
      ? this.bucketEntryIds('entriesByExactName', normalizedQuery, workspaceUri)
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

  prefixCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) {
      return [];
    }
    return this.bucketEntryIds(
      'entriesByNamePrefix',
      normalizedQuery.slice(0, Math.min(3, normalizedQuery.length)),
      workspaceUri,
    );
  }

  bigramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const normalizedQuery = normalizeSearchQuery(query);
    return normalizedQuery.length < 2
      ? []
      : this.bucketEntries('entriesByBigram', normalizedQuery.slice(0, 2), workspaceUri);
  }

  bigramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    const normalizedQuery = normalizeSearchQuery(query);
    return normalizedQuery.length < 2
      ? []
      : this.bucketEntryIds('entriesByBigram', normalizedQuery.slice(0, 2), workspaceUri);
  }

  ngramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const entryId of catalog.ngramCandidateIds(query, workspaceUri)) {
        const entry = catalog.getEntryById(entryId);
        if (entry) {
          yield entry;
        }
      }
    })();
  }

  ngramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 2) {
      return [];
    }
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
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
        yield* catalog.activeEntryIds(bucketIds(rarestBucket));
      }
    })();
  }

  intersectingNgramCandidates(query: string, workspaceUri?: string): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const entryId of catalog.intersectingNgramCandidateIds(query, workspaceUri)) {
        const entry = catalog.getEntryById(entryId);
        if (entry) {
          yield entry;
        }
      }
    })();
  }

  intersectingNgramCandidateIds(
    query: string,
    workspaceUri?: string,
  ): Iterable<PathEntryId> {
    const normalizedQuery = normalizeSearchQuery(query);
    if (normalizedQuery.length < 3) {
      return [];
    }
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        const buckets = [...uniqueNgrams(normalizedQuery, 2)]
          .map((gram) => workspace.entriesByBigram.get(gram))
          .filter((bucket): bucket is IdBucket => bucket !== undefined)
          .sort((left, right) => bucketLength(left) - bucketLength(right))
          .slice(0, NGRAM_INTERSECTION_BUCKETS);
        if (buckets.length < 2) {
          continue;
        }
        for (const entryId of bucketIds(buckets[0])) {
          if (
            catalog.isActive(entryId) &&
            buckets.slice(1).every((bucket) => bucketContains(bucket, entryId))
          ) {
            yield entryId;
          }
        }
      }
    })();
  }

  pathSegmentCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    const normalizedQuery = normalizeSearchQuery(query);
    const segmentPrefixes = [...new Set(
      normalizedQuery
        .split('/')
        .filter(Boolean)
        .map((segment) => segment.slice(0, Math.min(3, segment.length))),
    )];
    if (segmentPrefixes.length < 2) {
      return [];
    }
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        const buckets = segmentPrefixes
          .map((prefix) => workspace.entriesBySegmentPrefix.get(prefix));
        if (buckets.some((bucket) => bucket === undefined)) {
          continue;
        }
        const presentBuckets = (buckets as IdBucket[])
          .sort((left, right) => bucketLength(left) - bucketLength(right));
        for (const entryId of bucketIds(presentBuckets[0])) {
          if (
            catalog.isActive(entryId) &&
            presentBuckets.slice(1).every((bucket) => bucketContains(bucket, entryId))
          ) {
            yield entryId;
          }
        }
      }
    })();
  }

  workspaceCandidates(workspaceUri?: string): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const entryId of catalog.workspaceCandidateIds(workspaceUri)) {
        const entry = catalog.getEntryById(entryId);
        if (entry) {
          yield entry;
        }
      }
    })();
  }

  workspaceCandidateIds(workspaceUri?: string): Iterable<PathEntryId> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        yield* catalog.activeEntryIds(bucketIds(workspace.entryIds));
      }
    })();
  }

  activeEntriesSnapshot(): PathEntry[] {
    return [...this.activeEntries()];
  }

  *activeEntries(): IterableIterator<PathEntry> {
    for (let entryId = 0; entryId < this.relativePaths.length; entryId += 1) {
      const entry = this.getEntryById(entryId);
      if (entry) {
        yield entry;
      }
    }
  }

  private *activeEntriesFromIds(entryIds: Iterable<number>): IterableIterator<PathEntry> {
    for (const entryId of entryIds) {
      const entry = this.getEntryById(entryId);
      if (entry) {
        yield entry;
      }
    }
  }

  private *activeEntryIds(entryIds: Iterable<number>): IterableIterator<PathEntryId> {
    for (const entryId of entryIds) {
      if (this.isActive(entryId)) {
        yield entryId;
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
      if (this.relativePaths[entryId] === relativePath) {
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
      if (this.isActive(entryId)) {
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
      | 'entriesByBigram'
      | 'entriesBySegmentPrefix',
    token: string,
    workspaceUri?: string,
  ): Iterable<PathEntry> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntry> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        yield* catalog.activeEntriesFromIds(bucketIds(workspace[bucketName].get(token)));
      }
    })();
  }

  private bucketEntryIds(
    bucketName:
      | 'childrenByParent'
      | 'entriesByExactName'
      | 'entriesByNamePrefix'
      | 'entriesByBigram'
      | 'entriesBySegmentPrefix',
    token: string,
    workspaceUri?: string,
  ): Iterable<PathEntryId> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
      for (const workspace of catalog.selectedWorkspaces(workspaceUri)) {
        yield* catalog.activeEntryIds(bucketIds(workspace[bucketName].get(token)));
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

  private isActive(entryId: number): boolean {
    return this.relativePaths[entryId] !== undefined;
  }
}

const PARTITION_ID_STRIDE = 0x1_0000_0000;

/**
 * Keeps each workspace in an independently replaceable compact catalog. Encoded
 * entry IDs remain numeric, while a background refresh only duplicates the
 * workspace partition currently being rebuilt.
 */
export class PartitionedPathSearchCatalog implements PathSearchIndex {
  private static nextInstanceId = 1_000_000;
  private readonly partitionsByUri = new Map<string, {
    readonly partitionId: number;
    catalog: PathSearchCatalog;
  }>();
  private readonly partitionsById = new Map<number, PathSearchCatalog>();
  private nextPartitionId = 1;
  private catalogRevision = 0;
  private readonly directorySuffixCache = new LruCache<string, PathEntry | null>(
    DIRECTORY_SUFFIX_CACHE_SIZE,
  );
  readonly instanceId = PartitionedPathSearchCatalog.nextInstanceId++;

  get size(): number {
    let size = 0;
    for (const { catalog } of this.partitionsByUri.values()) {
      size += catalog.size;
    }
    return size;
  }

  get revision(): number {
    return this.catalogRevision;
  }

  get tombstoneRatio(): number {
    let capacity = 0;
    let removed = 0;
    for (const { catalog } of this.partitionsByUri.values()) {
      capacity += catalog.capacity;
      removed += catalog.capacity - catalog.size;
    }
    return capacity === 0 ? 0 : removed / capacity;
  }

  replaceWorkspace(workspaceUri: string, catalog: PathSearchCatalog): void {
    const existing = this.partitionsByUri.get(workspaceUri);
    if (existing) {
      this.partitionsById.delete(existing.partitionId);
    }
    // A replacement receives a fresh namespace so numeric IDs captured by an
    // in-flight search can never resolve to unrelated entries in the new root.
    const partitionId = this.nextPartitionId++;
    this.partitionsByUri.set(workspaceUri, { partitionId, catalog });
    this.partitionsById.set(partitionId, catalog);
    this.catalogRevision += 1;
    this.directorySuffixCache.clear();
  }

  removeWorkspace(workspaceUri: string): void {
    const existing = this.partitionsByUri.get(workspaceUri);
    if (!existing) {
      return;
    }
    this.partitionsByUri.delete(workspaceUri);
    this.partitionsById.delete(existing.partitionId);
    this.catalogRevision += 1;
    this.directorySuffixCache.clear();
  }

  workspaceCatalog(workspaceUri: string): PathSearchCatalog | undefined {
    return this.partitionsByUri.get(workspaceUri)?.catalog;
  }

  workspaceUris(): readonly string[] {
    return [...this.partitionsByUri.keys()];
  }

  ensureWorkspaceCatalog(workspaceUri: string): PathSearchCatalog {
    const existing = this.workspaceCatalog(workspaceUri);
    if (existing) {
      return existing;
    }
    const catalog = new PathSearchCatalog();
    this.replaceWorkspace(workspaceUri, catalog);
    return catalog;
  }

  markWorkspaceChanged(): void {
    this.catalogRevision += 1;
    this.directorySuffixCache.clear();
  }

  compactWorkspace(workspaceUri: string): void {
    const existing = this.workspaceCatalog(workspaceUri);
    if (!existing) {
      return;
    }
    const compacted = new PathSearchCatalog();
    let batch: PathEntry[] = [];
    for (const entry of existing.activeEntries()) {
      batch.push(entry);
      if (batch.length >= 5_000) {
        compacted.addEntries(batch);
        batch = [];
      }
    }
    compacted.addEntries(batch);
    compacted.seal();
    this.replaceWorkspace(workspaceUri, compacted);
  }

  addEntries(entries: readonly PathEntry[]): number {
    const entriesByWorkspace = new Map<string, PathEntry[]>();
    for (const entry of entries) {
      const bucket = entriesByWorkspace.get(entry.workspaceUri) ?? [];
      bucket.push(entry);
      entriesByWorkspace.set(entry.workspaceUri, bucket);
    }
    let added = 0;
    for (const [workspaceUri, workspaceEntries] of entriesByWorkspace) {
      added += this.ensureWorkspaceCatalog(workspaceUri).addEntries(workspaceEntries);
    }
    if (added > 0) {
      this.catalogRevision += 1;
      this.directorySuffixCache.clear();
    }
    return added;
  }

  removePath(workspaceUri: string, relativePath: string, recursive = true): number {
    const removed = this.workspaceCatalog(workspaceUri)
      ?.removePath(workspaceUri, relativePath, recursive) ?? 0;
    if (removed > 0) {
      this.catalogRevision += 1;
      this.directorySuffixCache.clear();
    }
    return removed;
  }

  seal(): void {
    for (const { catalog } of this.partitionsByUri.values()) {
      catalog.seal();
    }
  }

  getEntry(identity: string): PathEntry | undefined {
    const entryId = this.getEntryId(identity);
    return entryId === undefined ? undefined : this.getEntryById(entryId);
  }

  getEntryId(identity: string): PathEntryId | undefined {
    const separatorIndex = identity.indexOf('\0');
    if (separatorIndex < 0) {
      return undefined;
    }
    const partition = this.partitionsByUri.get(identity.slice(0, separatorIndex));
    const localId = partition?.catalog.getEntryId(identity);
    return partition && localId !== undefined
      ? this.encodeId(partition.partitionId, localId)
      : undefined;
  }

  getEntryById(entryId: PathEntryId): PathEntry | undefined {
    const { partitionId, localId } = this.decodeId(entryId);
    return this.partitionsById.get(partitionId)?.getEntryById(localId);
  }

  entryKindById(entryId: PathEntryId): PathEntryKind | undefined {
    const { partitionId, localId } = this.decodeId(entryId);
    return this.partitionsById.get(partitionId)?.entryKindById(localId);
  }

  entryRelativePathById(entryId: PathEntryId): string | undefined {
    const { partitionId, localId } = this.decodeId(entryId);
    return this.partitionsById.get(partitionId)?.entryRelativePathById(localId);
  }

  scoreEntryById(
    entryId: PathEntryId,
    normalizedQuery: string,
    fuzzyMatching = true,
  ): number | undefined {
    const { partitionId, localId } = this.decodeId(entryId);
    return this.partitionsById.get(partitionId)
      ?.scoreEntryById(localId, normalizedQuery, fuzzyMatching);
  }

  isEntryIdWithinNormalizedScope(
    entryId: PathEntryId,
    normalizedScope: string,
    directChildrenOnly = false,
  ): boolean {
    const { partitionId, localId } = this.decodeId(entryId);
    return this.partitionsById.get(partitionId)
      ?.isEntryIdWithinNormalizedScope(localId, normalizedScope, directChildrenOnly) ?? false;
  }

  getEntryByPath(workspaceUri: string, relativePath: string): PathEntry | undefined {
    return this.workspaceCatalog(workspaceUri)?.getEntryByPath(workspaceUri, relativePath);
  }

  resolveUniqueDirectorySuffix(
    pathQuery: string,
    workspaceUri?: string,
  ): PathEntry | undefined {
    const normalizedQuery = normalizeSearchQuery(pathQuery).replace(/^\/+|\/+$/g, '');
    if (!normalizedQuery.includes('/')) {
      return undefined;
    }
    const cacheKey = `${this.catalogRevision}\0${workspaceUri ?? '*'}\0${normalizedQuery}`;
    const cached = this.directorySuffixCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    let exactEntry: PathEntry | undefined;
    const exactPartitions = workspaceUri
      ? [[workspaceUri, this.partitionsByUri.get(workspaceUri)] as const]
      : this.partitionsByUri.entries();
    for (const [partitionWorkspaceUri, partition] of exactPartitions) {
      const candidate = partition?.catalog.getEntryByPath(
        partitionWorkspaceUri,
        normalizedQuery,
      );
      if (candidate?.kind !== 'directory') {
        continue;
      }
      if (exactEntry) {
        this.directorySuffixCache.set(cacheKey, null);
        return undefined;
      }
      exactEntry = candidate;
    }
    if (exactEntry) {
      this.directorySuffixCache.set(cacheKey, exactEntry);
      return exactEntry;
    }

    const terminalName = normalizedQuery.slice(normalizedQuery.lastIndexOf('/') + 1);
    let suffixEntryId: PathEntryId | undefined;
    let inspectedCandidates = 0;
    for (const entryId of this.exactNameCandidateIds(terminalName, workspaceUri)) {
      inspectedCandidates += 1;
      if (inspectedCandidates > DIRECTORY_SUFFIX_CANDIDATE_LIMIT) {
        this.directorySuffixCache.set(cacheKey, null);
        return undefined;
      }
      if (this.entryKindById(entryId) !== 'directory') {
        continue;
      }
      const relativePath = this.entryRelativePathById(entryId);
      const normalizedPath = relativePath && normalizeSearchText(relativePath);
      if (!normalizedPath?.endsWith(`/${normalizedQuery}`)) {
        continue;
      }
      if (suffixEntryId !== undefined && suffixEntryId !== entryId) {
        this.directorySuffixCache.set(cacheKey, null);
        return undefined;
      }
      suffixEntryId = entryId;
    }
    const resolved = suffixEntryId === undefined ? undefined : this.getEntryById(suffixEntryId);
    this.directorySuffixCache.set(cacheKey, resolved ?? null);
    return resolved;
  }

  normalizedWorkspaceNameForEntry(entry: PathEntry): string {
    return this.workspaceCatalog(entry.workspaceUri)
      ?.normalizedWorkspaceNameForEntry(entry) ?? normalizeSearchText(entry.workspaceName);
  }

  isWithinNormalizedScope(
    entry: PathEntry,
    normalizedScope: string,
    directChildrenOnly = false,
  ): boolean {
    const partition = this.workspaceCatalog(entry.workspaceUri);
    return partition?.isWithinNormalizedScope(entry, normalizedScope, directChildrenOnly) ?? false;
  }

  directChildIds(scopePath: string, workspaceUri?: string): Iterable<PathEntryId> {
    return this.delegateIds('directChildIds', scopePath, workspaceUri);
  }

  exactNameCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    return this.delegateIds('exactNameCandidateIds', query, workspaceUri);
  }

  prefixCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    return this.delegateIds('prefixCandidateIds', query, workspaceUri);
  }

  bigramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    return this.delegateIds('bigramCandidateIds', query, workspaceUri);
  }

  ngramCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    return this.delegateIds('ngramCandidateIds', query, workspaceUri);
  }

  intersectingNgramCandidateIds(
    query: string,
    workspaceUri?: string,
  ): Iterable<PathEntryId> {
    return this.delegateIds('intersectingNgramCandidateIds', query, workspaceUri);
  }

  pathSegmentCandidateIds(query: string, workspaceUri?: string): Iterable<PathEntryId> {
    return this.delegateIds('pathSegmentCandidateIds', query, workspaceUri);
  }

  workspaceCandidateIds(workspaceUri?: string): Iterable<PathEntryId> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
      for (const partition of catalog.selectedPartitions(workspaceUri)) {
        for (const localId of partition.catalog.workspaceCandidateIds(workspaceUri)) {
          yield catalog.encodeId(partition.partitionId, localId);
        }
      }
    })();
  }

  *activeEntries(): IterableIterator<PathEntry> {
    for (const { catalog } of this.partitionsByUri.values()) {
      yield* catalog.activeEntries();
    }
  }

  activeEntriesSnapshot(): PathEntry[] {
    return [...this.activeEntries()];
  }

  private delegateIds(
    method:
      | 'directChildIds'
      | 'exactNameCandidateIds'
      | 'prefixCandidateIds'
      | 'bigramCandidateIds'
      | 'ngramCandidateIds'
      | 'intersectingNgramCandidateIds'
      | 'pathSegmentCandidateIds',
    query: string,
    workspaceUri?: string,
  ): Iterable<PathEntryId> {
    const catalog = this;
    return (function* (): IterableIterator<PathEntryId> {
      for (const partition of catalog.selectedPartitions(workspaceUri)) {
        for (const localId of partition.catalog[method](query, workspaceUri)) {
          yield catalog.encodeId(partition.partitionId, localId);
        }
      }
    })();
  }

  private selectedPartitions(workspaceUri?: string): Iterable<{
    readonly partitionId: number;
    readonly catalog: PathSearchCatalog;
  }> {
    if (!workspaceUri) {
      return this.partitionsByUri.values();
    }
    const partition = this.partitionsByUri.get(workspaceUri);
    return partition ? [partition] : [];
  }

  private encodeId(partitionId: number, localId: number): number {
    return partitionId * PARTITION_ID_STRIDE + localId;
  }

  private decodeId(entryId: number): { partitionId: number; localId: number } {
    const partitionId = Math.floor(entryId / PARTITION_ID_STRIDE);
    return {
      partitionId,
      localId: entryId - partitionId * PARTITION_ID_STRIDE,
    };
  }
}
