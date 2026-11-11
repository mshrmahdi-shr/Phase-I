import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeometryHistory} from '../src/geometry-history.mjs';

const empty={siteBoundary:[],buildingBoundary:[]};
const site=[[-79.38,43.65],[-79.37,43.65],[-79.37,43.66],[-79.38,43.65]];
const edited=[[-79.38,43.65],[-79.365,43.65],[-79.37,43.66],[-79.38,43.65]];

test('geometry history restores committed boundary edits and redoes them',()=>{
  const history=createGeometryHistory();
  history.record(empty,{siteBoundary:site,buildingBoundary:[]});
  history.record({siteBoundary:site,buildingBoundary:[]},{siteBoundary:edited,buildingBoundary:[]});

  assert.deepEqual(history.undo(),{siteBoundary:site,buildingBoundary:[]});
  assert.deepEqual(history.undo(),empty);
  assert.equal(history.undo(),null);
  assert.deepEqual(history.redo(),{siteBoundary:site,buildingBoundary:[]});
  assert.deepEqual(history.redo(),{siteBoundary:edited,buildingBoundary:[]});
  assert.equal(history.redo(),null);
});

test('recording a new edit clears the redo branch and snapshots are isolated',()=>{
  const history=createGeometryHistory();
  const first={siteBoundary:site,buildingBoundary:[]};
  history.record(empty,first);
  const changed={siteBoundary:edited,buildingBoundary:[]};
  history.record(first,changed);
  const undone=history.undo();
  undone.siteBoundary[0][0]=123;
  assert.deepEqual(history.redo(),changed);
  history.undo();
  history.record(first,empty);
  assert.equal(history.redo(),null);
});
