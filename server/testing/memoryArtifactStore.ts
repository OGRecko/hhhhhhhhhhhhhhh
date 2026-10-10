import { ArtifactNotFoundError, ArtifactTooLargeError, OBJECT_PREFIX, parseObjectId, type ArtifactStore } from '../storage';

/** In-memory ArtifactStore for tests. Enforces the same identifier rules as production. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, Buffer>();
  /** Set to make the next N puts fail, to exercise storage-failure handling. */
  failPuts = 0;

  async put(objectId: string, data: Buffer) {
    parseObjectId(objectId);
    if (this.failPuts > 0) { this.failPuts--; throw new Error('simulated storage outage'); }
    this.objects.set(objectId, Buffer.from(data));
  }
  async get(objectId: string, maxBytes: number) {
    parseObjectId(objectId);
    const b = this.objects.get(objectId);
    if (!b) throw new ArtifactNotFoundError();
    if (b.length > maxBytes) throw new ArtifactTooLargeError();
    return Buffer.from(b);
  }
  async delete(objectId: string) { parseObjectId(objectId); this.objects.delete(objectId); }
  async deleteAllForSimulation(simulationId: string) {
    let n = 0;
    for (const k of [...this.objects.keys()]) if (k.startsWith(`${simulationId}_`)) { this.objects.delete(k); n++; }
    return n;
  }
  async sizeForSimulation(simulationId: string) {
    let n = 0;
    for (const [k, v] of this.objects) if (k.startsWith(`${simulationId}_`)) n += v.length;
    return n;
  }
  keysFor(simulationId: string) { return [...this.objects.keys()].filter((k) => k.startsWith(`${simulationId}_`)); }
  readonly prefix = OBJECT_PREFIX;
}
