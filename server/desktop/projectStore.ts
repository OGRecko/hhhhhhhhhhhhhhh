/**
 * Disk-backed project store for the Windows desktop app.
 *
 * Projects used to live in the renderer's IndexedDB, which is scoped to the page ORIGIN including the loopback
 * port. If the preferred port was busy the app picked a random one and every saved project vanished for that
 * session. Projects now live on disk under <dataDir>/projects, independent of the port.
 *
 *  - one JSON file per project (id validated, so path traversal is structurally impossible)
 *  - atomic writes (temp + fsync + rename) with a .bak of the previous good copy
 *  - a corrupt primary is moved aside (never deleted) and the .bak is used
 *  - non-ENOENT filesystem errors are surfaced, never treated as "empty"
 *  - all mutations are serialised so concurrent requests cannot interleave
 */
import fs from 'node:fs';
import path from 'node:path';
import { logError, logEvent } from '../observability';

export const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export interface ProjectRecord { id: string; name: string; createdAt: number; updatedAt: number; isArchived: boolean; data: unknown }

export class ProjectStoreError extends Error {
  constructor(public readonly code: 'invalid' | 'io', message: string) { super(message); this.name = 'ProjectStoreError'; }
}

export function validateRecord(rec: unknown, expectedId?: string): ProjectRecord {
  const r = rec as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ProjectStoreError('invalid', 'Project must be an object.');
  if (typeof r.id !== 'string' || !PROJECT_ID_RE.test(r.id)) throw new ProjectStoreError('invalid', 'Invalid project id.');
  if (expectedId !== undefined && r.id !== expectedId) throw new ProjectStoreError('invalid', 'Project id mismatch.');
  if (typeof r.name !== 'string' || r.name.length > 200) throw new ProjectStoreError('invalid', 'Invalid project name.');
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt)) throw new ProjectStoreError('invalid', 'Invalid timestamps.');
  if (typeof r.isArchived !== 'boolean') throw new ProjectStoreError('invalid', 'Invalid archive flag.');
  if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) throw new ProjectStoreError('invalid', 'Project data must be an object.');
  return { id: r.id, name: r.name, createdAt: r.createdAt as number, updatedAt: r.updatedAt as number, isArchived: r.isArchived, data: r.data };
}

function atomicWrite(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const bak = `${file}.bak`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (fs.existsSync(file)) {
      // The save itself must still proceed, but a failed backup means the next corruption is NOT recoverable: say so.
      try { fs.copyFileSync(file, bak); } catch (e) { logError('project_backup_failed', e, { file: path.basename(file) }); }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows may transiently refuse a rename over an open file; never delete the live file first.
    try { if (fs.existsSync(file)) fs.renameSync(file, bak); fs.renameSync(tmp, file); }
    catch (e2) { fs.rmSync(tmp, { force: true }); throw e2 ?? e; }
  }
}

/** Reads a JSON file with .bak recovery. Returns null only when neither copy exists (ENOENT). */
function readJsonWithBackup<T>(file: string, check: (v: unknown) => T): T | null {
  const name = path.basename(file);
  type Attempt = { ok: true; v: T } | { ok: false; missing: boolean; cause?: unknown };
  const tryRead = (f: string): Attempt => {
    let raw: string;
    try { raw = fs.readFileSync(f, 'utf8'); }
    catch (e: any) { if (e?.code === 'ENOENT') return { ok: false, missing: true }; throw new ProjectStoreError('io', `Cannot read ${path.basename(f)} (${e?.code || e}).`); }
    try { return { ok: true, v: check(JSON.parse(raw)) }; }
    catch (e) { return { ok: false, missing: false, cause: e }; }
  };
  const a = tryRead(file);
  if (a.ok) return a.v;
  if (!a.missing) {
    const dest = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, dest); logError('project_file_corrupt', a.cause, { file: name, keptAs: path.basename(dest) }); }
    catch (e) { logError('project_file_corrupt_not_moved', a.cause, { file: name, moveError: String(e) }); }
  }
  const b = tryRead(`${file}.bak`);
  if (b.ok) {
    if (!a.missing) logEvent('project_recovered_from_backup', { file: name });
    return b.v;
  }
  if (!b.missing) logError('project_backup_corrupt', b.cause, { file: `${name}.bak` });
  if (!a.missing) logEvent('project_unrecoverable', { file: name, note: 'primary corrupt and no usable backup; the damaged file was kept aside' });
  return null;
}

