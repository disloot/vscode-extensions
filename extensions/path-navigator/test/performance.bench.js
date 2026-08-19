/* Run with: node --expose-gc test/performance.bench.js [entry-count] */
const { performance } = require('node:perf_hooks');
const {
  createCompactPathEntry,
  createPathWorkspaceMetadata,
} = require('../dist/pathEntry');
const { PartitionedPathSearchCatalog } = require('../dist/pathSearchCatalog');
const { searchPaths } = require('../dist/pathSearchEngine');

const entryCount = Number(process.argv[2] ?? 100_000);
const workspaceUri = 'file:///benchmark';
const workspaceName = 'benchmark';
const workspaceMetadata = createPathWorkspaceMetadata(workspaceName, workspaceUri);

function memorySnapshot() {
  global.gc?.();
  const usage = process.memoryUsage();
  return {
    heapMiB: usage.heapUsed / 1024 / 1024,
    arrayBuffersMiB: usage.arrayBuffers / 1024 / 1024,
    rssMiB: usage.rss / 1024 / 1024,
  };
}

async function main() {
  const baseline = memorySnapshot();
  const catalog = new PartitionedPathSearchCatalog();
  const catalogStartedAt = performance.now();
  let inputCreationMs = 0;
  const batchSize = 5_000;
  for (let batchStart = 0; batchStart < entryCount; batchStart += batchSize) {
    const inputStartedAt = performance.now();
    const batch = [];
    for (let index = batchStart; index < Math.min(entryCount, batchStart + batchSize); index += 1) {
      const group = Math.floor(index / 1_000);
      const relativePath = `packages/group-${group}/component-${index}/main-${index}.ts`;
      batch.push(createCompactPathEntry({
        kind: 'file',
        name: `main-${index}.ts`,
        relativePath,
        workspaceName,
        workspaceUri,
        normalizedWorkspaceName: workspaceName,
      }, workspaceMetadata));
    }
    inputCreationMs += performance.now() - inputStartedAt;
    catalog.addEntries(batch);
  }
  catalog.seal();
  const totalBuildMs = performance.now() - catalogStartedAt;
  const catalogBuildMs = totalBuildMs - inputCreationMs;
  const retained = memorySnapshot();

  const searchStartedAt = performance.now();
  let finalResult;
  await searchPaths({
    catalog,
    scopePath: '',
    query: 'main-999',
    maxResults: 50,
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
    retainedHeapMiB: Number((retained.heapMiB - baseline.heapMiB).toFixed(2)),
    retainedArrayBuffersMiB: Number(
      (retained.arrayBuffersMiB - baseline.arrayBuffersMiB).toFixed(2),
    ),
    retainedIndexMemoryMiB: Number((
      retained.heapMiB - baseline.heapMiB +
      retained.arrayBuffersMiB - baseline.arrayBuffersMiB
    ).toFixed(2)),
    rssGrowthMiB: Number((retained.rssMiB - baseline.rssMiB).toFixed(2)),
    inputCreationMs: Number(inputCreationMs.toFixed(2)),
    catalogBuildMs: Number(catalogBuildMs.toFixed(2)),
    totalBuildMs: Number(totalBuildMs.toFixed(2)),
    searchMs: Number((performance.now() - searchStartedAt).toFixed(2)),
    searchResults: finalResult?.entries.length ?? 0,
    processedCandidates: finalResult?.processedCandidates ?? 0,
    truncated: finalResult?.truncated ?? false,
  }, null, 2));
}

void main();
