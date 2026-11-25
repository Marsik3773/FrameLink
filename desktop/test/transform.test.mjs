import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from '../src/transform.mjs';

const box = { x: 20, y: 30, width: 40, height: 20 };
test('moving and stretching work in composition coordinates', () => {
  assert.deepEqual(transform(box, null, -15, 3), { ...box, x: 5, y: 33 });
  assert.deepEqual(transform(box, 'w', -10, 7), { ...box, x: 10, width: 50 });
});
test('corner scaling keeps the opposite corner anchored', () => {
  assert.deepEqual(transform(box, 'nw', -20, -2), { x: 0, y: 20, width: 60, height: 30 });
});
