import { validateProjectData } from './projectValidation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base = {
  schemaVersion: 3,
  appVersion: '3.1.0',
  projectName: 'QA Project',
  roomName: 'Room A',
  L: 10, W: 8, H: 3,
  fmax: 500,
  accuracyMode: 'balanced',
  confirmReducedResolution: false,
  poly: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
  wallMaterial: 'drywall',
  wallSegMats: [null,null,null,null],
  wallOpenings: [null,null,null,null],
  floorMaterial: 'wood_floor',
  ceilMaterial: 'stonewool',
  scatter: {walls:0.15,floor:0.15,ceiling:0.15},
  sources: [{id:'s1',x:0.5,y:0.5,z:1.5,gainDb:0,delayMs:0,sensitivityDb:90,referencePowerW:1}],
  receivers: [{id:'r1',name:'Receiver 1',x:0.5,y:0.5,z:1.5}],
  simulations: [{id:'sim1',name:'Simulation 1',sourceId:'s1',receiverId:'r1'}],
  uxMode: 'beginner',
  primaryReceiverId: 'r1',
  receiverGrid: null,
};

const ok = validateProjectData(base);
assert(ok.ok, ok.ok ? '' : ok.error);
assert(ok.data.schemaVersion === 3, 'schema should normalize to current version');
assert(ok.data.wallOpenings.length === 4, 'wall openings should be preserved');

const legacy = {...base};
delete (legacy as any).schemaVersion;
const migrated = validateProjectData(legacy);
assert(migrated.ok, migrated.ok ? '' : migrated.error);
assert(migrated.data.schemaVersion === 3, 'schema-less legacy projects should migrate');

const future = {...base, schemaVersion: 999};
const futureResult = validateProjectData(future);
assert(!futureResult.ok, 'future schemas must not be silently downgraded');

for (const bad of [
  {...base, scatter:{walls:2,floor:0,ceiling:0}},
  {...base, wallOpenings:[null,{start:1,end:0},null,null]},
  {...base, receiverGrid:{xMin:.8,xMax:.2,yMin:0,yMax:1,zHeight:1,spacing:.5}},
  {...base, simulations:[{id:'bad',name:'Sim',sourceId:'missing',receiverId:'r1'}]},
  {...base, wallMaterial:'does_not_exist'},
  {...base, wallSegMats:['does_not_exist',null,null,null]},
  {...base, sources:[{...base.sources[0], id:'s1'},{...base.sources[0], id:'s1'}]},
  {...base, receivers:[{...base.receivers[0], id:'r1'},{...base.receivers[0], id:'r1'}]},
  {...base, sources:[{...base.sources[0], speakerId:'does-not-exist'}]},
]) {
  const result = validateProjectData(bad);
  assert(!result.ok, 'malformed project data must be rejected');
}

console.log('projectValidation tests passed');
