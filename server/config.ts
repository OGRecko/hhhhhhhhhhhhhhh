/**
 * Runtime configuration. In production this FAILS FAST on anything missing or
 * weak; it never falls back to a development default. In development/test the
 * same loader runs but is allowed to use the local emulator and a generated,
 * per-process random secret (never a fixed, guessable value).
 */
import crypto from 'node:crypto';

export interface FirebaseCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface AppConfig {
  env: 'production' | 'development' | 'test';
  trustProxy: number | false;
  cleanupSecret: string;
  /** Salt for hashing client IPs. Derived from CLEANUP_SECRET in production, random per process otherwise. */
  ipSalt: string;
  allowedOrigin: string | null;
  storageBucket: string | null;
  projectId: string | null;
  credentials: FirebaseCredentials | null;
  useApplicationDefaultCredentials: boolean;
  useEmulator: boolean;
  firestoreDatabaseId: string | null;
  port: number;
  /** True when running inside the Windows desktop shell (CAVITY_DESKTOP=1). Local-only, no cloud services. */
  desktop: boolean;
  /** Desktop only: directory for persistent jobs/artifacts (Electron's userData). */
  dataDir: string | null;
  cloudTasks: { enabled: boolean; projectId: string | null; location: string; queue: string; targetUrl: string | null; dispatchSecret: string | null };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const MIN_SECRET_LENGTH = 32;
const KNOWN_WEAK = new Set([
  'changeme', 'change-me', 'secret', 'password', 'test', 'test-secret', 'cleanup-secret',
  'dev', 'development', 'my_cleanup_secret', 'your-secret-here',
]);

function isWeakSecret(s: string): boolean {
  if (s.length < MIN_SECRET_LENGTH) return true;
  if (KNOWN_WEAK.has(s.toLowerCase())) return true;
  if (/^(.)\1+$/.test(s)) return true; // "aaaaaaaa..."
  // Very low character diversity is a predictable secret.
  if (new Set(s).size < 8) return true;
  return false;
}

/** Placeholder values copied from .env.example must never be accepted. */
const PLACEHOLDER_RE = /^(MY_|YOUR_|<.*>$|xxx+|todo|replace)/i;

/**
 * TRUST_PROXY is the EXACT number of trusted reverse proxies in front of the
 * app (e.g. 1 behind a single load balancer). Only a hop count is accepted:
 * `true`, CIDR lists and presets all make the client address depend on
 * attacker-controllable header content. 0 means "trust no proxy".
 */
function parseTrustProxy(raw: string | undefined, problems: string[], required: boolean): number | false {
  if (raw === undefined || raw.trim() === '') {
    if (required) problems.push('TRUST_PROXY must be set in production (the exact number of trusted proxies, e.g. 1).');
    return false;
  }
  const v = raw.trim();
  if (!/^\d+$/.test(v)) {
    problems.push('TRUST_PROXY must be a non-negative integer hop count (not true/false, a CIDR list or a preset).');
    return false;
  }
  const n = Number(v);
  if (n > 10) problems.push('TRUST_PROXY hop count is implausibly large.');
  return n >= 1 ? n : false;
}

function loadCredentials(env: NodeJS.ProcessEnv, problems: string[], required: boolean): FirebaseCredentials | null {
  const rawJson = env.FIREBASE_SERVICE_ACCOUNT;
  if (rawJson && rawJson.trim()) {
    try {
      const sa = JSON.parse(rawJson);
      if (!sa.project_id || !sa.client_email || !sa.private_key) {
        problems.push('FIREBASE_SERVICE_ACCOUNT must contain project_id, client_email and private_key.');
        return null;
      }
      return { projectId: String(sa.project_id), clientEmail: String(sa.client_email), privateKey: String(sa.private_key) };
    } catch {
      // Never echo the parse error: it can contain a fragment of the secret.
      problems.push('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
      return null;
    }
  }
  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') };
  }
  if (required) problems.push('Firebase credentials missing: set FIREBASE_SERVICE_ACCOUNT, or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.');
  return null;
}

/**
 * Desktop configuration: loopback-only, local persistent store, no cloud
 * credentials. Deliberately independent of NODE_ENV so the desktop app never
 * has to pretend to be "development" (which would pull in Vite/tsx).
 */
function loadDesktopConfig(env: NodeJS.ProcessEnv): AppConfig {
  const problems: string[] = [];
  const dataDir = (env.CAVITY_DATA_DIR || '').trim();
  if (!dataDir) problems.push('CAVITY_DATA_DIR is required in desktop mode.');
  const portRaw = env.PORT ?? '';
  const port = Number(portRaw);
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) problems.push('PORT must be an integer between 1 and 65535 in desktop mode.');
  if (problems.length) throw new ConfigError(problems);
  return {
    env: 'production', // serve the built client, enforce the CSP
    desktop: true,
    dataDir,
    trustProxy: false,
    cleanupSecret: crypto.randomBytes(32).toString('hex'),
    ipSalt: crypto.randomBytes(16).toString('hex'),
    allowedOrigin: `http://127.0.0.1:${port}`,
    storageBucket: null, projectId: null, credentials: null,
    useApplicationDefaultCredentials: false, useEmulator: false, firestoreDatabaseId: null,
    port,
    cloudTasks: { enabled: false, projectId: null, location: 'us-central1', queue: 'cavity-solver', targetUrl: null, dispatchSecret: null },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env.CAVITY_DESKTOP === '1') return loadDesktopConfig(env);
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const isProd = nodeEnv === 'production';
  const problems: string[] = [];

