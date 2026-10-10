/**
 * Composition root. All request handling lives in server/api.ts; this file
 * only wires configuration, Firebase, the dispatcher and Express together.
 *
 * Production fails fast: loadConfig() throws on any missing/weak setting and
 * the process exits before it opens a port.
 */
import { DesktopProjectStore } from './server/desktop/projectStore';
import { createDesktopProjectRoutes } from './server/desktop/projectRoutes';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { Admission } from './server/admission';
import { createApi } from './server/api';
import { runCleanup } from './server/cleanup';
import { ConfigError, loadConfig, type AppConfig } from './server/config';
import { Dispatcher } from './server/dispatcher';
import { CloudTaskDispatcher } from './server/cloudTaskDispatcher';
import { createFirebase } from './server/firebase';
import { JobStore } from './server/jobStore';
import { logError, logEvent, metrics } from './server/observability';
import { pdfReportRenderer } from './server/reportRenderer';
import { createWorkerRunner } from './server/workerRunner';
import { LIMITS } from './src/lib/publicLimits';

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      // Messages name the missing/invalid SETTING only; they never contain a secret value.
      console.error(e.message);
    } else {
      console.error('Configuration failed.');
    }
    process.exit(1);
  }
}

const CSP = {
  useDefaults: false,
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:'],
    mediaSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'"],
    workerSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
  },
} as const;

// Desktop only: forces the debounced local store to disk. Electron's app.exit() skips before-quit, so the shell
// calls this explicitly instead of relying on a process 'exit' listener to catch the last write.
let flushHook: () => void = () => {};
export function flushStore(): void {
  // Called on exit paths where nothing can be retried: a failure means recent jobs may not be on disk, so log it.
  try { flushHook(); } catch (e) { logError('store_flush_on_exit_failed', e); }
}

