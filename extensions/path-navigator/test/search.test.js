const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isDescendantOfScope,
  isDirectChild,
  parentDirectoryInput,
  parsePathInput,
  rankPaths,
  scorePath,
} = require('../dist/search');

function entry(relativePath, kind = 'file', workspaceName = 'demo') {
  const parts = relativePath.split('/');
  return {
    kind,
    name: parts.at(-1),
    relativePath,
    workspaceName,
  };
}

test('exact paths rank above partial paths', () => {
  const exact = entry('src/components');
  const partial = entry('packages/src/components-old');
  assert.ok(scorePath(exact, 'src/components') > scorePath(partial, 'src/components'));
});

test('normalizes Windows path separators', () => {
  assert.equal(scorePath(entry('src/components/Button.tsx'), 'src\\components\\button.tsx'), 10_000);
});

test('uses pre-normalized path metadata without changing ranking semantics', () => {
  const item = {
    ...entry('SRC/Components/Button.tsx', 'file', 'Demo'),
    normalizedName: 'button.tsx',
    normalizedPath: 'src/components/button.tsx',
    normalizedWorkspaceName: 'demo',
  };

  assert.equal(scorePath(item, 'src/components/button.tsx'), 10_000);
  assert.notEqual(scorePath(item, 'demo/src/components/button.tsx'), undefined);
});

test('supports fuzzy subsequence matching', () => {
  assert.notEqual(scorePath(entry('src/components/Button.tsx'), 'sctbtn'), undefined);
});

test('returns directories before files for equal empty-query scores', () => {
  const results = rankPaths(
    [entry('README.md'), entry('src', 'directory'), entry('package.json')],
    '',
    10,
  );
  assert.equal(results[0].item.relativePath, 'src');
});

test('limits the number of results', () => {
  const results = rankPaths(
    [entry('src/a.ts'), entry('src/b.ts'), entry('src/c.ts')],
    'src',
    2,
  );
  assert.equal(results.length, 2);
});

test('top-k ranking matches a complete reference sort', () => {
  const paths = Array.from({ length: 500 }, (_, index) =>
    entry(
      `${index % 9 === 0 ? 'src/components' : 'packages/module'}/${String(index).padStart(3, '0')}-file.ts`,
      index % 17 === 0 ? 'directory' : 'file',
      index % 2 === 0 ? 'alpha' : 'beta',
    ),
  );
  const query = 'file';
  const expected = paths
    .map((item, inputIndex) => ({ item, inputIndex, score: scorePath(item, query) }))
    .filter(({ score }) => score !== undefined)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.item.kind !== right.item.kind) {
        return left.item.kind === 'directory' ? -1 : 1;
      }
      const pathComparison = left.item.relativePath.localeCompare(right.item.relativePath);
      return pathComparison !== 0 ? pathComparison : left.inputIndex - right.inputIndex;
    })
    .slice(0, 25)
    .map(({ item }) => item.relativePath);

  assert.deepEqual(
    rankPaths(paths, query, 25).map(({ item }) => item.relativePath),
    expected,
  );
});

test('returns no ranked paths when the result limit is zero', () => {
  assert.deepEqual(rankPaths([entry('src/file.ts')], 'file', 0), []);
});

test('parses the current directory and query from path input', () => {
  assert.deepEqual(parsePathInput('abc/bcd/cd'), {
    scopePath: 'abc/bcd',
    query: 'cd',
  });
  assert.deepEqual(parsePathInput('abc/'), {
    scopePath: 'abc',
    query: '',
  });
});

test('moves a scoped query to its parent directory', () => {
  assert.equal(parentDirectoryInput('abc/bcd/query'), 'abc/');
  assert.equal(parentDirectoryInput('abc/bcd/'), 'abc/');
  assert.equal(parentDirectoryInput('abc/query'), '');
  assert.equal(parentDirectoryInput('query'), '');
});

test('recognizes only immediate children of the current directory', () => {
  assert.equal(isDirectChild('abc/bcd', 'abc'), true);
  assert.equal(isDirectChild('abc/file.ts', 'abc'), true);
  assert.equal(isDirectChild('abc/bcd/cde', 'abc'), false);
  assert.equal(isDirectChild('other/bcd', 'abc'), false);
});

test('recognizes every descendant inside the current search scope', () => {
  assert.equal(isDescendantOfScope('abc/bcd', 'abc'), true);
  assert.equal(isDescendantOfScope('abc/bcd/cde/file.ts', 'abc'), true);
  assert.equal(isDescendantOfScope('abc-other/file.ts', 'abc'), false);
  assert.equal(isDescendantOfScope('other/abc/file.ts', 'abc'), false);
  assert.equal(isDescendantOfScope('any/depth/file.ts', ''), true);
});

test('global name search can find a deeply nested file', () => {
  const paths = [
    entry('abc/bcd/cde/file.ts'),
    entry('other/result.ts'),
    entry('abc/bcd/fixture.ts'),
  ];
  const rootMatches = rankPaths(
    paths.filter((item) => isDescendantOfScope(item.relativePath, '')),
    'ile',
    10,
  );
  const scopedMatches = rankPaths(
    paths.filter((item) => isDescendantOfScope(item.relativePath, 'abc/bcd')),
    'ile',
    10,
  );

  assert.equal(rootMatches[0].item.relativePath, 'abc/bcd/cde/file.ts');
  assert.equal(scopedMatches[0].item.relativePath, 'abc/bcd/cde/file.ts');
  assert.equal(scopedMatches.some(({ item }) => item.relativePath.startsWith('other/')), false);
});
