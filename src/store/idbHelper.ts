import { openDB, DBSchema, IDBPDatabase } from 'idb';

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  isArchived: boolean;
  data: any;
}

interface AppSettings {
  id: string; // 'activeProjectId'
  value: string | null;
}

interface CavityDB extends DBSchema {
  projects: {
    key: string;
    value: ProjectRecord;
    indexes: { 'by-updated': number };
  };
  settings: {
    key: string;
    value: AppSettings;
  };
}

let dbPromise: Promise<IDBPDatabase<CavityDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<CavityDB>('cavity-audio-projects', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          const store = db.createObjectStore('projects', { keyPath: 'id' });
          store.createIndex('by-updated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

// ---- Desktop backend: projects on disk (independent of the loopback port). Browser build keeps IndexedDB. ----
const DESKTOP_HDR = { 'x-cavity-desktop': '1' };
let backendPromise: Promise<'desktop' | 'idb'> | null = null;

async function desktopFetch(path: string, init: RequestInit = {}) {
  const r = await fetch(`/api/desktop/${path}`, { ...init, headers: { ...DESKTOP_HDR, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  if (!r.ok) throw new Error(`Project storage failed (${r.status}).`);
  return r.json();
}

/** Reads every legacy IndexedDB project (if the database exists) without creating it. */
async function readLegacyIdb(): Promise<{ projects: ProjectRecord[]; activeId: string | null }> {
  // Only "there is no legacy database" may yield an empty result. A real read failure must THROW: the caller
  // marks the migration finished after this returns, so swallowing an error here would silently abandon the
  // user's saved projects.
  if (typeof indexedDB === 'undefined') return { projects: [], activeId: null };
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof idb.databases === 'function') {
    const dbs = await idb.databases();
    if (!dbs.some((d) => d?.name === 'cavity-audio-projects')) return { projects: [], activeId: null };
  }
  const db = await getDB();
  return { projects: await db.getAll('projects'), activeId: (await db.get('settings', 'activeProjectId'))?.value ?? null };
}

function backend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      let health: { desktopStorage?: boolean } | null = null;
      try { health = await (await fetch('/api/health')).json(); }
      catch (e) { console.warn('Could not reach /api/health; using browser IndexedDB storage for projects.', e); }
      if (health?.desktopStorage !== true) return 'idb' as const;
      // One-time, non-destructive import of projects saved by earlier versions under any port's IndexedDB origin.
      // (Origins for other ports cannot be read from here; the stable-port origin is the one earlier versions used.)
      try {
        const m = await desktopFetch('migration');
        if (!m.migrated) { const legacy = await readLegacyIdb(); await desktopFetch('migration', { method: 'POST', body: JSON.stringify(legacy) }); }
      } catch (e) { console.error('Legacy project import failed; will retry next launch.', e); }
      return 'desktop' as const;
    })();
  }
  return backendPromise;
}

export const LocalStore = {
  async getProjects(): Promise<ProjectRecord[]> {
    if (await backend() === 'desktop') return (await desktopFetch('projects')).projects;
    const db = await getDB();
    const all = await db.getAllFromIndex('projects', 'by-updated');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async getProject(id: string): Promise<ProjectRecord | undefined> {
    if (await backend() === 'desktop') return (await desktopFetch(`projects/${encodeURIComponent(id)}`)).project ?? undefined;
    const db = await getDB();
    return await db.get('projects', id);
  },
  async saveProject(project: ProjectRecord) {
    if (await backend() === 'desktop') { await desktopFetch(`projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: JSON.stringify({ project }) }); return; }
    const db = await getDB();
    await db.put('projects', project);
  },
  async deleteProject(id: string) {
    if (await backend() === 'desktop') { await desktopFetch(`projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); return; }
    const db = await getDB();
    await db.delete('projects', id);
  },
  async getActiveProjectId(): Promise<string | null> {
    if (await backend() === 'desktop') return (await desktopFetch('active-project')).id ?? null;
    const db = await getDB();
    const setting = await db.get('settings', 'activeProjectId');
    return setting?.value ?? null;
  },
  async setActiveProjectId(id: string | null) {
    if (await backend() === 'desktop') { await desktopFetch('active-project', { method: 'PUT', body: JSON.stringify({ id }) }); return; }
    const db = await getDB();
    await db.put('settings', { id: 'activeProjectId', value: id });
  }
};
