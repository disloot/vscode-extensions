import type { PathEntry } from './pathEntry';
import type { PathEntryId, PathSearchIndex } from './pathSearchCatalog';
import { pathIdentity } from './resultSelection';
import {
  isDescendantOfScope,
  isDirectChild,
  normalizeSearchQuery,
  normalizeSearchText,
  scorePathWithNormalizedQuery,
} from './search';

export interface PathUsage {
  readonly entry: PathEntry;
  readonly lastOpenedAt: number;
  readonly openCount: number;
  readonly pinned?: boolean;
  readonly queryAffinity?: number;
}

export interface PathSearchProgress {
  readonly entries: readonly PathEntry[];
  readonly complete: boolean;
  readonly processedCandidates: number;
  readonly truncated: boolean;
  readonly reusableCandidateIds?: readonly PathEntryId[];
}

export interface PathSearchReuse {
  readonly entryIds: readonly PathEntryId[];
  readonly exhaustive: boolean;
}

export interface PathSearchRequest {
  readonly catalog: PathSearchIndex;
  readonly scopePath: string;
  readonly query: string;
  readonly workspaceUri?: string;
  readonly maxResults: number;
  readonly maxCandidates: number;
  readonly timeBudgetMs: number;
  readonly recentPaths: readonly PathUsage[];
  readonly allowUnindexedRecentPaths: boolean;
  readonly includeFiles?: boolean;
  readonly includeDirectories?: boolean;
  readonly fuzzyMatching?: boolean;
  readonly globalPathQuery?: boolean;
  readonly publishIntermediateResults?: boolean;
  readonly reuse?: PathSearchReuse;
  readonly isCancelled: () => boolean;
  readonly onProgress: (progress: PathSearchProgress) => void;
  readonly now?: number;
}

const SEARCH_SLICE_MS = 8;
const SEARCH_PROGRESS_INTERVAL_MS = 100;
const ONE_CHARACTER_CANDIDATE_LIMIT = 2_000;
const TWO_CHARACTER_CANDIDATE_LIMIT = 5_000;
const CANCELLATION_CHECK_INTERVAL = 128;

function usageScoreBoost(usage: PathUsage, now: number): number {
  const pinnedBoost = usage.pinned ? 2_000 : 0;
  const frequencyBoost = Math.min(180, Math.log2(usage.openCount + 1) * 40);
  const ageInDays = Math.max(0, now - usage.lastOpenedAt) / 86_400_000;
  const recencyBoost = Math.max(0, 120 - ageInDays * 10);
  const queryAffinityBoost = Math.min(
    2_500,
    Math.log2((usage.queryAffinity ?? 0) + 1) * 1_200,
  );
  return pinnedBoost + Math.min(300, frequencyBoost + recencyBoost) + queryAffinityBoost;
}

function candidateQueryForRequest(normalizedQuery: string, globalPathQuery: boolean): string {
  if (!globalPathQuery) {
    return normalizedQuery;
  }
  const segments = normalizedQuery.split('/').filter(Boolean);
  return segments.at(-1) ?? normalizedQuery;
}

function* combineCandidates(
  sources: readonly Iterable<PathEntryId>[],
): IterableIterator<PathEntryId> {
  for (const source of sources) {
    yield* source;
  }
}

