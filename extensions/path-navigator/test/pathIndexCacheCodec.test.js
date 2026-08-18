const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodePathIndexCache,
  encodePathIndexCache,
} = require('../dist/pathIndexCacheCodec');

test('compact binary index cache round-trips Unicode paths and workspace metadata', () => {
  const original = {
    createdAt: 123456,
    fingerprint: '{"version":3}',
    limited: true,
    partial: false,
    workspaces: [
      { uri: 'vscode-remote://ssh-remote+demo/workspace', name: '演示项目' },
    ],
    entries: [
      { workspaceIndex: 0, kind: 'directory', relativePath: '源码' },
      { workspaceIndex: 0, kind: 'file', relativePath: '源码/入口.ts' },
    ],
  };

  assert.deepEqual(decodePathIndexCache(encodePathIndexCache(original)), original);
});

test('index cache rejects unsupported data', () => {
  assert.throws(() => decodePathIndexCache(Buffer.from('not-an-index')));
});
