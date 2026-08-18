import type { IndexingBackend } from './externalPathScanner';

export interface BackendPerformanceSample {
  readonly normalizedDurationMs: number;
  readonly samples: number;
}

export type StoredBackendPerformance = Record<string, BackendPerformanceSample>;
export type ExternalBackend = Exclude<IndexingBackend, 'workspaceFs' | 'auto'>;

export const DEFAULT_EXTERNAL_BACKEND_ORDER: readonly ExternalBackend[] = [
  'fd',
  'rg',
  'git',
];

function performanceKey(workspaceUri: string, backend: Exclude<IndexingBackend, 'auto'>): string {
  return `${workspaceUri}\0${backend}`;
}

export function rankExternalBackends(
  workspaceUri: string,
  performance: StoredBackendPerformance,
): ExternalBackend[] {
  return [...DEFAULT_EXTERNAL_BACKEND_ORDER].sort((left, right) => {
    const leftScore = performance[performanceKey(workspaceUri, left)]?.normalizedDurationMs;
    const rightScore = performance[performanceKey(workspaceUri, right)]?.normalizedDurationMs;
    if (leftScore === undefined && rightScore === undefined) {
      return DEFAULT_EXTERNAL_BACKEND_ORDER.indexOf(left) -
        DEFAULT_EXTERNAL_BACKEND_ORDER.indexOf(right);
    }
    if (leftScore === undefined) {
      return 1;
    }
    if (rightScore === undefined) {
      return -1;
    }
    return leftScore - rightScore;
  });
}

export function prefersWorkspaceFs(
  workspaceUri: string,
  performance: StoredBackendPerformance,
): boolean {
  const workspaceFsScore = performance[performanceKey(workspaceUri, 'workspaceFs')]
    ?.normalizedDurationMs;
  if (workspaceFsScore === undefined) {
    return false;
  }
  const externalScores = DEFAULT_EXTERNAL_BACKEND_ORDER
    .map((backend) => performance[performanceKey(workspaceUri, backend)]
      ?.normalizedDurationMs)
    .filter((score): score is number => score !== undefined);
  return externalScores.length === 0 || workspaceFsScore <= Math.min(...externalScores);
}

export function updateBackendPerformance(
  performance: StoredBackendPerformance,
  workspaceUri: string,
  backend: Exclude<IndexingBackend, 'auto'>,
  durationMs: number,
  pathCount: number,
): void {
  if (pathCount <= 0 || !Number.isFinite(durationMs)) {
    return;
  }
  const key = performanceKey(workspaceUri, backend);
  const normalizedDurationMs = durationMs * 100_000 / pathCount;
  const previous = performance[key];
  performance[key] = {
    normalizedDurationMs: previous
      ? previous.normalizedDurationMs * 0.7 + normalizedDurationMs * 0.3
      : normalizedDurationMs,
    samples: (previous?.samples ?? 0) + 1,
  };
}
