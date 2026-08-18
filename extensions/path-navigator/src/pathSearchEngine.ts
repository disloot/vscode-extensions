import type { PathEntry } from './pathEntry';
import { PathSearchCatalog, type PathEntryId } from './pathSearchCatalog';
import { pathIdentity } from './resultSelection';
import {
  isDescendantOfScope,
  isDirectChild,
  normalizeSearchQuery,
  normalizeSearchText,
  scorePathWithNormalizedQuery,
  TopKPathRanker,
} from './search';

export interface PathUsage {
  readonly entry: PathEntry;
  readonly lastOpenedAt: number;
  readonly openCount: number;
  readonly pinned?: boolean;
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
  readonly catalog: PathSearchCatalog;
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
  return pinnedBoost + Math.min(300, frequencyBoost + recencyBoost);
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
  catalog: PathSearchCatalog,
  normalizedQuery: string,
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
  const ranker = new TopKPathRanker<PathEntry>(request.maxResults);
  const seenEntryIds = new Uint8Array(request.catalog.capacity);
  const reusableCandidateIds: PathEntryId[] = [];
  const now = request.now ?? Date.now();
  let inspectedCandidates = 0;
  let processedCandidates = 0;
  let truncated = false;

  for (const usage of request.recentPaths) {
    const identity = pathIdentity(usage.entry);
    const entryId = request.catalog.getEntryId(identity);
    const entry =
      (entryId === undefined ? undefined : request.catalog.getEntryById(entryId)) ??
      (request.allowUnindexedRecentPaths ? usage.entry : undefined);
    if (!entry) {
      continue;
    }
    if (!entryKindIsIncluded(entry, request)) {
      continue;
    }
    if (
      !recentPathBelongsToRequest(
        entry,
        request.scopePath,
        normalizedQuery.length,
        request.workspaceUri,
      )
    ) {
      continue;
    }
    const score = scorePathWithNormalizedQuery(
      entry,
      normalizedQuery,
      request.fuzzyMatching !== false,
    );
    if (score === undefined) {
      continue;
    }
    if (entryId !== undefined) {
      seenEntryIds[entryId] = 1;
    }
    ranker.consider(entry, score + usageScoreBoost(usage, now));
    if (entryId !== undefined) {
      reusableCandidateIds.push(entryId);
    }
  }

  const publish = (complete: boolean): void => {
    request.onProgress({
      entries: ranker.results().map(({ item }) => item),
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

    if (seenEntryIds[entryId] !== 0) {
      continue;
    }
    seenEntryIds[entryId] = 1;
    const entry = request.catalog.getEntryById(entryId);
    if (!entry || !entryKindIsIncluded(entry, request)) {
      continue;
    }

    const directChildrenOnly = normalizedQuery.length === 0;
    if (
      !request.catalog.isWithinNormalizedScope(entry, normalizedScope, directChildrenOnly)
    ) {
      continue;
    }

    if (processedCandidates >= maxCandidates) {
      truncated = true;
      break;
    }
    processedCandidates += 1;
    const score = scorePathWithNormalizedQuery(
      entry,
      normalizedQuery,
      request.fuzzyMatching !== false,
    );
    ranker.consider(entry, score);
    if (score !== undefined) {
      reusableCandidateIds.push(entryId);
    }
  }

  if (!request.isCancelled()) {
    publish(true);
  }
}
