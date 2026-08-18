const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hasExcludedFileExtension,
  normalizeExcludedFileExtensions,
} = require('../dist/pathFilters');

test('normalizes excluded file extensions', () => {
  assert.deepEqual(
    [...normalizeExcludedFileExtensions(['log', '.MAP', ' ', '.test.ts'])],
    ['.log', '.map', '.test.ts'],
  );
});

test('matches simple and compound file extensions case-insensitively', () => {
  const extensions = normalizeExcludedFileExtensions(['log', '.test.ts']);

  assert.equal(hasExcludedFileExtension('server.log', extensions), true);
  assert.equal(hasExcludedFileExtension('button.test.ts', extensions), true);
  assert.equal(hasExcludedFileExtension('button.ts', extensions), false);
});
