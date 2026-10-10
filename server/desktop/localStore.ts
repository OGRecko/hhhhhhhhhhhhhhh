/**
 * Persistent local storage for the Windows desktop app.
 *
 *  - LocalFirestore: the same transaction-faithful engine used by the tests
 *    (so lease fencing / state-machine guarantees are identical), but its
 *    document map is persisted to <dataDir>/store.bin. Jobs therefore survive
 *    a restart; a job that was `running` when the app closed is recovered by
 *    the dispatcher's normal lease-expiry sweep.
 *  - FileArtifactStore: solver artifacts as files under <dataDir>/artifacts.
 *    Object IDs are validated by parseObjectId, so path traversal is
 *    structurally impossible.
 *
 * Writes are atomic (temp file + rename). A corrupt store file is moved aside
 * rather than deleted, and the app starts empty instead of crashing.
 */
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { ArtifactNotFoundError, ArtifactTooLargeError, parseObjectId, type ArtifactStore } from '../storage';
import { FakeFirestore, type Stored } from '../testing/memoryFirestore';
import { logError, logEvent } from '../observability';

const STORE_FILE = 'store.bin';
const FORMAT_VERSION = 1;

function atomicWriteSync(file: string, data: Buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  const bak = `${file}.bak`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can transiently refuse a rename over an open file (AV/indexer).
    // Never delete the live file first: move it to .bak (recoverable on load), then replace.
    try {
      if (fs.existsSync(file)) fs.renameSync(file, bak);
      fs.renameSync(tmp, file);
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
}

// One shared 'exit' listener for every PersistingMap (a listener per instance leaks and trips MaxListeners).
// An exception escaping an 'exit' listener becomes an uncaught error and a non-zero exit code, so failures are
// reported instead; logging is synchronous and safe at exit.
const liveMaps = new Set<PersistingMap>();
let exitHooked = false;
function hookExitOnce() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const m of liveMaps) {
      try { m.flushSync(); } catch (e) { logError('local_store_flush_on_exit_failed', e, { file: m.filePath }); }
    }
  });
}