function candidateSources(
  catalog: PathSearchIndex,
  normalizedQuery: string,
  normalizedFullQuery: string,
  globalPathQuery: boolean,
  scopePath: string,
  workspaceUri?: string,
  reuse?: PathSearchReuse,
): readonly Iterable<PathEntryId>[] {
  const reusedSources: Iterable<PathEntryId>[] = reuse ? [reuse.entryIds] : [];
  if (reuse?.exhaustive) {
    return reusedSources;
  }
  if (normalizedQuery.length === 0) {
    return [...reusedSources, catalog.directChildIds(scopePath, workspaceUri)];
  }
  if (normalizedQuery.length === 1) {
    return [
      ...reusedSources,
      catalog.exactNameCandidateIds(normalizedQuery, workspaceUri),
      catalog.prefixCandidateIds(normalizedQuery, workspaceUri),
    ];
  }
  if (normalizedQuery.length === 2) {
    return [
      ...reusedSources,
      catalog.exactNameCandidateIds(normalizedQuery, workspaceUri),
      catalog.prefixCandidateIds(normalizedQuery, workspaceUri),
      catalog.bigramCandidateIds(normalizedQuery, workspaceUri),
    ];
  }
  return [
    ...reusedSources,
    ...(globalPathQuery
      ? [catalog.pathSegmentCandidateIds(normalizedFullQuery, workspaceUri)]
      : []),
    catalog.exactNameCandidateIds(normalizedQuery, workspaceUri),
    catalog.prefixCandidateIds(normalizedQuery, workspaceUri),
    catalog.intersectingNgramCandidateIds(normalizedQuery, workspaceUri),
    catalog.ngramCandidateIds(normalizedQuery, workspaceUri),
    catalog.workspaceCandidateIds(workspaceUri),
  ];
}

function effectiveCandidateLimit(queryLength: number, configuredLimit: number): number {
  const limit = Number.isFinite(configuredLimit)
    ? Math.max(0, Math.floor(configuredLimit))
    : 0;
  if (queryLength === 1) {
    return Math.min(limit, ONE_CHARACTER_CANDIDATE_LIMIT);
  }
  if (queryLength === 2) {
    return Math.min(limit, TWO_CHARACTER_CANDIDATE_LIMIT);
  }
  return limit;
}

function recentPathBelongsToRequest(
  entry: PathEntry,
  scopePath: string,
  queryLength: number,
  workspaceUri?: string,
): boolean {
  if (workspaceUri && entry.workspaceUri !== workspaceUri) {
    return false;
  }
  return queryLength === 0
    ? isDirectChild(entry.relativePath, scopePath)
    : isDescendantOfScope(entry.relativePath, scopePath);
}

function entryKindIsIncluded(entry: PathEntry, request: PathSearchRequest): boolean {
  return entry.kind === 'file'
    ? request.includeFiles !== false
    : request.includeDirectories !== false;
}

function kindIsIncluded(
  kind: PathEntry['kind'] | undefined,
  request: PathSearchRequest,
): boolean {
  return kind === 'file'
    ? request.includeFiles !== false
    : kind === 'directory' && request.includeDirectories !== false;
}

interface RankedCandidate {
  readonly entryId?: PathEntryId;
  readonly entry?: PathEntry;
  readonly kind: PathEntry['kind'];
  readonly relativePath: string;
  readonly score: number;
  readonly inputIndex: number;
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1;
  }
  const pathComparison = left.relativePath.localeCompare(right.relativePath);
  return pathComparison !== 0 ? pathComparison : left.inputIndex - right.inputIndex;
}

function candidateValuesAreBetter(
  score: number,
  kind: PathEntry['kind'],
  relativePath: string,
  inputIndex: number,
  currentWorst: RankedCandidate,
): boolean {
  if (currentWorst.score !== score) {
    return score > currentWorst.score;
  }
  if (kind !== currentWorst.kind) {
    return kind === 'directory';
  }
  const pathComparison = relativePath.localeCompare(currentWorst.relativePath);
  return pathComparison !== 0
    ? pathComparison < 0
    : inputIndex < currentWorst.inputIndex;
}

/** Retains only Top-K references and materializes indexed entries at publication time. */
class IndexedTopKRanker {
  private readonly heap: RankedCandidate[] = [];
  private readonly limit: number;
  private inputIndex = 0;

  constructor(
    private readonly catalog: PathSearchIndex,
    maxResults: number,
  ) {
    this.limit = Number.isFinite(maxResults)
      ? Math.max(0, Math.floor(maxResults))
      : 0;
  }

