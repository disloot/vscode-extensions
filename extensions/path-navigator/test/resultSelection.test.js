const assert = require('node:assert/strict');
const test = require('node:test');
const {
  pathIdentity,
  pinActivePath,
  restoredActiveIndex,
  ResultUpdateGate,
  samePathOrder,
} = require('../dist/resultSelection');

function entry(relativePath, kind = 'file', workspaceUri = 'file:///workspace') {
  return { kind, relativePath, workspaceUri };
}

test('path identities distinguish workspace, kind, and relative path', () => {
  assert.notEqual(pathIdentity(entry('src', 'directory')), pathIdentity(entry('src', 'file')));
  assert.notEqual(
    pathIdentity(entry('src', 'directory')),
    pathIdentity(entry('src', 'directory', 'file:///other')),
  );
});

test('pins an active result that was pushed outside the result limit', () => {
  const active = entry('selected.ts');
  const visible = [entry('first.ts'), entry('second.ts'), entry('third.ts')];
  const results = pinActivePath(visible, active, 3);

  assert.deepEqual(
    results.map(({ relativePath }) => relativePath),
    ['first.ts', 'second.ts', 'selected.ts'],
  );
});

test('does not duplicate an active result that is already visible', () => {
  const active = entry('second.ts');
  const visible = [entry('first.ts'), active, entry('third.ts')];
  const results = pinActivePath(visible, active, 3);

  assert.deepEqual(
    results.map(({ relativePath }) => relativePath),
    ['first.ts', 'second.ts', 'third.ts'],
  );
});

test('restores the same active result after results are reordered', () => {
  const active = entry('selected.ts');
  const results = [entry('new.ts'), entry('first.ts'), active];

  assert.equal(restoredActiveIndex(results, pathIdentity(active), 1), 2);
});

test('falls back to the nearest previous position when the active result disappears', () => {
  const results = [entry('first.ts'), entry('second.ts')];

  assert.equal(restoredActiveIndex(results, pathIdentity(entry('deleted.ts')), 5), 1);
  assert.equal(restoredActiveIndex([], pathIdentity(entry('deleted.ts')), 1), -1);
});

test('freezes the visible snapshot before navigation and defers every later update', () => {
  const gate = new ResultUpdateGate();
  const first = [entry('first.ts')];
  const second = [entry('second.ts')];
  const third = [entry('third.ts')];

  assert.equal(gate.shouldApply(first), true);
  gate.freeze();
  assert.equal(gate.shouldApply(second), false);
  assert.equal(gate.shouldApply(third), false);
  assert.equal(gate.isFrozen, true);
  assert.equal(gate.latestDeferredEntries, third);
});

test('changing the query resets the frozen result snapshot', () => {
  const gate = new ResultUpdateGate();
  gate.freeze();
  assert.equal(gate.shouldApply([entry('deferred.ts')]), false);

  gate.reset();

  assert.equal(gate.isFrozen, false);
  assert.equal(gate.latestDeferredEntries, undefined);
  assert.equal(gate.shouldApply([entry('new-query.ts')]), true);
});

test('detects whether a visible result update preserves the exact path order', () => {
  const first = entry('first.ts');
  const second = entry('second.ts');

  assert.equal(samePathOrder([first, second], [first, second]), true);
  assert.equal(samePathOrder([first, second], [second, first]), false);
  assert.equal(samePathOrder([first], [first, second]), false);
});