async function main() {
  const config = loadConfigOrExit();
  const isProd = config.env === 'production';
  const desktop = config.desktop;

  const { db, artifacts } = createFirebase(config);
  if (desktop && typeof (db as any).flushSync === 'function') flushHook = () => (db as any).flushSync();
  const store = new JobStore(db, Date.now, metrics);
  const admission = new Admission(db, config.ipSalt);
  const workerId = `w-${crypto.randomBytes(6).toString('hex')}`;
  const runner = createWorkerRunner();

  const dispatcher = new Dispatcher({
    store,
    maxConcurrent: LIMITS.MAX_CONCURRENT_SOLVER_JOBS,
    executor: {
      store, artifacts, metrics, workerId,
      runSolver: runner,
      log: (event, fields) => logEvent(event, fields),
      onHeartbeat: (rec) => (rec.slotId ? admission.extendSlot(rec.slotId, LIMITS.SOLVER_SLOT_TTL_MS) : Promise.resolve()),
      onFinished: (rec) => admission.releaseSlot(rec.slotId),
    },
    log: (event, fields) => logEvent(event, fields),
    onJobEndedWithoutRun: (rec) => admission.releaseSlot(rec.slotId),
  });

  const cloudTasks = new CloudTaskDispatcher({
    enabled: config.cloudTasks.enabled,
    projectId: config.cloudTasks.projectId!,
    location: config.cloudTasks.location,
    queue: config.cloudTasks.queue,
    targetUrl: config.cloudTasks.targetUrl!,
    dispatchSecret: config.cloudTasks.dispatchSecret!,
  }, config.credentials ? { client_email: config.credentials.clientEmail, private_key: config.credentials.privateKey } : undefined);

  const api = createApi({
    store, artifacts, admission, dispatcher, metrics,
    cloudTasks: cloudTasks.enabled ? cloudTasks : undefined,
    renderReport: pdfReportRenderer,
    cleanup: { store, artifacts, admission, metrics },
    config: { trustProxy: config.trustProxy, cleanupSecret: config.cleanupSecret, allowedOrigin: config.allowedOrigin, desktopStorage: desktop },
  });

  const app = express();
  app.disable('x-powered-by');
  // Client addresses are resolved by the API itself from TRUST_PROXY; Express's own proxy logic is unused.
  app.set('trust proxy', false);
  app.use(helmet({
    contentSecurityPolicy: isProd ? CSP : false, // Vite's dev middleware injects inline HMR scripts
    crossOriginEmbedderPolicy: false,
  }));

  // ---- Windows EXE release artifact ------------------------------------
  // Only advertised once scripts/release-exe.mjs has produced a validated EXE + manifest.
  const releasesDir = path.resolve(process.env.RELEASES_DIR || path.join(process.env.CAVITY_APP_ROOT || process.cwd(), 'releases'));
  // The manifest hash is verified against the real file once per (path,size,mtime); the result is cached so
  // downloads never re-hash 90+ MB per request, yet a swapped/corrupted file is still caught.
  const verifiedHash = new Map<string, boolean>();
  const fileSha256 = (abs: string): string => {
    const h = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(1 << 20); const fd = fs.openSync(abs, 'r');
    try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
    return h.digest('hex');
  };
  // Serve-time guard (in addition to release:verify at build time): an .exe name is not enough, the file must be a
  // real Windows executable (MZ header, valid e_lfanew, "PE\0\0" signature). Rejects a renamed ZIP/HTML/JSON.
  const looksLikePortableExecutable = (abs: string): boolean => {
    const fd = fs.openSync(abs, 'r');
    try {
      const head = Buffer.alloc(64);
      if (fs.readSync(fd, head, 0, 64, 0) < 64 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
      const peOffset = head.readUInt32LE(0x3c);
      const sig = Buffer.alloc(4);
      return peOffset >= 64 && peOffset < 1 << 20 && fs.readSync(fd, sig, 0, 4, peOffset) === 4 && sig.equals(Buffer.from([0x50, 0x45, 0, 0]));
    } finally { fs.closeSync(fd); }
  };
  const readRelease = (): { file: string; version: string; size: number; sha256: string; abs: string } | null => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(releasesDir, 'manifest.json'), 'utf8'));
      if (typeof m.file !== 'string' || path.basename(m.file) !== m.file || !m.file.toLowerCase().endsWith('.exe')) return null;
      const abs = path.join(releasesDir, m.file);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size !== m.size) return null;
      const key = `${abs}:${st.size}:${st.mtimeMs}:${m.sha256}`;
      if (!verifiedHash.has(key)) { verifiedHash.clear(); verifiedHash.set(key, looksLikePortableExecutable(abs) && fileSha256(abs) === String(m.sha256).toLowerCase()); }
      if (!verifiedHash.get(key)) return null;
      return { file: m.file, version: String(m.version), size: st.size, sha256: String(m.sha256), abs };
    } catch { return null; }
  };
  app.get('/release/windows', (_req, res) => {
    const r = readRelease();
    res.set('Cache-Control', 'no-store');
    if (!r) { res.json({ available: false }); return; }
    res.json({ available: true, version: r.version, file: r.file, size: r.size, sha256: r.sha256, url: '/download/windows-exe' });
  });
  app.get('/download/windows-exe', (_req, res) => {
    const r = readRelease();
    if (!r) { res.status(404).json({ error: 'Windows build is not available yet.' }); return; }
    res.set('Cache-Control', 'no-store');
    res.download(r.abs, r.file);
  });

  // Desktop only: port-independent, disk-backed project storage (loopback; guarded by Host/Origin/header checks).
  if (desktop && config.dataDir) {
    const desktopProjects = createDesktopProjectRoutes({ store: new DesktopProjectStore(config.dataDir), port: config.port });
    app.use((req, res, next) => { desktopProjects(req, res).then((handled) => { if (!handled) next(); }, next); });
  }
  app.use((req, res, next) => { api(req, res).then((handled) => { if (!handled) next(); }, next); });

  const serveBuiltClient = isProd;
  if (!serveBuiltClient) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.env.CAVITY_APP_ROOT || process.cwd(), 'dist');
    app.use(express.static(distPath, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // Last-resort handler: never echo internals.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logError('unhandled_request_error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
    else res.end();
  });

  const bindHost = desktop ? '127.0.0.1' : '0.0.0.0';
  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(config.port, bindHost, () => {
      logEvent('server_started', { port: config.port, env: config.env, desktop, workerId });
      resolve(s);
    });
    s.once('error', reject); // e.g. EADDRINUSE: surface it instead of crashing with an uncaught error
  });
  // Connection-level timeouts (slow-loris, hung sockets).
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  dispatcher.start();
  void dispatcher.sweepOnce().catch((e) => logError('initial_sweep_failed', e));
  const cleanupTimer = setInterval(() => {
    void runCleanup({ store, artifacts, admission, metrics }).catch((e) => logError('scheduled_cleanup_failed', e));
  }, 60 * 60 * 1000);
  cleanupTimer.unref?.();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('shutdown_started', { signal });
    dispatcher.stop();
    server.close();
    flushStore();
    // Let in-flight jobs finish briefly; anything left is recovered by another instance after its lease expires.
    const deadline = new Promise<void>((r) => { setTimeout(r, 8_000).unref?.(); });
    void Promise.race([dispatcher.whenIdle(), deadline]).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logError('unhandled_rejection', e));
}

/**
 * Resolves once the server is listening. The desktop shell awaits this so a
 * startup failure becomes a visible error dialog; every other mode keeps the
 * fail-fast behaviour (log and exit non-zero before serving anything).
 */
export const ready: Promise<void> = main().catch((e) => {
  logError('startup_failed', e);
  if (process.env.CAVITY_DESKTOP === '1') throw e;
  process.exit(1);
});