  considerEntryId(entryId: PathEntryId, score: number | undefined): void {
    const inputIndex = this.inputIndex++;
    if (score === undefined || this.limit === 0) {
      return;
    }
    const kind = this.catalog.entryKindById(entryId);
    const relativePath = this.catalog.entryRelativePathById(entryId);
    if (kind === undefined || relativePath === undefined) {
      return;
    }
    this.considerValues(entryId, undefined, kind, relativePath, score, inputIndex);
  }

  considerEntry(entry: PathEntry, score: number | undefined): void {
    const inputIndex = this.inputIndex++;
    if (score === undefined || this.limit === 0) {
      return;
    }
    this.considerValues(
      undefined,
      entry,
      entry.kind,
      entry.relativePath,
      score,
      inputIndex,
    );
  }

  results(): PathEntry[] {
    const results: PathEntry[] = [];
    for (const candidate of [...this.heap].sort(compareCandidates)) {
      const entry = candidate.entry ??
        (candidate.entryId === undefined
          ? undefined
          : this.catalog.getEntryById(candidate.entryId));
      if (entry) {
        results.push(entry);
      }
    }
    return results;
  }

  private considerValues(
    entryId: PathEntryId | undefined,
    entry: PathEntry | undefined,
    kind: PathEntry['kind'],
    relativePath: string,
    score: number,
    inputIndex: number,
  ): void {
    if (this.heap.length < this.limit) {
      this.pushWorstFirst({ entryId, entry, kind, relativePath, score, inputIndex });
      return;
    }
    if (!candidateValuesAreBetter(
      score,
      kind,
      relativePath,
      inputIndex,
      this.heap[0],
    )) {
      return;
    }
    this.heap[0] = { entryId, entry, kind, relativePath, score, inputIndex };
    this.siftWorstDown();
  }

