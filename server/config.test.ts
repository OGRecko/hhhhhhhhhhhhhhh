import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from './config';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS  ${name}`); };
console.log('\n=== Configuration Security Tests ===\n');

const testPrivateKey = '-----BEGIN PRIVATE KEY-----\nunit-test-key\n-----END PRIVATE KEY-----';
const base = {
  NODE_ENV: 'production', TRUST_PROXY: '1', CLEANUP_SECRET: 'Ab3dEf6gHi9jKl2mNo5pQr8sTu1vWx4y',
  APP_URL: 'https://cavity.example', FIREBASE_PROJECT_ID: 'cavity-prod',
  FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@example.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: testPrivateKey,
  FIREBASE_STORAGE_BUCKET: 'cavity-prod.appspot.com',
  CLOUD_TASKS_ENABLED: 'true', CLOUD_TASKS_LOCATION: 'us-central1', CLOUD_TASKS_QUEUE: 'cavity-solver', CLOUD_TASKS_DISPATCH_SECRET: 'Xy7zAb2cDe5fGh8jKq1mNp4rSt6uVw9x',
};
check('valid production configuration loads', () => { assert.equal(loadConfig(base).env, 'production'); });
check('production enables Cloud Tasks with a strong dispatch secret', () => { assert.equal(loadConfig(base).cloudTasks.enabled, true); assert.equal(loadConfig(base).cloudTasks.queue, 'cavity-solver'); });
check('production cannot disable Cloud Tasks', () => { assert.equal(loadConfig({ ...base, CLOUD_TASKS_ENABLED: 'false' }).cloudTasks.enabled, true); });
check('production refuses missing Cloud Tasks secret', () => { const e: any = { ...base }; delete e.CLOUD_TASKS_DISPATCH_SECRET; assert.throws(() => loadConfig(e), ConfigError); });
check('production refuses missing cleanup secret', () => { const e: any = { ...base }; delete e.CLEANUP_SECRET; assert.throws(() => loadConfig(e), ConfigError); });
check('production refuses weak cleanup secret', () => { assert.throws(() => loadConfig({ ...base, CLEANUP_SECRET: 'a'.repeat(32) }), ConfigError); });
check('production refuses HTTP APP_URL', () => { assert.throws(() => loadConfig({ ...base, APP_URL: 'http://cavity.example' }), ConfigError); });
check('production refuses emulator host', () => { assert.throws(() => loadConfig({ ...base, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), ConfigError); });
check('production refuses nonnumeric TRUST_PROXY', () => { assert.throws(() => loadConfig({ ...base, TRUST_PROXY: 'true' }), ConfigError); });
check('production accepts Google Application Default Credentials', () => {
  const e: any = { ...base, FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS: 'true', GOOGLE_CLOUD_PROJECT: 'demo-cavity' };
  delete e.FIREBASE_SERVICE_ACCOUNT; delete e.FIREBASE_CLIENT_EMAIL; delete e.FIREBASE_PRIVATE_KEY;
  const c = loadConfig(e);
  assert.equal(c.useApplicationDefaultCredentials, true);
  assert.equal(c.projectId, 'demo-cavity');
});
check('production rejects mixed ADC and explicit credentials', () => {
  const e: any = { ...base, FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS: 'true' };
  assert.throws(() => loadConfig(e), ConfigError);
});