  const trustProxy = parseTrustProxy(env.TRUST_PROXY, problems, isProd);

  let cleanupSecret = env.CLEANUP_SECRET || '';
  if (isProd) {
    if (!cleanupSecret) problems.push('CLEANUP_SECRET is required in production.');
    else if (PLACEHOLDER_RE.test(cleanupSecret) || isWeakSecret(cleanupSecret)) {
      problems.push(`CLEANUP_SECRET is too weak: use at least ${MIN_SECRET_LENGTH} random characters (e.g. \`openssl rand -hex 32\`).`);
    }
  } else if (!cleanupSecret) {
    // Development/test: a fresh unpredictable secret per process, never a fixed default.
    cleanupSecret = crypto.randomBytes(32).toString('hex');
  }

  const useEmulator = !!(env.FIRESTORE_EMULATOR_HOST);
  if (isProd && (useEmulator || env.FIREBASE_STORAGE_EMULATOR_HOST)) problems.push('Firebase emulator hosts must not be set in production.');

  const useApplicationDefaultCredentials = env.FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS === 'true';
  const credentials = loadCredentials(env, problems, isProd && !useEmulator && !useApplicationDefaultCredentials);
  if (credentials && isProd && PLACEHOLDER_RE.test(credentials.projectId)) problems.push('FIREBASE project id is a placeholder.');
  if (credentials && isProd && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(credentials.privateKey)) problems.push('Firebase private key is not a PEM private key.');
  if (isProd && useApplicationDefaultCredentials && (env.FIREBASE_SERVICE_ACCOUNT || env.FIREBASE_CLIENT_EMAIL || env.FIREBASE_PRIVATE_KEY)) problems.push('Do not combine FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS=true with explicit Firebase service-account credentials.');
  if (credentials && env.FIREBASE_PROJECT_ID && env.FIREBASE_SERVICE_ACCOUNT && env.FIREBASE_PROJECT_ID !== credentials.projectId) {
    problems.push('FIREBASE_PROJECT_ID does not match the project in FIREBASE_SERVICE_ACCOUNT.');
  }
  // With ADC, the active GCP project is authoritative. Do not let a stale
  // FIREBASE_PROJECT_ID override GOOGLE_CLOUD_PROJECT and send Admin SDK/Cloud Tasks
  // operations to a different project than the credentials are attached to.
  const projectId = useApplicationDefaultCredentials
    ? (env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.FIREBASE_PROJECT_ID || env.FIREBASE_EMULATOR_PROJECT_ID || null)
    : (credentials?.projectId || env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.FIREBASE_EMULATOR_PROJECT_ID || null);
  if (isProd && !projectId) problems.push('A Firebase/GCP project id is required in production.');
  if (isProd && useApplicationDefaultCredentials && !projectId) problems.push('GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID is required when using application-default credentials.');

