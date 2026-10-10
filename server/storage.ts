/**
 * Artifact storage. A small interface with two implementations:
 *   - FirebaseArtifactStore: Cloud Storage via the Admin SDK (production).
 *   - MemoryArtifactStore (server/testing): in-memory, for tests.
 *
 * Authorization lives in artifactAccess.ts, NOT here; this module only moves
 * bytes and validates object identifiers.
 */
import { LIMITS, UUID_RE } from '../src/lib/publicLimits';

export const OBJECT_PREFIX = 'public-simulations/';

const OBJECT_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_(receiver|wave)_([0-9]{1,6})\.bin$/i;

export class InvalidObjectIdError extends Error { constructor() { super('Invalid object ID'); this.name = 'InvalidObjectIdError'; } }
export class ArtifactTooLargeError extends Error { constructor() { super('Artifact exceeds size limit'); this.name = 'ArtifactTooLargeError'; } }
export class ArtifactNotFoundError extends Error { constructor() { super('Artifact not found'); this.name = 'ArtifactNotFoundError'; } }

export interface ParsedObjectId { simulationId: string; kind: 'receiver' | 'wave'; index: number }

/**
 * Object IDs are `<uuid>_<receiver|wave>_<digits>.bin`, nothing else. The
 * numeric index (not a free-form suffix) makes traversal, encoding tricks and
 * ambiguous prefixes structurally impossible.
 */
export function parseObjectId(objectId: unknown): ParsedObjectId {
  if (typeof objectId !== 'string' || objectId.length > 100) throw new InvalidObjectIdError();
  const m = OBJECT_ID_RE.exec(objectId);
  if (!m || !UUID_RE.test(m[1])) throw new InvalidObjectIdError();
  return { simulationId: m[1].toLowerCase(), kind: m[2].toLowerCase() as 'receiver' | 'wave', index: Number(m[3]) };
}

export const receiverObjectId = (simulationId: string, i: number) => `${simulationId}_receiver_${i}.bin`;
export const waveObjectId = (simulationId: string, i: number) => `${simulationId}_wave_${i}.bin`;

export interface ArtifactStore {
  put(objectId: string, data: Buffer): Promise<void>;
  /** Throws ArtifactNotFoundError / ArtifactTooLargeError. Never buffers an over-limit object. */
  get(objectId: string, maxBytes: number): Promise<Buffer>;
  delete(objectId: string): Promise<void>;
  /** Delete every object belonging to a simulation; returns the number removed. */
  deleteAllForSimulation(simulationId: string): Promise<number>;
  /** Total bytes currently stored for a simulation. */
  sizeForSimulation(simulationId: string): Promise<number>;
}

/**
 * The slice of the Cloud Storage File / Bucket API this module actually calls.
 * Declared locally so the production code is typed by what it uses; the real
 * `Bucket` is cast to this once, at the boundary in firebase.ts.
 */
export interface GcsFileLike {
  save(data: Buffer, options: { resumable: boolean; contentType: string; metadata: { cacheControl: string } }): Promise<unknown>;
  getMetadata(): Promise<[{ size?: string | number }, ...unknown[]]>;
  download(): Promise<[Buffer, ...unknown[]]>;
  delete(options: { ignoreNotFound: boolean }): Promise<unknown>;
  metadata?: { size?: string | number };
}
export interface GcsBucketLike {
  file(name: string): GcsFileLike;
  getFiles(options: { prefix: string }): Promise<[GcsFileLike[], ...unknown[]]>;
}

/** Numeric `code` (HTTP status) that the GCS client puts on its errors, if any. */
function errorCode(e: unknown): number | string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}
function errorMessage(e: unknown): string {
  if (typeof e !== 'object' || e === null) return '';
  const m = (e as { message?: unknown }).message;
  return typeof m === 'string' ? m : '';
}
/** Errors that mean "this environment has no usable bucket" (dev fallback only). */
function isBucketUnavailable(e: unknown): boolean {
  const code = errorCode(e);
  const msg = errorMessage(e);
  return code === 404 || code === 403 || msg.includes('bucket does not exist') || msg.includes('billing account');
}

export class FirebaseArtifactStore implements ArtifactStore {
  constructor(
    private readonly bucket: () => GcsBucketLike,
    private readonly devFallback?: ArtifactStore
  ) {}

  private file(objectId: string) {
    parseObjectId(objectId);
    return this.bucket().file(`${OBJECT_PREFIX}${objectId}`);
  }

  async put(objectId: string, data: Buffer): Promise<void> {
    try {
      await this.file(objectId).save(data, {
        resumable: false,
        contentType: 'application/octet-stream',
        metadata: { cacheControl: 'private, no-store' },
      });
    } catch (e: unknown) {
      if (this.devFallback && isBucketUnavailable(e)) {
        await this.devFallback.put(objectId, data);
        return;
      }
      throw e;
    }
  }

  async get(objectId: string, maxBytes: number): Promise<Buffer> {
    try {
      const f = this.file(objectId);
      let meta: { size?: string | number } | undefined;
      try { [meta] = await f.getMetadata(); }
      catch (e: unknown) { if (errorCode(e) === 404) throw new ArtifactNotFoundError(); throw e; }
      if (Number(meta?.size) > maxBytes) throw new ArtifactTooLargeError();
      const [buf] = await f.download();
      return buf;
    } catch (e: unknown) {
      if (this.devFallback && (e instanceof ArtifactNotFoundError || isBucketUnavailable(e))) {
        return this.devFallback.get(objectId, maxBytes);
      }
      throw e;
    }
  }

  async delete(objectId: string): Promise<void> {
    try {
      await this.file(objectId).delete({ ignoreNotFound: true });
    } catch (e: unknown) {
      if (this.devFallback) {
        await this.devFallback.delete(objectId);
        return;
      }
      throw e;
    }
  }

  async deleteAllForSimulation(simulationId: string): Promise<number> {
    if (!UUID_RE.test(simulationId)) throw new InvalidObjectIdError();
    try {
      const [files] = await this.bucket().getFiles({ prefix: `${OBJECT_PREFIX}${simulationId}_` });
      await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
      return files.length;
    } catch (e: unknown) {
      if (this.devFallback) {
        return this.devFallback.deleteAllForSimulation(simulationId);
      }
      throw e;
    }
  }

  async sizeForSimulation(simulationId: string): Promise<number> {
    if (!UUID_RE.test(simulationId)) throw new InvalidObjectIdError();
    try {
      const [files] = await this.bucket().getFiles({ prefix: `${OBJECT_PREFIX}${simulationId}_` });
      return files.reduce((n, f) => n + Number(f.metadata?.size ?? 0), 0);
    } catch (e: unknown) {
      if (this.devFallback) {
        return this.devFallback.sizeForSimulation(simulationId);
      }
      throw e;
    }
  }
}

export { LIMITS };
