import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const required = ['GCP_PROJECT_ID', 'CLOUD_RUN_SERVICE', 'CLOUD_RUN_REGION', 'CLOUD_RUN_SERVICE_ACCOUNT', 'APP_URL', 'FIREBASE_STORAGE_BUCKET', 'CLEANUP_SECRET', 'CLOUD_TASKS_QUEUE', 'CLOUD_TASKS_LOCATION', 'CLOUD_TASKS_DISPATCH_SECRET', 'RELEASES_BUCKET'];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required`);
const project = process.env.GCP_PROJECT_ID;
const service = process.env.CLOUD_RUN_SERVICE;
const region = process.env.CLOUD_RUN_REGION;
const serviceAccount = process.env.CLOUD_RUN_SERVICE_ACCOUNT;
const image = `${region}-docker.pkg.dev/${project}/cavity/${service}:deploy`;
const run = (args) => {
  const r = spawnSync('gcloud', args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`gcloud ${args.join(' ')} failed with ${r.status}`);
};
const capture = (args) => spawnSync('gcloud', args, { encoding: 'utf8', env: process.env });

run(['auth', 'configure-docker', `${region}-docker.pkg.dev`, '--quiet']);
const repoDescribe = capture(['artifacts', 'repositories', 'describe', 'cavity', `--location=${region}`, `--project=${project}`]);
if (repoDescribe.status !== 0) {
  const details = `${repoDescribe.stdout || ''}\n${repoDescribe.stderr || ''}`;
  if (/not found|NOT_FOUND|does not exist/i.test(details)) {
    run(['artifacts', 'repositories', 'create', 'cavity', '--repository-format=docker', `--location=${region}`, `--project=${project}`]);
  } else {
    throw new Error(`Unable to inspect Artifact Registry repository: ${details.trim() || `gcloud exited with ${repoDescribe.status}`}`);
  }
}
run(['builds', 'submit', '.', `--tag=${image}`, `--project=${project}`]);

const dir = mkdtempSync(join(tmpdir(), 'cavity-env-'));
const envFile = join(dir, 'env.yaml');
const env = {
  NODE_ENV: 'production', PORT: '8080', APP_URL: process.env.APP_URL, TRUST_PROXY: process.env.TRUST_PROXY || '1',
  FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS: 'true', FIREBASE_PROJECT_ID: project,
  FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET,
  CLEANUP_SECRET: process.env.CLEANUP_SECRET,
  CLOUD_TASKS_LOCATION: process.env.CLOUD_TASKS_LOCATION,
  CLOUD_TASKS_QUEUE: process.env.CLOUD_TASKS_QUEUE,
  CLOUD_TASKS_DISPATCH_SECRET: process.env.CLOUD_TASKS_DISPATCH_SECRET,
};
// Production deploy mounts the Windows-release bucket read-only so the public Download EXE path cannot silently disappear.
const releasesBucket = process.env.RELEASES_BUCKET;
env.RELEASES_DIR = '/mnt/releases';
writeFileSync(envFile, Object.entries(env).map(([k,v]) => `${k}: ${JSON.stringify(String(v))}`).join('\n') + '\n', { mode: 0o600 });
try {
  run(['run', 'deploy', service, `--image=${image}`, `--region=${region}`, `--project=${project}`, '--platform=managed', '--allow-unauthenticated', `--service-account=${serviceAccount}`, `--env-vars-file=${envFile}`, '--port=8080', '--memory=2Gi', '--cpu=2', '--timeout=120s', '--min-instances=1', '--max-instances=10',
    '--add-volume', `name=releases,type=cloud-storage,bucket=${releasesBucket},readonly=true`,
    '--add-volume-mount', 'volume=releases,mount-path=/mnt/releases']);
} finally { rmSync(dir, { recursive: true, force: true }); }

const describe = spawnSync('gcloud', ['run', 'services', 'describe', service, `--region=${region}`, `--project=${project}`, '--format=value(status.url)'], { encoding: 'utf8' });
if (describe.status !== 0 || !describe.stdout.trim()) throw new Error('Cloud Run deployment succeeded but no service URL was returned.');
console.log(`DEPLOYED_URL=${describe.stdout.trim()}`);
