/**
 * HTTP surface for the desktop project store. Mounted ONLY in desktop mode.
 *
 * This is a local loopback server that other websites in the user's browser can also reach, so every request must
 * prove it came from the app's own page: exact Host (DNS-rebinding), exact Origin when present, Sec-Fetch-Site
 * not cross-site, and a custom header that forces a CORS preflight for any cross-origin caller (which is refused).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJsonBody, sendJson } from '../http';
import { DesktopProjectStore, ProjectStoreError, PROJECT_ID_RE } from './projectStore';

export const DESKTOP_HEADER = 'x-cavity-desktop';
export const MAX_PROJECT_BODY_BYTES = 32 * 1024 * 1024;
const PREFIX = '/api/desktop/';

export function createDesktopProjectRoutes(opts: { store: DesktopProjectStore; port: number }) {
  const hosts = new Set([`127.0.0.1:${opts.port}`]);
  const origin = `http://127.0.0.1:${opts.port}`;
  const { store } = opts;

  function allowed(req: IncomingMessage): boolean {
    if (!hosts.has(String(req.headers.host ?? ''))) return false;
    const o = req.headers.origin;
    if (o !== undefined && o !== origin) return false;
    const sfs = req.headers['sec-fetch-site'];
    if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return false;
    return req.headers[DESKTOP_HEADER] === '1';
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', origin);
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      if (!allowed(req)) { sendJson(res, 403, { error: 'Forbidden' }); return true; }
      const route = url.pathname.slice(PREFIX.length);
      const m = req.method ?? 'GET';
      const idMatch = /^projects\/([^/]+)$/.exec(route);
      if (route === 'projects' && m === 'GET') { sendJson(res, 200, { projects: await store.list() }); return true; }
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        if (!PROJECT_ID_RE.test(id)) throw new HttpError(400, 'Invalid project id.');
        if (m === 'GET') { sendJson(res, 200, { project: await store.get(id) }); return true; }
        if (m === 'PUT') {
          const body = await readJsonBody(req, MAX_PROJECT_BODY_BYTES) as any;
          if (body?.project?.id !== id) throw new HttpError(400, 'Project id mismatch.');
          await store.put(body.project);
          sendJson(res, 200, { ok: true }); return true;
        }
        if (m === 'DELETE') { await store.delete(id); sendJson(res, 200, { ok: true }); return true; }
        throw new HttpError(405, 'Method not allowed.');
      }
      if (route === 'active-project') {
        if (m === 'GET') { sendJson(res, 200, { id: await store.getActive() }); return true; }
        if (m === 'PUT') {
          const body = await readJsonBody(req, 1024) as any;
          await store.setActive(body?.id ?? null); sendJson(res, 200, { ok: true }); return true;
        }
        throw new HttpError(405, 'Method not allowed.');
      }
      if (route === 'migration' && m === 'GET') { sendJson(res, 200, { migrated: await store.isMigrated() }); return true; }
      if (route === 'migration' && m === 'POST') {
        const body = await readJsonBody(req, MAX_PROJECT_BODY_BYTES) as any;
        if (!Array.isArray(body?.projects) || body.projects.length > 1000) throw new HttpError(400, 'projects must be an array of at most 1000.');
        sendJson(res, 200, await store.importLegacy(body.projects, typeof body.activeId === 'string' ? body.activeId : null)); return true;
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) { sendJson(res, e.status, { error: e.publicMessage }); return true; }
      if (e instanceof ProjectStoreError) { sendJson(res, e.code === 'invalid' ? 400 : 500, { error: e.code === 'invalid' ? e.message : 'Storage error.' }); return true; }
      sendJson(res, 500, { error: 'Internal error.' }); return true;
    }
  };
}
