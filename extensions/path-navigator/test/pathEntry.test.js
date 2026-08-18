const assert = require('node:assert/strict');
const test = require('node:test');
const { createPathEntry } = require('../dist/pathEntry');
const { pathIdentity } = require('../dist/resultSelection');

test('creates reusable normalized search metadata and derives a stable identity', () => {
  const entry = createPathEntry({
    uri: { toString: () => 'file:///workspace/SRC/Main.PY' },
    kind: 'file',
    name: 'Main.PY',
    relativePath: 'SRC/Main.PY',
    workspaceName: 'Demo',
    workspaceUri: 'file:///workspace',
  });

  assert.equal(entry.normalizedName, 'main.py');
  assert.equal(entry.normalizedPath, 'src/main.py');
  assert.equal(entry.normalizedWorkspaceName, 'demo');
  assert.equal(entry.searchIdentity, undefined);
  assert.equal(pathIdentity(entry), 'file:///workspace\0file\0SRC/Main.PY');
});
