import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const projectId = process.env.FIREBASE_EMULATOR_PROJECT_ID || 'demo-cavity';
const firestoreBase = process.env.FIRESTORE_EMULATOR_URL || 'http://127.0.0.1:8080';
const storageBase = process.env.STORAGE_EMULATOR_URL || 'http://127.0.0.1:9199';
const bucket = process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;

async function expectForbidden(name, url, options = {}) {
  const res = await fetch(url, options);
  if (res.status !== 403) {
    throw new Error(`${name}: expected 403 from Firebase rules, got ${res.status}`);
  }
  console.log(`PASS ${name}`);
}

await expectForbidden(
  'Firestore unauthenticated read denied',
  `${firestoreBase}/v1/projects/${projectId}/databases/(default)/documents/simulations/rules-smoke`,
  { method: 'GET' },
);

await expectForbidden(
  'Firestore unauthenticated write denied',
  `${firestoreBase}/v1/projects/${projectId}/databases/(default)/documents/simulations`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: { status: { stringValue: 'smoke' } } }) },
);

const objectName = encodeURIComponent('public-simulations/rules-smoke.bin');
await expectForbidden(
  'Storage unauthenticated read denied',
  `${storageBase}/v0/b/${encodeURIComponent(bucket)}/o/${objectName}`,
  { method: 'GET' },
);

await expectForbidden(
  'Storage unauthenticated write denied',
  `${storageBase}/v0/b/${encodeURIComponent(bucket)}/o?name=${objectName}`,
  { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('smoke') },
);

// Admin SDK access is intentionally allowed: production API routes use the
// Admin SDK as the trusted server boundary while browser access is denied by rules.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';
if (!getApps().length) initializeApp({ projectId, storageBucket: bucket });
const adminDb = getFirestore();
const adminBucket = getStorage().bucket(bucket);
const adminDoc = adminDb.collection('_security_smoke').doc('admin-boundary');
await adminDoc.set({ ok: true, createdAt: Date.now() });
const adminSnap = await adminDoc.get();
if (!adminSnap.exists || adminSnap.data()?.ok !== true) throw new Error('Admin Firestore read/write failed');
console.log('PASS Admin SDK Firestore read/write allowed');

const adminFile = adminBucket.file('public-simulations/rules-smoke-admin.bin');
await adminFile.save(Buffer.from('smoke'), { resumable: false, contentType: 'application/octet-stream' });
const [downloaded] = await adminFile.download();
if (downloaded.toString() !== 'smoke') throw new Error('Admin Storage read/write failed');
console.log('PASS Admin SDK Storage read/write allowed');

await adminFile.delete({ ignoreNotFound: true });
await adminDoc.delete();
console.log('Firebase emulator security smoke tests passed.');
