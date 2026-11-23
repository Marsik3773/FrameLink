import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reorder } from '../src/layers.mjs';

test('places dropped sources above or below the target, including the camera', () => {
  const items = ['text', 'video', 'camera'].map(id => ({ id }));
  const order = result => result.map(item => item.id);
  assert.deepEqual(order(reorder(items, 'camera', 'text', false)), ['camera', 'text', 'video']);
  assert.deepEqual(order(reorder(items, 'text', 'video', true)), ['video', 'text', 'camera']);
  assert.deepEqual(order(reorder(items, 'text', 'camera', true)), ['video', 'camera', 'text']);
  assert.strictEqual(reorder(items, 'video', 'video', true), items);
  assert.strictEqual(reorder(items, 'missing', 'text', true), items);
});
