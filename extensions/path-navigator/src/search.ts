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

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
}

function compactQuery(value: string): string {
  return normalize(value).replace(/\s+/g, '');
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
  const normalizedPath = normalize(relativePath);
  const separatorIndex = normalizedPath.lastIndexOf('/');
  const parentPath = separatorIndex < 0 ? '' : normalizedPath.slice(0, separatorIndex);
  return parentPath === normalize(scopePath);
}

export function isDescendantOfScope(relativePath: string, scopePath: string): boolean {
  const normalizedPath = normalize(relativePath);
  const normalizedScope = normalize(scopePath).replace(/\/$/, '');
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
  const query = compactQuery(rawQuery);
  if (!query) {
    return item.kind === 'directory' ? 10 : 0;
  }

  const path = normalize(item.relativePath);
  const name = normalize(item.name);
  const workspace = normalize(item.workspaceName);
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

export function rankPaths<T extends SearchablePath>(
  items: readonly T[],
  query: string,
  maxResults: number,
): RankedPath<T>[] {
  return items
    .map((item) => ({ item, score: scorePath(item, query) }))
    .filter((result): result is RankedPath<T> => result.score !== undefined)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.item.kind !== right.item.kind) {
        return left.item.kind === 'directory' ? -1 : 1;
      }
      return left.item.relativePath.localeCompare(right.item.relativePath);
    })
    .slice(0, maxResults);
}
