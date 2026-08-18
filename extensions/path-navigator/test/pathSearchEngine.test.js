const assert = require('node:assert/strict');
const test = require('node:test');
const { PathSearchCatalog } = require('../dist/pathSearchCatalog');
const { searchPaths } = require('../dist/pathSearchEngine');

function entry(relativePath, kind = 'file', workspaceUri = 'file:///workspace') {
  return {
    uri: { toString: () => `${workspaceUri}/${relativePath}` },
    kind,
    name: relativePath.split('/').at(-1),
    relativePath,
    workspaceName: 'demo',
    workspaceUri,
  };
}

async function search(entries, overrides = {}) {
  const catalog = new PathSearchCatalog();
  catalog.addEntries(entries);
  const progress = [];
  await searchPaths({
    catalog,
    scopePath: '',
    query: '',
    maxResults: 200,
    maxCandidates: 10_000,
    timeBudgetMs: 1_000,
    recentPaths: [],
    allowUnindexedRecentPaths: false,
    isCancelled: () => false,
    onProgress: (value) => progress.push(value),
    ...overrides,
  });
  return progress;
}

test('empty queries return only direct children', async () => {
  const progress = await search([
    entry('src', 'directory'),
    entry('src/index.ts'),
    entry('README.md'),
  ]);
  const final = progress.at(-1);

  assert.deepEqual(final.entries.map(({ relativePath }) => relativePath), ['src', 'README.md']);
});

test('one-character queries use the name-prefix pool', async () => {
  const progress = await search(
    [entry('src/main.py'), entry('src/domain.py'), entry('src/readme.md')],
    { query: 'm' },
  );
  const paths = progress.at(-1).entries.map(({ relativePath }) => relativePath);

  assert.deepEqual(paths, ['src/main.py']);
});

test('two-character queries use continuous substring candidates', async () => {
  const progress = await search(
    [entry('src/file.ts'), entry('src/final.ts'), entry('src/profile.ts')],
    { query: 'il' },
  );
  const paths = progress.at(-1).entries.map(({ relativePath }) => relativePath);

  assert.equal(paths.includes('src/file.ts'), true);
  assert.equal(paths.includes('src/profile.ts'), true);
  assert.equal(paths.includes('src/final.ts'), false);
});

test('three-character queries retain capped fuzzy fallback matching', async () => {
  const progress = await search(
    [entry('src/components/Button.tsx'), entry('src/components/Input.tsx')],
    { query: 'sctbtn' },
  );

  assert.equal(progress.at(-1).entries[0].relativePath, 'src/components/Button.tsx');
});

test('recent and frequently opened paths receive a bounded ranking boost', async () => {
  const recent = entry('src/file-b.ts');
  const progress = await search([entry('src/file-a.ts'), recent], {
    query: 'file',
    maxResults: 1,
    recentPaths: [{ entry: recent, lastOpenedAt: 1_000, openCount: 8 }],
    now: 1_000,
  });

  assert.equal(progress.at(-1).entries[0].relativePath, 'src/file-b.ts');
});

test('candidate limits mark expanded searches as truncated', async () => {
  const progress = await search(
    [entry('src/file-a.ts'), entry('src/file-b.ts'), entry('src/file-c.ts')],
    { query: 'file', maxCandidates: 1 },
  );
  const final = progress.at(-1);

  assert.equal(final.processedCandidates, 1);
  assert.equal(final.truncated, true);
});

test('exact names enter the candidate pool before broad prefix limits', async () => {
  const exact = entry('src/target.ts');
  const entries = [
    ...Array.from({ length: 100 }, (_, index) => entry(`src/target-${index}.ts`)),
    exact,
  ];
  const progress = await search(entries, {
    query: 'target.ts',
    maxCandidates: 1,
    maxResults: 1,
  });

  assert.equal(progress.at(-1).entries[0].relativePath, 'src/target.ts');
});

test('time budgets stop expanded searches at a cancellation checkpoint', async () => {
  const entries = Array.from({ length: 1_000 }, (_, index) =>
    entry(`src/components/component-${index}.tsx`),
  );
  const progress = await search(entries, {
    query: 'component',
    maxCandidates: 1_000,
    timeBudgetMs: 0,
  });
  const final = progress.at(-1);

  assert.equal(final.truncated, true);
  assert.ok(final.processedCandidates < 1_000);
});

test('stale recent paths are omitted after the live index is complete', async () => {
  const stale = entry('src/deleted.ts');
  const progress = await search([entry('src/current.ts')], {
    query: 'deleted',
    recentPaths: [{ entry: stale, lastOpenedAt: 1_000, openCount: 10 }],
    now: 1_000,
    allowUnindexedRecentPaths: false,
  });

  assert.deepEqual(progress.at(-1).entries, []);
});

test('cached paths can appear before an in-progress index reaches them', async () => {
  const cached = entry('src/cached.ts');
  const progress = await search([], {
    query: 'cached',
    recentPaths: [{ entry: cached, lastOpenedAt: 1_000, openCount: 2 }],
    now: 1_000,
    allowUnindexedRecentPaths: true,
  });

  assert.equal(progress[0].entries[0].relativePath, 'src/cached.ts');
});

test('cancelled searches stop after publishing cached results', async () => {
  const cached = entry('src/cached.ts');
  const progress = await search([cached, entry('src/other.ts')], {
    query: 'cached',
    recentPaths: [{ entry: cached, lastOpenedAt: 1_000, openCount: 1 }],
    now: 1_000,
    isCancelled: () => true,
  });

  assert.equal(progress.length, 1);
  assert.equal(progress[0].entries[0].relativePath, 'src/cached.ts');
  assert.equal(progress[0].complete, false);
});
