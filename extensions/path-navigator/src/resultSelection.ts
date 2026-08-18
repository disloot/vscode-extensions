export interface IdentifiedPath {
  readonly kind: 'file' | 'directory';
  readonly relativePath: string;
  readonly workspaceUri: string;
}

export class ResultUpdateGate<T> {
  private frozen = false;
  private deferredEntries: readonly T[] | undefined;

  get isFrozen(): boolean {
    return this.frozen;
  }

  get latestDeferredEntries(): readonly T[] | undefined {
    return this.deferredEntries;
  }

  reset(): void {
    this.frozen = false;
    this.deferredEntries = undefined;
  }

  freeze(): void {
    this.frozen = true;
  }

  shouldApply(entries: readonly T[]): boolean {
    if (this.frozen) {
      this.deferredEntries = entries;
      return false;
    }

    this.deferredEntries = undefined;
    return true;
  }
}

export function pathIdentity(entry: IdentifiedPath): string {
  return `${entry.workspaceUri}\0${entry.kind}\0${entry.relativePath}`;
}

export function pinActivePath<T extends IdentifiedPath>(
  entries: readonly T[],
  activeEntry: T | undefined,
  maxResults: number,
): T[] {
  if (maxResults <= 0) {
    return [];
  }

  const visibleEntries = entries.slice(0, maxResults);
  if (!activeEntry) {
    return visibleEntries;
  }

  const activeIdentity = pathIdentity(activeEntry);
  if (visibleEntries.some((entry) => pathIdentity(entry) === activeIdentity)) {
    return visibleEntries;
  }

  if (visibleEntries.length < maxResults) {
    return [...visibleEntries, activeEntry];
  }

  return [...visibleEntries.slice(0, -1), activeEntry];
}

export function restoredActiveIndex(
  entries: readonly IdentifiedPath[],
  activeIdentity: string | undefined,
  previousIndex: number,
): number {
  if (entries.length === 0) {
    return -1;
  }

  if (activeIdentity) {
    const matchingIndex = entries.findIndex((entry) => pathIdentity(entry) === activeIdentity);
    if (matchingIndex >= 0) {
      return matchingIndex;
    }
  }

  return previousIndex >= 0 ? Math.min(previousIndex, entries.length - 1) : 0;
}
