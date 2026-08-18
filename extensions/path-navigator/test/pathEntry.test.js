const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCompactPathEntry,
  createPathEntry,
  createPathWorkspaceMetadata,
} = require('../dist/pathEntry');
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

test('compact entries inherit shared workspace metadata without own duplicates', () => {
  const workspace = createPathWorkspaceMetadata('Demo', 'file:///workspace');
  const entry = createCompactPathEntry({
    kind: 'file',
    name: 'Main.PY',
    relativePath: 'SRC/Main.PY',
    workspaceName: workspace.workspaceName,
    workspaceUri: workspace.workspaceUri,
  }, workspace);

  assert.equal(entry.workspaceName, 'Demo');
  assert.equal(entry.workspaceUri, 'file:///workspace');
  assert.equal(entry.normalizedPath, 'src/main.py');
  assert.equal(Object.hasOwn(entry, 'workspaceName'), false);
  assert.equal(Object.hasOwn(entry, 'workspaceUri'), false);
  assert.equal(Object.hasOwn(entry, 'normalizedName'), false);
});
