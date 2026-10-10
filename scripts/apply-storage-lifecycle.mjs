import { spawnSync } from 'node:child_process';

const bucket = process.env.FIREBASE_STORAGE_BUCKET || process.env.GCLOUD_STORAGE_BUCKET;
if (!bucket) {
  console.error('FIREBASE_STORAGE_BUCKET or GCLOUD_STORAGE_BUCKET is required.');
  process.exit(1);
}

const result = spawnSync('gcloud', [
  'storage', 'buckets', 'update', `gs://${bucket}`,
  '--lifecycle-file=storage.lifecycle.json',
], { stdio: 'inherit' });

if (result.error) {
  console.error(`Unable to run gcloud: ${result.error.message}`);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const verify = spawnSync('gcloud', ['storage', 'buckets', 'describe', `gs://${bucket}`, '--format=json'], { encoding: 'utf8' });
if (verify.status !== 0) { console.error(verify.stderr || 'Unable to verify lifecycle policy.'); process.exit(1); }
const config = JSON.parse(verify.stdout);
const rules = config.lifecycle?.rule || [];
const required = rules.some(r => r.action?.type === 'Delete' && Number(r.condition?.age) === 1 && Array.isArray(r.condition?.matchesPrefix) && r.condition.matchesPrefix.includes('public-simulations/'));
if (!required) { console.error('Lifecycle update completed but the required 1-day delete rule was not observed.'); process.exit(1); }
console.log(`Verified 1-day lifecycle deletion rule scoped to public-simulations/ on gs://${bucket}`);
