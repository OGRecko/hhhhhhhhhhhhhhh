import { execFileSync } from 'node:child_process';

const project = process.env.GCP_PROJECT_ID;
const region = process.env.CLOUD_RUN_REGION || 'us-central1';
const runtimeSa = process.env.CLOUD_RUN_SERVICE_ACCOUNT;
const queue = process.env.CLOUD_TASKS_QUEUE || 'cavity-solver';
const taskLocation = process.env.CLOUD_TASKS_LOCATION || region;
const firebaseBucket = process.env.FIREBASE_STORAGE_BUCKET;
const releasesBucket = process.env.RELEASES_BUCKET;

if (!project || !runtimeSa || !firebaseBucket || !releasesBucket) {
  throw new Error('GCP_PROJECT_ID, CLOUD_RUN_SERVICE_ACCOUNT, FIREBASE_STORAGE_BUCKET and RELEASES_BUCKET are required');
}
if (!/^[a-z][a-z0-9-]{0,62}$/.test(project)) throw new Error('Invalid GCP_PROJECT_ID');
if (!/^[a-z][a-z0-9-]{0,99}$/.test(region)) throw new Error('Invalid CLOUD_RUN_REGION');
if (!/^[a-z][a-z0-9-]{0,99}$/.test(taskLocation)) throw new Error('Invalid CLOUD_TASKS_LOCATION');
if (!/^[a-z][a-z0-9-]{0,99}$/.test(queue)) throw new Error('Invalid CLOUD_TASKS_QUEUE');
if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(firebaseBucket) || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(releasesBucket)) {
  throw new Error('Invalid bucket name');
}
if (firebaseBucket === releasesBucket) throw new Error('RELEASES_BUCKET must be different from FIREBASE_STORAGE_BUCKET');

function runGcloud(args) {
  try {
    return { ok: true, stdout: execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (error) {
    return { ok: false, stdout: error?.stdout?.toString?.() ?? '', stderr: error?.stderr?.toString?.() ?? '', error };
  }
}

function gcloud(args, options = {}) {
  const result = runGcloud(args);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || String(result.error?.message ?? 'unknown gcloud error');
    throw new Error(`gcloud ${args.join(' ')} failed: ${detail}`);
  }
  return options.capture ? result.stdout : undefined;
}

function isNotFound(result) {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return /not[_ -]?found|404|does not exist|was not found/.test(text);
}

// Enable only the APIs the production deployment actually uses.
gcloud([
  'services', 'enable',
  'run.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
  'cloudtasks.googleapis.com',
  'firestore.googleapis.com',
  'storage.googleapis.com',
  'firebase.googleapis.com',
  'monitoring.googleapis.com',
  `--project=${project}`,
]);

// A describe can fail for reasons other than absence (permissions, auth, API outage).
// Only create when the resource is actually missing.
{
  const result = runGcloud(['firestore', 'databases', 'describe', '(default)', `--project=${project}`, '--format=json']);
  if (!result.ok) {
    if (isNotFound(result)) throw new Error(`Firestore database (default) is missing in project ${project}; create/configure Firebase/Firestore before deployment.`);
    throw new Error(`Unable to inspect Firestore database (default): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}
{
  const result = runGcloud(['storage', 'buckets', 'describe', `gs://${firebaseBucket}`, `--project=${project}`, '--format=json']);
  if (!result.ok) {
    if (isNotFound(result)) throw new Error(`Firebase Storage bucket gs://${firebaseBucket} does not exist; configure the Firebase project/bucket before deployment.`);
    throw new Error(`Unable to inspect Firebase Storage bucket gs://${firebaseBucket}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}
{
  const result = runGcloud(['tasks', 'queues', 'describe', queue, `--location=${taskLocation}`, `--project=${project}`, '--format=json']);
  if (!result.ok) {
    if (!isNotFound(result)) {
      throw new Error(`Unable to inspect Cloud Tasks queue ${queue}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    gcloud(['tasks', 'queues', 'create', queue, `--location=${taskLocation}`, `--project=${project}`]);
  }
}

// Ensure the private release bucket exists and is hardened. Existing buckets are updated too.
{
  const result = runGcloud(['storage', 'buckets', 'describe', `gs://${releasesBucket}`, `--project=${project}`, '--format=json']);
  if (!result.ok) {
    if (!isNotFound(result)) {
      throw new Error(`Unable to inspect release bucket gs://${releasesBucket}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    gcloud([
      'storage', 'buckets', 'create', `gs://${releasesBucket}`,
      `--project=${project}`,
      `--location=${region}`,
      '--uniform-bucket-level-access',
      '--public-access-prevention=enforced',
    ]);
  } else {
    gcloud([
      'storage', 'buckets', 'update', `gs://${releasesBucket}`,
      '--uniform-bucket-level-access',
      '--public-access-prevention=enforced',
    ]);
  }
}

const activeAccount = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { capture: true }).trim();
if (!activeAccount) throw new Error('No active gcloud deployment identity found.');
const deployerMember = activeAccount.endsWith('.gserviceaccount.com') ? `serviceAccount:${activeAccount}` : `user:${activeAccount}`;

gcloud(['iam', 'service-accounts', 'add-iam-policy-binding', runtimeSa, `--member=${deployerMember}`, '--role=roles/iam.serviceAccountUser', `--project=${project}`, '--condition=None', '--quiet']);
for (const role of ['roles/monitoring.alertPolicyEditor', 'roles/monitoring.notificationChannelEditor']) {
  gcloud(['projects', 'add-iam-policy-binding', project, `--member=${deployerMember}`, `--role=${role}`, '--condition=None', '--quiet']);
}

const member = `serviceAccount:${runtimeSa}`;
for (const role of ['roles/datastore.user', 'roles/cloudtasks.enqueuer', 'roles/logging.logWriter']) {
  gcloud(['projects', 'add-iam-policy-binding', project, `--member=${member}`, `--role=${role}`, '--condition=None', '--quiet']);
}
// Least-privilege bucket access: simulation objects are writable by runtime; desktop release files are read-only.
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${firebaseBucket}`, `--member=${member}`, '--role=roles/storage.objectAdmin', '--quiet']);
gcloud(['storage', 'buckets', 'add-iam-policy-binding', `gs://${releasesBucket}`, `--member=${member}`, '--role=roles/storage.objectViewer', '--quiet']);

{
  const result = runGcloud(['artifacts', 'repositories', 'describe', 'cavity', `--location=${region}`, `--project=${project}`]);
  if (!result.ok) {
    if (!isNotFound(result)) {
      throw new Error(`Unable to inspect Artifact Registry repository cavity: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    gcloud(['artifacts', 'repositories', 'create', 'cavity', '--repository-format=docker', `--location=${region}`, `--project=${project}`, '--immutable-tags']);
  }
}

console.log(`GCP production infrastructure ready: ${project}, Cloud Run ${region}, Tasks ${taskLocation}/${queue}, releases bucket gs://${releasesBucket}`);