export class DesktopProjectStore {
  private readonly dir: string;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'projects');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private file(id: string) {
    if (!PROJECT_ID_RE.test(id)) throw new ProjectStoreError('invalid', 'Invalid project id.');
    return path.join(this.dir, `${id}.json`);
  }
  /** Serialises operations so concurrent callers never interleave a read-modify-write. */
  private run<T>(fn: () => T): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined); // keep the queue alive after a failed op; `next` itself still rejects to its own caller
    return next;
  }
  list(): Promise<ProjectRecord[]> {
    return this.run(() => {
      const out: ProjectRecord[] = [];
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!PROJECT_ID_RE.test(id)) continue;
        const rec = readJsonWithBackup(this.file(id), (v) => validateRecord(v, id));
        if (rec) out.push(rec);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }
  get(id: string): Promise<ProjectRecord | null> {
    return this.run(() => readJsonWithBackup(this.file(id), (v) => validateRecord(v, id)));
  }
  put(rec: ProjectRecord): Promise<void> {
    const clean = validateRecord(rec);
    return this.run(() => { atomicWrite(this.file(clean.id), JSON.stringify(clean)); });
  }
  delete(id: string): Promise<void> {
    return this.run(() => { const f = this.file(id); fs.rmSync(f, { force: true }); fs.rmSync(`${f}.bak`, { force: true }); });
  }
  getActive(): Promise<string | null> {
    return this.run(() => readJsonWithBackup(path.join(this.dir, 'settings.json'), (v) => {
      const a = (v as any)?.activeProjectId;
      if (a !== null && !(typeof a === 'string' && PROJECT_ID_RE.test(a))) throw new Error('bad settings');
      return { activeProjectId: a as string | null, migratedFromIndexedDb: (v as any)?.migratedFromIndexedDb === true };
    })?.activeProjectId ?? null);
  }
  private readSettings() {
    return readJsonWithBackup(path.join(this.dir, 'settings.json'), (v) => ({
      activeProjectId: (typeof (v as any)?.activeProjectId === 'string' && PROJECT_ID_RE.test((v as any).activeProjectId)) ? (v as any).activeProjectId as string : null,
      migratedFromIndexedDb: (v as any)?.migratedFromIndexedDb === true,
    })) ?? { activeProjectId: null, migratedFromIndexedDb: false };
  }
  setActive(id: string | null): Promise<void> {
    if (id !== null && !PROJECT_ID_RE.test(id)) throw new ProjectStoreError('invalid', 'Invalid project id.');
    return this.run(() => atomicWrite(path.join(this.dir, 'settings.json'), JSON.stringify({ ...this.readSettings(), activeProjectId: id })));
  }
  isMigrated(): Promise<boolean> { return this.run(() => this.readSettings().migratedFromIndexedDb); }
  /** One-time import of legacy IndexedDB projects. Never overwrites a project that already exists on disk. */
  importLegacy(records: unknown[], activeId: string | null): Promise<{ imported: number; skipped: number; invalid: number }> {
    return this.run(() => {
      let imported = 0, skipped = 0, invalid = 0;
      for (const r of records) {
        let rec: ProjectRecord;
        try { rec = validateRecord(r); } catch { invalid++; continue; }
        const f = this.file(rec.id);
        if (fs.existsSync(f)) { skipped++; continue; }
        atomicWrite(f, JSON.stringify(rec)); imported++;
      }
      // Only mark migration done when this origin actually held legacy projects. An empty IndexedDB (e.g. the app fell
      // back to a random port this launch) must NOT close the door on importing the stable-port origin's projects later.
      if (records.length === 0) return { imported, skipped, invalid };
      const s = this.readSettings();
      atomicWrite(path.join(this.dir, 'settings.json'), JSON.stringify({
        activeProjectId: s.activeProjectId ?? (activeId && PROJECT_ID_RE.test(activeId) ? activeId : null), migratedFromIndexedDb: true }));
      return { imported, skipped, invalid };
    });
  }
}
