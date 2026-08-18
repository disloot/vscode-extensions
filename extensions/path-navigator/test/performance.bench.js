/* Run with: node --expose-gc test/performance.bench.js [entry-count] */
const { performance } = require('node:perf_hooks');
const { createPathEntry } = require('../dist/pathEntry');
const { PathSearchCatalog } = require('../dist/pathSearchCatalog');
const { searchPaths } = require('../dist/pathSearchEngine');

const entryCount = Number(process.argv[2] ?? 100_000);
const workspaceUri = 'file:///benchmark';
const workspaceName = 'benchmark';

function heapMiB() {
  global.gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

async function main() {
  const baselineHeap = heapMiB();
  const entries = Array.from({ length: entryCount }, (_, index) => {
    const group = Math.floor(index / 1_000);
    const relativePath = `packages/group-${group}/component-${index}/main-${index}.ts`;
    return createPathEntry({
      kind: 'file',
      name: `main-${index}.ts`,
      relativePath,
      workspaceName,
      workspaceUri,
      normalizedWorkspaceName: workspaceName,
    });
  });
  const entryHeap = heapMiB();
  const catalog = new PathSearchCatalog();
  const catalogStartedAt = performance.now();
  catalog.addEntries(entries);
  catalog.seal();
  const catalogBuildMs = performance.now() - catalogStartedAt;
  const catalogHeap = heapMiB();

  const searchStartedAt = performance.now();
  let finalResult;
  await searchPaths({
    catalog,
    scopePath: '',
    query: 'main-999',
    maxResults: 200,
    maxCandidates: 10_000,
    timeBudgetMs: 2_000,
    recentPaths: [],
    allowUnindexedRecentPaths: false,
    isCancelled: () => false,
    onProgress: (progress) => {
      if (progress.complete) {
        finalResult = progress;
      }
    },
  });

  console.log(JSON.stringify({
    entryCount,
    entryHeapMiB: Number((entryHeap - baselineHeap).toFixed(2)),
    catalogHeapMiB: Number((catalogHeap - entryHeap).toFixed(2)),
    totalHeapMiB: Number((catalogHeap - baselineHeap).toFixed(2)),
    catalogBuildMs: Number(catalogBuildMs.toFixed(2)),
    searchMs: Number((performance.now() - searchStartedAt).toFixed(2)),
    searchResults: finalResult?.entries.length ?? 0,
    processedCandidates: finalResult?.processedCandidates ?? 0,
    truncated: finalResult?.truncated ?? false,
  }, null, 2));
}

void main();
