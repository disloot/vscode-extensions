const assert = require('node:assert/strict');
const test = require('node:test');
const { LruCache } = require('../dist/lruCache');

test('evicts the least recently used value', () => {
  const cache = new LruCache(2);
  cache.set('first', 1);
  cache.set('second', 2);
  assert.equal(cache.get('first'), 1);

  cache.set('third', 3);

  assert.equal(cache.get('second'), undefined);
  assert.equal(cache.get('first'), 1);
  assert.equal(cache.get('third'), 3);
});

test('supports clearing and a disabled zero-sized cache', () => {
  const cache = new LruCache(1);
  cache.set('value', 1);
  cache.clear();
  assert.equal(cache.get('value'), undefined);

  const disabled = new LruCache(0);
  disabled.set('value', 1);
  assert.equal(disabled.get('value'), undefined);
});
