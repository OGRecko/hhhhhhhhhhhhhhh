/**
 * Firebase Admin initialisation from validated configuration.
 *
 * There are NO fallbacks here: credentials, project id and bucket all come
 * from loadConfig(), which has already refused to start in production if any
 * of them is missing. Production can also use Google Application Default
 * Credentials (ADC), which is the preferred mode on Cloud Run/GCE. Nothing
 * is read from a checked-in file.
 */
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { AppConfig } from './config';
import type { FirestoreLike } from './jobStore';
import { FirebaseArtifactStore, type ArtifactStore, type GcsBucketLike } from './storage';
import { FakeFirestore } from './testing/memoryFirestore';
import { MemoryArtifactStore } from './testing/memoryArtifactStore';
import { FileArtifactStore, LocalFirestore } from './desktop/localStore';

const defaultDevFallback = new MemoryArtifactStore();

/** Write-batch surface used by admission cleanup (delete + commit). */
export interface FirestoreBatchLike {
  delete(ref: unknown): unknown;
  commit(): Promise<unknown>;
}
export type FirestoreWithBatch = FirestoreLike & { batch(): FirestoreBatchLike };

export function createFirebase(config: AppConfig): { db: FirestoreWithBatch; artifacts: ArtifactStore } {
  if (config.desktop) {
    // Desktop: jobs + artifacts persist under the app's userData directory; no cloud services.
    return { db: new LocalFirestore(config.dataDir!) as unknown as FirestoreWithBatch, artifacts: new FileArtifactStore(config.dataDir!) };
  }
  if (!config.credentials && !config.useApplicationDefaultCredentials && !config.useEmulator) {
    return { db: new FakeFirestore() as unknown as FirestoreWithBatch, artifacts: defaultDevFallback };
  }
  if (getApps().length === 0) {
    if (config.credentials) {
      initializeApp({
        credential: cert({
          projectId: config.credentials.projectId,
          clientEmail: config.credentials.clientEmail,
          privateKey: config.credentials.privateKey,
        }),
        projectId: config.credentials.projectId,
        storageBucket: config.storageBucket ?? undefined,
      });
    } else if (config.useApplicationDefaultCredentials && config.projectId) {
      initializeApp({
        credential: applicationDefault(),
        projectId: config.projectId,
        storageBucket: config.storageBucket ?? undefined,
      });
    } else if (config.useEmulator && config.projectId) {
      initializeApp({ projectId: config.projectId, storageBucket: config.storageBucket ?? undefined });
    } else {
      throw new Error('No Firebase credentials, application-default credentials, or emulator configured.');
    }
  }
  const db = (config.firestoreDatabaseId ? getFirestore(config.firestoreDatabaseId) : getFirestore()) as unknown as FirestoreWithBatch;
  const bucketName = config.storageBucket;
  if (!bucketName) {
    return { db, artifacts: defaultDevFallback };
  }
  const devFallback = config.env !== 'production' ? defaultDevFallback : undefined;
  return { db, artifacts: new FirebaseArtifactStore(() => getStorage().bucket(bucketName) as unknown as GcsBucketLike, devFallback) };
}
