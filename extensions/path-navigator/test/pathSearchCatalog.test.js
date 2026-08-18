const assert = require('node:assert/strict');
const test = require('node:test');
const { PathSearchCatalog } = require('../dist/pathSearchCatalog');

function entry(relativePath, kind = 'file', workspaceUri = 'file:///workspace') {
  return {
    uri: { toString: () => `${workspaceUri}/${relativePath}` },
    kind,
    name: relativePath.split('/').at(-1),
    relativePath,
    workspaceName: workspaceUri.split('/').at(-1),
    workspaceUri,
  };
}

function paths(iterable) {
  return [...iterable].map(({ relativePath }) => relativePath);
}

test('catalog returns direct children without scanning descendants', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries([
    entry('src', 'directory'),
    entry('src/components', 'directory'),
    entry('src/components/Button.tsx'),
    entry('src/index.ts'),
  ]);

  assert.deepEqual(paths(catalog.directChildren('src')).sort(), [
    'src/components',
    'src/index.ts',
  ]);
});

test('catalog provides exact, prefix, and n-gram candidate pools', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries([
    entry('src/main.py'),
    entry('src/file.ts'),
    entry('src/result.ts'),
  ]);

  assert.deepEqual(paths(catalog.exactNameCandidates('main.py')), ['src/main.py']);
  assert.deepEqual(paths(catalog.prefixCandidates('mai')), ['src/main.py']);
  assert.deepEqual(paths(catalog.bigramCandidates('ile')), ['src/file.ts']);
  assert.deepEqual(paths(catalog.ngramCandidates('main')), ['src/main.py']);
  assert.deepEqual(paths(catalog.intersectingNgramCandidates('main')), ['src/main.py']);
});

test('catalog keeps workspace candidate pools isolated', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries([
    entry('src/main.py', 'file', 'file:///alpha'),
    entry('src/main.py', 'file', 'file:///beta'),
  ]);

  assert.equal(paths(catalog.workspaceCandidates()).length, 2);
  assert.deepEqual(paths(catalog.workspaceCandidates('file:///beta')), ['src/main.py']);
});

test('catalog checks descendant and direct-child scopes', () => {
  const catalog = new PathSearchCatalog();
  const direct = entry('src/index.ts');
  const nested = entry('src/components/Button.tsx');
  catalog.addEntries([direct, nested]);

  assert.equal(catalog.isWithinScope(direct, 'src', true), true);
  assert.equal(catalog.isWithinScope(nested, 'src', true), false);
  assert.equal(catalog.isWithinScope(nested, 'src'), true);
  assert.equal(catalog.isWithinScope(nested, 'test'), false);
});

test('catalog revision changes only when new entries are accepted', () => {
  const catalog = new PathSearchCatalog();
  const otherCatalog = new PathSearchCatalog();
  const file = entry('src/index.ts');

  assert.notEqual(catalog.instanceId, otherCatalog.instanceId);
  assert.equal(catalog.revision, 0);
  catalog.addEntries([file]);
  assert.equal(catalog.revision, 1);
  catalog.addEntries([file]);
  assert.equal(catalog.revision, 1);
  catalog.addEntries([entry('src/other.ts')]);
  assert.equal(catalog.revision, 2);
});

test('catalog removes a directory subtree without leaking tombstoned results', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries([
    entry('src', 'directory'),
    entry('src/components', 'directory'),
    entry('src/components/Button.tsx'),
    entry('src/index.ts'),
    entry('README.md'),
  ]);
  catalog.seal();

  assert.equal(catalog.removePath('file:///workspace', 'src', true), 4);
  assert.deepEqual(paths(catalog.workspaceCandidates()), ['README.md']);
  assert.deepEqual(paths(catalog.prefixCandidates('but')), []);
  assert.equal(catalog.size, 1);
  assert.ok(catalog.tombstoneRatio > 0.5);
});

test('sealed posting lists accept incremental additions', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries(
    Array.from({ length: 64 }, (_, index) => entry(`src/common-${index}.ts`)),
  );
  catalog.seal();
  catalog.addEntries([entry('src/common-late.ts')]);

  assert.equal(paths(catalog.prefixCandidates('com')).length, 65);
  assert.equal(catalog.getEntryByPath('file:///workspace', 'src/common-late.ts').name, 'common-late.ts');
});

test('catalog preserves paths that differ only by case on case-sensitive workspaces', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries([
    entry('src/Foo.ts'),
    entry('src/foo.ts'),
  ]);

  assert.equal(catalog.size, 2);
  assert.equal(catalog.getEntryByPath('file:///workspace', 'src/Foo.ts').relativePath, 'src/Foo.ts');
  assert.equal(catalog.getEntryByPath('file:///workspace', 'src/foo.ts').relativePath, 'src/foo.ts');
  assert.deepEqual(paths(catalog.exactNameCandidates('foo.ts')).sort(), [
    'src/Foo.ts',
    'src/foo.ts',
  ]);
});

test('numeric candidate APIs preserve the same candidate membership', () => {
  const catalog = new PathSearchCatalog();
  catalog.addEntries([
    entry('src/main.py'),
    entry('src/domain.py'),
    entry('src/result.ts'),
  ]);

  const idPaths = (ids) => [...ids].map((id) => catalog.getEntryById(id).relativePath);
  assert.deepEqual(idPaths(catalog.prefixCandidateIds('mai')), ['src/main.py']);
  assert.deepEqual(
    idPaths(catalog.intersectingNgramCandidateIds('main')),
    paths(catalog.intersectingNgramCandidates('main')),
  );
  assert.equal(catalog.capacity, 3);
});
