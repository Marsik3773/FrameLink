import test from 'node:test';
import assert from 'node:assert/strict';
import { transform, snapToFrame } from '../src/transform.mjs';

const box = { x: 20, y: 30, width: 40, height: 20 };
test('moving and stretching work in composition coordinates', () => {
  assert.deepEqual(transform(box, null, -15, 3), { ...box, x: 5, y: 33 });
  assert.deepEqual(transform(box, 'w', -10, 7), { ...box, x: 10, width: 50 });
});
test('corner scaling keeps the opposite corner anchored', () => {
  assert.deepEqual(transform(box, 'nw', -20, -2), { x: 0, y: 20, width: 60, height: 30 });
});

test('snaps both move edges and resize edges within a screen-pixel threshold', () => {
  const viewport = {width: 800, height: 400};
  assert.deepEqual(snapToFrame(box, { ...box, x: .75, y: 79 }, null, viewport),
    { ...box, x: 0, y: 80 });
  const start = { x: 20, y: 20, width: 75, height: 60 };
  assert.deepEqual(snapToFrame(start, { ...start, width: 79.5 }, 'se', viewport),
    { ...start, width: 80, height: 64 });
  assert.deepEqual(snapToFrame(start, { ...start, width: 79.5 }, 'e', viewport),
    { ...start, width: 80 });
});
