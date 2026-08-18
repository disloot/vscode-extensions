const assert = require('node:assert/strict');
const test = require('node:test');
const {
  prefersWorkspaceFs,
  rankExternalBackends,
  updateBackendPerformance,
} = require('../dist/backendPerformance');

test('adaptive backend ranking uses measured normalized throughput', () => {
  const performance = {};
  updateBackendPerformance(performance, 'file:///workspace', 'git', 500, 100_000);
  updateBackendPerformance(performance, 'file:///workspace', 'rg', 200, 100_000);

  assert.deepEqual(rankExternalBackends('file:///workspace', performance), [
    'rg',
    'git',
    'fd',
  ]);
});

test('workspaceFs is selected only when it is the fastest measured backend', () => {
  const performance = {};
  updateBackendPerformance(performance, 'file:///workspace', 'workspaceFs', 100, 100_000);
  assert.equal(prefersWorkspaceFs('file:///workspace', performance), true);

  updateBackendPerformance(performance, 'file:///workspace', 'rg', 50, 100_000);
  assert.equal(prefersWorkspaceFs('file:///workspace', performance), false);
});