  private pushWorstFirst(candidate: RankedCandidate): void {
    this.heap.push(candidate);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (compareCandidates(this.heap[index], this.heap[parentIndex]) <= 0) {
        return;
      }
      [this.heap[index], this.heap[parentIndex]] =
        [this.heap[parentIndex], this.heap[index]];
      index = parentIndex;
    }
  }

  private siftWorstDown(): void {
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let worstIndex = index;
      if (
        leftIndex < this.heap.length &&
        compareCandidates(this.heap[leftIndex], this.heap[worstIndex]) > 0
      ) {
        worstIndex = leftIndex;
      }
      if (
        rightIndex < this.heap.length &&
        compareCandidates(this.heap[rightIndex], this.heap[worstIndex]) > 0
      ) {
        worstIndex = rightIndex;
      }
      if (worstIndex === index) {
        return;
      }
      [this.heap[index], this.heap[worstIndex]] =
        [this.heap[worstIndex], this.heap[index]];
      index = worstIndex;
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function searchPaths(request: PathSearchRequest): Promise<void> {
  const normalizedQuery = normalizeSearchQuery(request.query);
  const normalizedCandidateQuery = candidateQueryForRequest(
    normalizedQuery,
    request.globalPathQuery === true,
  );
  const normalizedScope = normalizeSearchText(request.scopePath).replace(/\/$/, '');
  const ranker = new IndexedTopKRanker(request.catalog, request.maxResults);
  const seenEntryIds = new Set<PathEntryId>();
  const reusableCandidateIds: PathEntryId[] = [];
  const now = request.now ?? Date.now();
  let inspectedCandidates = 0;
  let processedCandidates = 0;
  let truncated = false;

  for (const usage of request.recentPaths) {
    if (request.workspaceUri && usage.entry.workspaceUri !== request.workspaceUri) {
      continue;
    }
    const identity = pathIdentity(usage.entry);
    const entryId = request.catalog.getEntryId(identity);
    if (entryId !== undefined) {
      if (!kindIsIncluded(request.catalog.entryKindById(entryId), request)) {
        continue;
      }
      if (!request.catalog.isEntryIdWithinNormalizedScope(
        entryId,
        normalizedScope,
        normalizedQuery.length === 0,
      )) {
        continue;
      }
      const score = request.catalog.scoreEntryById(
        entryId,
        normalizedQuery,
        request.fuzzyMatching !== false,
      );
      if (score === undefined) {
        continue;
      }
      seenEntryIds.add(entryId);
      ranker.considerEntryId(entryId, score + usageScoreBoost(usage, now));
      reusableCandidateIds.push(entryId);
      continue;
    }
    if (
      !request.allowUnindexedRecentPaths ||
      !entryKindIsIncluded(usage.entry, request) ||
      !recentPathBelongsToRequest(
        usage.entry,
        request.scopePath,
        normalizedQuery.length,
        request.workspaceUri,
      )
    ) {
      continue;
    }
    const score = scorePathWithNormalizedQuery(
      usage.entry,
      normalizedQuery,
      request.fuzzyMatching !== false,
    );
    if (score !== undefined) {
      ranker.considerEntry(usage.entry, score + usageScoreBoost(usage, now));
    }
  }

  const publish = (complete: boolean): void => {
    request.onProgress({
      entries: ranker.results(),
      complete,
      processedCandidates,
      truncated,
      reusableCandidateIds: complete ? reusableCandidateIds : undefined,
    });
  };

  publish(false);
  if (request.isCancelled()) {
    return;
  }

  const startedAt = performance.now();
  let sliceStartedAt = startedAt;
  let lastPublishedAt = startedAt;
  const maxCandidates = effectiveCandidateLimit(
    normalizedCandidateQuery.length,
    request.maxCandidates,
  );
  const timeBudgetMs = Number.isFinite(request.timeBudgetMs)
    ? Math.max(0, request.timeBudgetMs)
    : 150;
  const sources = candidateSources(
    request.catalog,
    normalizedCandidateQuery,
    normalizedQuery,
    request.globalPathQuery === true,
    request.scopePath,
    request.workspaceUri,
    request.reuse,
  );

  for (const entryId of combineCandidates(sources)) {
    inspectedCandidates += 1;
    if (inspectedCandidates % CANCELLATION_CHECK_INTERVAL === 0) {
      const currentTime = performance.now();
      if (request.isCancelled()) {
        return;
      }
      if (currentTime - startedAt >= timeBudgetMs) {
        truncated = true;
        break;
      }
      if (
        request.publishIntermediateResults === true &&
        currentTime - lastPublishedAt >= SEARCH_PROGRESS_INTERVAL_MS
      ) {
        publish(false);
        lastPublishedAt = currentTime;
      }
      if (currentTime - sliceStartedAt >= SEARCH_SLICE_MS) {
        await yieldToEventLoop();
        sliceStartedAt = performance.now();
        if (request.isCancelled()) {
          return;
        }
      }
    }

    if (seenEntryIds.has(entryId)) {
      continue;
    }
    seenEntryIds.add(entryId);
    if (!kindIsIncluded(request.catalog.entryKindById(entryId), request)) {
      continue;
    }

    const directChildrenOnly = normalizedQuery.length === 0;
    if (
      !request.catalog.isEntryIdWithinNormalizedScope(
        entryId,
        normalizedScope,
        directChildrenOnly,
      )
    ) {
      continue;
    }

    if (processedCandidates >= maxCandidates) {
      truncated = true;
      break;
    }
    processedCandidates += 1;
    const score = request.catalog.scoreEntryById(
      entryId,
      normalizedQuery,
      request.fuzzyMatching !== false,
    );
    ranker.considerEntryId(entryId, score);
    if (score !== undefined) {
      reusableCandidateIds.push(entryId);
    }
  }

  if (!request.isCancelled()) {
    publish(true);
  }
}
