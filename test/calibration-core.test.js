import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalibrationMatrix, imagePointFromClient, imagePointToClient, isPointInCentralRegion,
  movementToReference, nudgePoint
} from '../js/calibration-core.js';

test('creates a rotated and sheared image-to-machine calibration', () => {
  const reference = { x: 640, y: 360 };
  const matrix = createCalibrationMatrix(reference, { x: 726, y: 374 }, { x: 629, y: 442 });
  assert.deepEqual(matrix, { ax: { x: 86, y: 14 }, ay: { x: -11, y: 82 } });
  const point = {
    x: reference.x - (0.35 * matrix.ax.x + (-0.22) * matrix.ay.x),
    y: reference.y - (0.35 * matrix.ax.y + (-0.22) * matrix.ay.y)
  };
  const move = movementToReference(reference, point, matrix);
  assert.ok(Math.abs(move.x - 0.35) < 1e-9);
  assert.ok(Math.abs(move.y + 0.22) < 1e-9);
});

test('normalizes a 0.5 mm axis calibration to pixels per mm', () => {
  const reference = {x:640,y:360};
  assert.deepEqual(
    createCalibrationMatrix(reference,{x:683,y:367},{x:634.5,y:401},0.5,0.5),
    {ax:{x:86,y:14},ay:{x:-11,y:82}}
  );
});

test('rejects degenerate calibration and moves over the safety limit', () => {
  assert.throws(() => createCalibrationMatrix({x:0,y:0}, {x:1,y:1}, {x:2,y:2}), /too small/);
  const matrix = { ax:{x:100,y:0}, ay:{x:0,y:100} };
  assert.throws(() => movementToReference({x:0,y:0}, {x:-600,y:0}, matrix), /5 mm safety limit/);
});

test('one-pixel marker nudge is clamped to native image bounds', () => {
  assert.deepEqual(nudgePoint({x:0,y:719}, -1, 1), {x:0,y:719});
  assert.deepEqual(nudgePoint({x:10,y:10}, 1, -1), {x:11,y:9});
});

test('T0 reference is accepted only within the central 40 percent', () => {
  assert.equal(isPointInCentralRegion({x:640,y:360}), true);
  assert.equal(isPointInCentralRegion({x:384,y:216}), true);
  assert.equal(isPointInCentralRegion({x:383.9,y:360}), false);
  assert.equal(isPointInCentralRegion({x:640,y:504.1}), false);
});

test('object-contain coordinate conversion round trips', () => {
  const rect = {left:100, top:20, width:800, height:800};
  const client = imagePointToClient({x:321,y:456}, rect);
  const point = imagePointFromClient(client.x, client.y, rect);
  assert.ok(Math.abs(point.x - 321) < 1e-9);
  assert.ok(Math.abs(point.y - 456) < 1e-9);
});

test('coordinate conversion and nudging support arbitrary camera resolutions', () => {
  const rect = {left:20, top:10, width:960, height:540};
  const client = imagePointToClient({x:960,y:540}, rect, 1920, 1080);
  const point = imagePointFromClient(client.x, client.y, rect, 1920, 1080);
  assert.deepEqual(point, {x:960,y:540});
  assert.deepEqual(nudgePoint({x:1919,y:1079}, 1, 1, 1920, 1080), {x:1919,y:1079});
  assert.equal(isPointInCentralRegion({x:960,y:540},1920,1080), true);
});
