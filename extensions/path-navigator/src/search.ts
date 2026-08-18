export interface SearchablePath {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
}

export interface RankedPath<T extends SearchablePath> {
  readonly item: T;
  readonly score: number;
}

export interface ParsedPathInput {
  readonly scopePath: string;
  readonly query: string;
}

interface HeapPath<T extends SearchablePath> extends RankedPath<T> {
  readonly inputIndex: number;
}

export function normalizeSearchText(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
}

export function normalizeSearchQuery(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

export function parsePathInput(value: string): ParsedPathInput {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');

  if (separatorIndex < 0) {
    return { scopePath: '', query: normalized };
  }

  return {
    scopePath: normalized.slice(0, separatorIndex),
    query: normalized.slice(separatorIndex + 1),
  };
}

export function isDirectChild(relativePath: string, scopePath: string): boolean {
  const normalizedPath = normalizeSearchText(relativePath);
  const separatorIndex = normalizedPath.lastIndexOf('/');
  const parentPath = separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex);
  return parentPath === normalizeSearchText(scopePath);
}

export function isDescendantOfScope(relativePath: string, scopePath: string): boolean {
  const normalizedPath = normalizeSearchText(relativePath);
  const normalizedScope = normalizeSearchText(scopePath).replace(/\/$/, '');
  return normalizedScope.length === 0 || normalizedPath.startsWith(`${normalizedScope}/`);
}

function subsequenceScore(candidate: string, query: string): number | undefined {
  let candidateIndex = 0;
  let previousMatch = -2;
  let score = 0;

  for (const queryCharacter of query) {
    const matchIndex = candidate.indexOf(queryCharacter, candidateIndex);
    if (matchIndex < 0) {
      return undefined;
    }

    score += matchIndex === previousMatch + 1 ? 24 : 6;
    if (matchIndex === 0 || candidate[matchIndex - 1] === '/') {
      score += 35;
    }

    previousMatch = matchIndex;
    candidateIndex = matchIndex + 1;
  }

  return score - candidate.length * 0.15;
}

export function scorePath(item: SearchablePath, rawQuery: string): number | undefined {
  return scorePathWithNormalizedQuery(item, normalizeSearchQuery(rawQuery));
}

export function scorePathWithNormalizedQuery(
  item: SearchablePath,
  query: string,
): number | undefined {
  if (!query) {
    return item.kind === 'directory' ? 10 : 0;
  }

  const path = normalizeSearchText(item.relativePath);
  const name = normalizeSearchText(item.name);
  const workspace = normalizeSearchText(item.workspaceName);
  const searchablePath = `${workspace}/${path}`;

  if (path === query || searchablePath === query) {
    return 10_000;
  }
  if (path.startsWith(query)) {
    return 9_000 - path.length;
  }
  if (name === query) {
    return 8_500;
  }
  if (name.startsWith(query)) {
    return 8_000 - name.length;
  }

  const segmentIndex = path.indexOf(`/${query}`);
  if (segmentIndex >= 0) {
    return 7_500 - segmentIndex - path.length * 0.1;
  }

  const pathIndex = path.indexOf(query);
  if (pathIndex >= 0) {
    return 7_000 - pathIndex - path.length * 0.1;
  }

  const workspacePathIndex = searchablePath.indexOf(query);
  if (workspacePathIndex >= 0) {
    return 6_500 - workspacePathIndex - searchablePath.length * 0.1;
  }

  return subsequenceScore(searchablePath, query);
}

function compareRankedPaths<T extends SearchablePath>(
  left: HeapPath<T>,
  right: HeapPath<T>,
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (left.item.kind !== right.item.kind) {
    return left.item.kind === 'directory' ? -1 : 1;
  }
  const pathComparison = left.item.relativePath.localeCompare(right.item.relativePath);
  return pathComparison !== 0 ? pathComparison : left.inputIndex - right.inputIndex;
}

function isWorse<T extends SearchablePath>(left: HeapPath<T>, right: HeapPath<T>): boolean {
  return compareRankedPaths(left, right) > 0;
}

function pushWorstFirst<T extends SearchablePath>(heap: HeapPath<T>[], value: HeapPath<T>): void {
  heap.push(value);
  let index = heap.length - 1;

  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (!isWorse(heap[index], heap[parentIndex])) {
      return;
    }
    [heap[index], heap[parentIndex]] = [heap[parentIndex], heap[index]];
    index = parentIndex;
  }
}

function replaceWorst<T extends SearchablePath>(heap: HeapPath<T>[], value: HeapPath<T>): void {
  heap[0] = value;
  let index = 0;

  while (true) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    let worstIndex = index;

    if (leftIndex < heap.length && isWorse(heap[leftIndex], heap[worstIndex])) {
      worstIndex = leftIndex;
    }
    if (rightIndex < heap.length && isWorse(heap[rightIndex], heap[worstIndex])) {
      worstIndex = rightIndex;
    }
    if (worstIndex === index) {
      return;
    }

    [heap[index], heap[worstIndex]] = [heap[worstIndex], heap[index]];
    index = worstIndex;
  }
}

export class TopKPathRanker<T extends SearchablePath> {
  private readonly bestResults: HeapPath<T>[] = [];
  private readonly limit: number;
  private inputIndex = 0;

  constructor(maxResults: number) {
    this.limit = Number.isFinite(maxResults)
      ? Math.max(0, Math.floor(maxResults))
      : 0;
  }

  consider(item: T, score: number | undefined): void {
    const inputIndex = this.inputIndex;
    this.inputIndex += 1;
    if (score === undefined || this.limit === 0) {
      return;
    }

    const candidate: HeapPath<T> = { item, score, inputIndex };
    if (this.bestResults.length < this.limit) {
      pushWorstFirst(this.bestResults, candidate);
    } else if (compareRankedPaths(candidate, this.bestResults[0]) < 0) {
      replaceWorst(this.bestResults, candidate);
    }
  }

  results(): RankedPath<T>[] {
    return [...this.bestResults]
      .sort(compareRankedPaths)
      .map(({ item, score }) => ({ item, score }));
  }
}

export function rankPaths<T extends SearchablePath>(
  items: Iterable<T>,
  query: string,
  maxResults: number,
): RankedPath<T>[] {
  const ranker = new TopKPathRanker<T>(maxResults);
  const normalizedQuery = normalizeSearchQuery(query);
  for (const item of items) {
    ranker.consider(item, scorePathWithNormalizedQuery(item, normalizedQuery));
  }
  return ranker.results();
}