  let storageBucket = env.FIREBASE_STORAGE_BUCKET || env.GCLOUD_STORAGE_BUCKET || null;
  if (isProd && (!storageBucket || PLACEHOLDER_RE.test(storageBucket))) problems.push('FIREBASE_STORAGE_BUCKET is required in production.');
  if (isProd && storageBucket && !/^[a-z0-9][a-z0-9._-]{2,221}$/.test(storageBucket)) problems.push('FIREBASE_STORAGE_BUCKET is not a valid bucket name.');
  if (!storageBucket && projectId && !isProd) storageBucket = `${projectId}.appspot.com`; // emulator/dev only

  let allowedOrigin: string | null = null;
  const rawOrigin = env.APP_URL;
  if (rawOrigin && !PLACEHOLDER_RE.test(rawOrigin)) {
    try {
      const u = new URL(rawOrigin);
      if (isProd && u.protocol !== 'https:') problems.push('APP_URL must use https in production.');
      allowedOrigin = u.origin;
    } catch { problems.push('APP_URL is not a valid URL.'); }
  } else if (isProd) {
    problems.push('APP_URL is required in production (used as the allowed application origin).');
  }

  if (env.PORT !== undefined && env.PORT !== '' && !(Number.isInteger(Number(env.PORT)) && Number(env.PORT) > 0 && Number(env.PORT) < 65536)) problems.push('PORT must be an integer between 1 and 65535.');

  const cloudTasksEnabled = isProd || env.CLOUD_TASKS_ENABLED === 'true';
  let cloudTasksLocation = env.CLOUD_TASKS_LOCATION || 'us-central1';
  let cloudTasksQueue = env.CLOUD_TASKS_QUEUE || 'cavity-solver';
  let cloudTasksTargetUrl: string | null = null;
  let cloudTasksDispatchSecret: string | null = env.CLOUD_TASKS_DISPATCH_SECRET || null;
  if (cloudTasksEnabled) {
    if (!projectId) problems.push('CLOUD_TASKS requires a Firebase/GCP project id.');
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(cloudTasksLocation)) problems.push('CLOUD_TASKS_LOCATION is invalid.');
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(cloudTasksQueue)) problems.push('CLOUD_TASKS_QUEUE is invalid.');
    if (!cloudTasksDispatchSecret || isWeakSecret(cloudTasksDispatchSecret)) problems.push('CLOUD_TASKS_DISPATCH_SECRET is required and must be a strong random secret.');
    if (allowedOrigin) cloudTasksTargetUrl = new URL('/api/internal/job-run', allowedOrigin).toString();
    else if (isProd) problems.push('APP_URL is required when Cloud Tasks is enabled.');
  }

  if (problems.length) throw new ConfigError(problems);

  const ipSalt = isProd
    ? crypto.createHmac('sha256', cleanupSecret).update('cavity-ip-salt-v1').digest('hex')
    : crypto.randomBytes(16).toString('hex');

  return {
    env: nodeEnv, trustProxy, cleanupSecret, ipSalt, allowedOrigin, storageBucket, projectId,
    desktop: false, dataDir: null,
    credentials, useApplicationDefaultCredentials, useEmulator, firestoreDatabaseId: env.FIRESTORE_DATABASE_ID || null, port: Number(env.PORT) > 0 ? Number(env.PORT) : 3000,
    cloudTasks: { enabled: cloudTasksEnabled, projectId, location: cloudTasksLocation, queue: cloudTasksQueue, targetUrl: cloudTasksTargetUrl, dispatchSecret: cloudTasksDispatchSecret },
  };
}

/** Constant-time secret comparison that does not leak length via early return. */
export function secretsEqual(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string') return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && supplied.length === expected.length;
}