/** A Map that schedules a debounced, atomic save after every mutation. */
export class PersistingMap extends Map<string, Stored> {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private loading = true;
  /** Human-readable record of every corruption/recovery that happened while loading (also logged). Empty on a clean start. */
  readonly recoveryNotes: string[] = [];
  get filePath() { return this.file; }
  constructor(private readonly file: string, private readonly debounceMs = 250) {
    super();
    this.load();
    this.loading = false;
    liveMaps.add(this);
    hookExitOnce();
  }
  /** Stop flushing this map at process exit (the app has exactly one; tests create many). */
  dispose() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } liveMaps.delete(this); }
  private parse(raw: Buffer) {
    const parsed = v8.deserialize(raw) as { v: number; entries: Array<[string, Stored]> };
    if (parsed?.v !== FORMAT_VERSION || !Array.isArray(parsed.entries)) throw new Error('unsupported store format');
    return parsed.entries;
  }
  private note(msg: string, fields: Record<string, unknown> = {}, err?: unknown) {
    this.recoveryNotes.push(msg);
    if (err !== undefined) logError('local_store_recovery', err, { msg, file: this.file, ...fields });
    else logEvent('local_store_recovery', { msg, file: this.file, ...fields });
  }
  private moveAsideCorrupt(reason: string, cause: unknown) {
    const dest = `${this.file}.corrupt-${Date.now()}`;
    try { fs.renameSync(this.file, dest); this.note(`Job store was unreadable (${reason}); the damaged file was kept as ${path.basename(dest)}.`, { dest }, cause); }
    catch (e) { this.note(`Job store was unreadable (${reason}) and could NOT be moved aside; it will be overwritten by the next save.`, { dest }, e); }
  }
  private load() {
    const bak = `${this.file}.bak`;
    let raw: Buffer | null = null;
    try { raw = fs.readFileSync(this.file); }
    catch (e: any) {
      // Only "file does not exist" means first run. Any other read error (EBUSY/EPERM/EIO) must not
      // be treated as an empty store, or the next flush would overwrite the real data.
      if (e?.code !== 'ENOENT') {
        if (!fs.existsSync(bak)) throw new Error(`Cannot read the job store (${e?.code || e}). Close other copies of the app and try again. File: ${this.file}`);
        this.note(`Job store could not be read (${e?.code || e}); falling back to the backup copy.`, {}, e);
      }
    }
    if (raw) {
      try { for (const [k, v] of this.parse(raw)) super.set(k, v); return; }
      catch (e) { this.moveAsideCorrupt('corrupt or unsupported format', e); super.clear(); }
    }
    // Primary missing/corrupt: recover from the previous good copy if there is one.
    let bakRaw: Buffer | null = null;
    try { bakRaw = fs.readFileSync(bak); }
    catch (e: any) {
      if (e?.code !== 'ENOENT') this.note(`Backup job store could not be read (${e?.code || e}); starting with an empty store.`, {}, e);
      else if (raw) this.note('Job store was corrupt and no backup exists; starting with an empty store.', {}, new Error('job store unrecoverable: previous jobs are lost (damaged file kept aside)'));
      super.clear();
      return;
    }
    try { for (const [k, v] of this.parse(bakRaw)) super.set(k, v); this.note(`Recovered ${this.size} job record(s) from the backup copy.`, { recovered: this.size }); }
    catch (e) { super.clear(); this.note('Backup job store is also corrupt; starting with an empty store.', {}, e); }
  }
  private schedule() {
    if (this.loading) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; try { this.flushSync(); } catch (e) { logError('local_store_flush_failed', e, { file: this.file }); /* data stays dirty; retried on the next mutation and on exit */ } }, this.debounceMs);
    this.timer.unref?.();
  }
  flushSync() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    atomicWriteSync(this.file, v8.serialize({ v: FORMAT_VERSION, entries: [...this.entries()] }));
    this.dirty = false;
  }
  override set(k: string, v: Stored) { super.set(k, v); this.schedule(); return this; }
  override delete(k: string) { const r = super.delete(k); if (r) this.schedule(); return r; }
  override clear() { super.clear(); this.schedule(); }
}

export class LocalFirestore extends FakeFirestore {
  readonly persisted: PersistingMap;
  constructor(dataDir: string, debounceMs?: number) {
    fs.mkdirSync(dataDir, { recursive: true });
    const map = new PersistingMap(path.join(dataDir, STORE_FILE), debounceMs);
    super({}, map);
    this.persisted = map;
  }
  flushSync() { this.persisted.flushSync(); }
}

export class FileArtifactStore implements ArtifactStore {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'artifacts');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private p(objectId: string) { parseObjectId(objectId); return path.join(this.dir, objectId); }

  async put(objectId: string, data: Buffer) {
    const file = this.p(objectId);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  }
  async get(objectId: string, maxBytes: number) {
    const file = this.p(objectId);
    let st: fs.Stats;
    try { st = await fs.promises.stat(file); } catch { throw new ArtifactNotFoundError(); }
    if (st.size > maxBytes) throw new ArtifactTooLargeError();
    try { return await fs.promises.readFile(file); } catch { throw new ArtifactNotFoundError(); }
  }
  async delete(objectId: string) { await fs.promises.rm(this.p(objectId), { force: true }); }
  private async keysFor(simulationId: string) {
    const prefix = `${simulationId}_`;
    return (await fs.promises.readdir(this.dir)).filter((n) => n.startsWith(prefix) && n.endsWith('.bin'));
  }
  async deleteAllForSimulation(simulationId: string) {
    const keys = await this.keysFor(simulationId);
    await Promise.all(keys.map((k) => fs.promises.rm(path.join(this.dir, k), { force: true })));
    return keys.length;
  }
  async sizeForSimulation(simulationId: string) {
    let n = 0;
    for (const k of await this.keysFor(simulationId)) n += (await fs.promises.stat(path.join(this.dir, k))).size;
    return n;
  }
}
