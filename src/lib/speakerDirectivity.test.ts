import assert from 'node:assert/strict';
import { validateSpeakerDirectivity, isUsableDirectivity, type SpeakerDirectivityDataset } from './speakerDirectivity';

const complete = (): SpeakerDirectivityDataset => ({
  status: 'VERIFIED',
  sourceUrl: 'https://zenodo.org/records/10255555',
  sourceType: 'MEASUREMENT',
  doi: '10.5281/zenodo.10255554',
  licence: 'CC-BY-4.0',
  fileName: 'LS_directivity_Calibrated_GENELEC_8331A.sofa',
  fileChecksum: { algorithm: 'md5', value: 'a00e40164556183420c315e9f6ecd7fd' },
  model: 'Genelec 8331A',
  revision: null,
  measurementConditions: 'Anechoic chamber, calibrated impulse responses, 10 degree elevation steps',
  coordinateConvention: 'Azimuth clockwise from the loudspeaker axis; elevation relative to the horizontal plane',
  frequencyCoverageHz: { min: 50, max: 20000 },
  horizontal: { angles: [0, 90, 180], frequenciesHz: [1000, 2000], levelsDb: [[0, -3, -10], [0, -4, -12]] },
  vertical: null,
});

assert.deepEqual(validateSpeakerDirectivity(complete()), [], 'a complete dataset passes');
assert.equal(isUsableDirectivity(complete()), true);

const unverified = { ...complete(), status: 'UNVERIFIED' as const };
assert.deepEqual(validateSpeakerDirectivity(unverified), [], 'UNVERIFIED with complete fields is structurally valid');
assert.equal(isUsableDirectivity(unverified), false, 'but it is never usable by the simulator');

const noChecksum = { ...complete(), fileChecksum: null };
assert.ok(validateSpeakerDirectivity(noChecksum).some((p) => /checksum/.test(p)), 'a VERIFIED dataset needs a checksum');

const noRevision = { ...complete(), revision: undefined as unknown as null };
assert.ok(validateSpeakerDirectivity(noRevision).some((p) => /revision/.test(p)), 'revision must be explicitly stated or null');

const httpSource = { ...complete(), sourceUrl: 'http://example.com/x' };
assert.ok(validateSpeakerDirectivity(httpSource).some((p) => /https/.test(p)), 'sourceUrl must be https');

const badShape = { ...complete(), horizontal: { angles: [0, 90], frequenciesHz: [1000, 2000], levelsDb: [[0, -3]] } };
assert.ok(validateSpeakerDirectivity(badShape).some((p) => /one row per frequency/.test(p)), 'levels must match frequencies');

const unsortedAngles = { ...complete(), horizontal: { angles: [90, 0], frequenciesHz: [1000], levelsDb: [[0, -3]] } };
assert.ok(validateSpeakerDirectivity(unsortedAngles).some((p) => /ascending/.test(p)), 'angles must be ascending');

const noCut = { ...complete(), horizontal: null, vertical: null };
assert.ok(validateSpeakerDirectivity(noCut).length > 0, 'horizontal or vertical data is required');

const emptyConvention = { ...complete(), coordinateConvention: '' };
assert.ok(validateSpeakerDirectivity(emptyConvention).some((p) => /coordinateConvention/.test(p)), 'coordinate convention must be stated');

console.log('speakerDirectivity: all checks passed');
