/**
 * The public HTTP API, as a plain Node request handler.
 *
 * It has no Express dependency: server.ts mounts it inside Express in
 * production, and the tests drive the very same handler over a real TCP socket.
 * Because of that there is exactly one implementation of every rule below.
 *
 * SECURITY MODEL (anonymous, capability-token authorised)
 *  - A capability token is 256 random bits. Only its SHA-256 hash is stored.
 *  - It is accepted ONLY in `Authorization: Bearer <token>` (never URL/body).
 *  - Every "no" is the same 403 {"error":"Forbidden"}: missing token, wrong
 *    token, someone else's token, a guessed/unknown ID and a malformed ID are
 *    indistinguishable, so IDs cannot be enumerated and existence never leaks.
 *  - Error bodies are fixed public strings. Internal errors are logged
 *    (redacted) and answered with a generic 500.
 */
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIMITS, isUuid, preflightSolver, validateSolverRequest } from '../src/lib/publicLimits';
import { Admission } from './admission';
import { authorizeArtifact, authorizeJob, authorizeReport } from './artifactAccess';
import { createCapabilityToken, extractBearerToken, hashCapabilityToken } from './capabilityToken';
import { expireSimulation, runCleanup, type CleanupDeps, type CleanupSummary } from './cleanup';
import { secretsEqual } from './config';
import { HttpError, LocalRateLimiter, clientIp, readJsonBody, sendBuffer, sendJson } from './http';
import { PUBLIC_ERROR_MESSAGES, type JobRecord, type JobStore, type PublicErrorCode } from './jobStore';
import { logError, logEvent, type Metrics, redactValue } from './observability';
import { ReportNotReadyError, buildReportInput } from './reportInput';
import { ReportAbortedError, ReportTimeoutError, ReportTooLargeError, type ReportRenderer } from './reportRenderer';
import { ArtifactNotFoundError, ArtifactTooLargeError, type ArtifactStore } from './storage';

export interface ApiDeps {
  store: JobStore;
  artifacts: ArtifactStore;
  admission: Admission;
  dispatcher: { enqueue(id: string): boolean | Promise<boolean>; cancelLocal(id: string): void };
  cloudTasks?: { authorize(secret: unknown): boolean; enqueue(id: string): Promise<boolean> };
  renderReport: ReportRenderer;
  metrics: Metrics;
  cleanup: Pick<CleanupDeps, 'store' | 'artifacts' | 'admission' | 'metrics'>;
  config: { trustProxy: number | false; cleanupSecret: string; allowedOrigin: string | null; desktopStorage?: boolean };
  now?: () => number;
  newId?: () => string;
}

const FORBIDDEN = { error: 'Forbidden' } as const;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** Reads `simulationId` from an untrusted JSON body without assuming its shape (validated by isUuid at the call site). */
function bodySimulationId(body: unknown): unknown {
  return typeof body === 'object' && body !== null ? (body as { simulationId?: unknown }).simulationId : undefined;
}

export function createApi(deps: ApiDeps): ApiHandler {
  const { store, artifacts, admission, dispatcher, metrics } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const local = new LocalRateLimiter(now);
  let reportsInFlight = 0;
  let cleanupRunning: Promise<CleanupSummary> | null = null;

  const ipOf = (req: IncomingMessage) => clientIp(req, deps.config.trustProxy);

  /** Cross-instance limiter. Fails CLOSED: if the limiter itself is unavailable the request is refused. */
  async function limit(res: ServerResponse, route: string, ip: string, windowMs: number, max: number, message: string): Promise<boolean> {
    let r;
    try { r = await admission.rateLimit(route, ip, windowMs, max); }
    catch (e) { logError('rate_limiter_unavailable', e); throw new HttpError(503, 'Service temporarily unavailable.'); }
    if (!r.allowed) {
      metrics.inc('rate_limit_rejections');
      sendJson(res, 429, { error: message }, { 'Retry-After': String(r.retryAfterSeconds) });
      return false;
    }
    return true;
  }

  /** Cheap per-instance limiter for reads and for anything that fails authorisation. */
  function localLimit(res: ServerResponse, key: string, windowMs: number, max: number, message: string): boolean {
    const r = local.hit(key, windowMs, max);
    if (!r.allowed) {
      metrics.inc('rate_limit_rejections');
      sendJson(res, 429, { error: message }, { 'Retry-After': String(r.retryAfterSeconds) });
      return false;
    }
    return true;
  }

  function deny(res: ServerResponse, ip: string): void {
    metrics.inc('auth_rejections');
    // Repeated failures from one address are throttled so tokens/IDs cannot be brute-forced cheaply.
    local.hit(`authfail:${ip}`, MINUTE, LIMITS.AUTH_FAILURES_PER_IP_PER_MINUTE);
    sendJson(res, 403, FORBIDDEN);
  }

  const authFailuresExceeded = (ip: string) => local.isBlocked(`authfail:${ip}`, MINUTE, LIMITS.AUTH_FAILURES_PER_IP_PER_MINUTE);

  // ---------------------------------------------------------------- handlers

  async function submit(req: IncomingMessage, res: ServerResponse, kind: 'wave' | 'impulse-response') {
    const ip = ipOf(req);
    if (!localLimit(res, `write:${ip}`, MINUTE, 120, 'Too many requests.')) return;

    const body = await readJsonBody(req, LIMITS.MAX_JSON_BODY_BYTES);
    const v = validateSolverRequest(body, kind);
    if (!v.ok) {
      if (/limit|between|at most|array of length|outside|exceed/i.test(v.error)) metrics.inc('resource_limit_rejections');
      throw new HttpError(400, v.error);
    }
    const pre = preflightSolver(v.request, kind);
    if (!pre.ok) {
      metrics.inc('resource_limit_rejections');
      if (pre.kind === 'requires_confirmation') {
        throw new HttpError(422, pre.error, { requiresConfirmation: true, ...pre.details });
      }
      throw new HttpError(400, pre.error);
    }

    if (!(await limit(res, 'solver-hour', ip, HOUR, LIMITS.SOLVER_SUBMISSIONS_PER_IP_PER_HOUR, 'Hourly simulation limit reached. Please try again later.'))) return;
    if (!(await limit(res, 'solver-cooldown', ip, LIMITS.SOLVER_COOLDOWN_MS, 1, 'Please wait before running another simulation.'))) return;

    let slot;
    try { slot = await admission.acquireSlot(ip, LIMITS.SOLVER_SLOT_TTL_MS); }
    catch (e) { logError('admission_unavailable', e); throw new HttpError(503, 'Service temporarily unavailable.'); }
    if (!slot.ok) {
      metrics.inc('concurrency_rejections');
      sendJson(res, 429, { error: slot.reason === 'per_ip'
        ? 'You already have a simulation running. Wait for it to finish or cancel it.'
        : 'The server is busy computing other simulations. Please try again in a moment.' }, { 'Retry-After': '5' });
      return;
    }

    const capabilityToken = createCapabilityToken();
    const simulationId = newId();
    const jobId = newId();
    const request = v.request;
    const { sources, receivers, ...roomFields } = request;
    let created = false;
    try {
      created = await store.createQueued({
        simulationId, jobId, type: kind,
        capabilityTokenHash: hashCapabilityToken(capabilityToken),
        createdAt: now(),
        jobPayload: request as unknown as Record<string, unknown>,
        slotId: slot.slotId,
        room: { L: request.L, W: request.W, H: request.H, poly: request.poly, wallMaterial: roomFields.wallMaterial, wallSegMats: request.wallSegMats, wallOpenings: request.wallOpenings, floorMaterial: roomFields.floorMaterial, ceilMaterial: roomFields.ceilMaterial, projectName: request.projectName, roomName: request.roomName },
        speakers: sources,
        receivers,
      });
    } catch (e) {
      await admission.releaseSlot(slot.slotId).catch((err) => logError('admission_release_failed', err, { simulationId }));
      throw e;
    }
    if (!created) {
      await admission.releaseSlot(slot.slotId).catch((err) => logError('admission_release_failed', err, { simulationId }));
      throw new HttpError(503, 'Service temporarily unavailable.');
    }
    if (deps.cloudTasks) {
      try {
        await deps.cloudTasks.enqueue(simulationId);
      } catch (e) {
        logError('cloud_task_enqueue_failed', e, { simulationId });
        await store.cancel(simulationId).catch((err) => logError('cancel_after_enqueue_failure_failed', err, { simulationId }));
        await admission.releaseSlot(slot.slotId).catch((err) => logError('admission_release_failed', err, { simulationId }));
        throw new HttpError(503, 'Service temporarily unavailable.');
      }
    }
    await dispatcher.enqueue(simulationId);
    logEvent('simulation_queued', { simulationId, type: kind });
    sendJson(res, 202, { jobId, status: 'queued', capabilityToken });
  }

  const publicJob = (rec: JobRecord) => {
    const out: Record<string, unknown> = {
      jobId: rec.jobId, simulationId: rec.simulationId, type: rec.type, status: rec.status, createdAt: rec.createdAt,
    };
    if (rec.completedAt) out.completedAt = rec.completedAt;
    if (rec.status === 'completed') out.result = rec.result;
    if (rec.errorCode) {
      const code = rec.errorCode as PublicErrorCode;
      out.error = { code, message: PUBLIC_ERROR_MESSAGES[code] ?? 'The simulation failed.' };
    }
    return out;
  };

  async function getJob(req: IncomingMessage, res: ServerResponse, jobId: string) {
    const ip = ipOf(req);
    if (!localLimit(res, `read:${ip}`, MINUTE, LIMITS.READS_PER_IP_PER_MINUTE, 'Too many requests.')) return;
    if (authFailuresExceeded(ip)) { sendJson(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '60' }); return; }
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return deny(res, ip);
    const a = await authorizeJob(store, jobId, token);
    if (!a.ok) return deny(res, ip);
    sendJson(res, 200, publicJob(a.value));
  }

  async function cancelJob(req: IncomingMessage, res: ServerResponse, jobId: string) {
    const ip = ipOf(req);
    if (!localLimit(res, `write:${ip}`, MINUTE, 120, 'Too many requests.')) return;
    if (authFailuresExceeded(ip)) { sendJson(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '60' }); return; }
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return deny(res, ip);
    const a = await authorizeJob(store, jobId, token);
    if (!a.ok) return deny(res, ip);
    const rec = a.value;
    const r = await store.cancel(rec.simulationId);
    if (!r.ok) return deny(res, ip);
    if (!r.alreadyFinished) {
      metrics.inc('simulations_cancelled');
      dispatcher.cancelLocal(rec.simulationId);
      await admission.releaseSlot(rec.slotId).catch((err) => logError('admission_release_failed', err, { simulationId: rec.simulationId }));
    }
    sendJson(res, 200, { success: true, status: r.status, alreadyFinished: r.alreadyFinished });
  }

  async function getArtifact(req: IncomingMessage, res: ServerResponse, url: URL) {
    const ip = ipOf(req);
    if (!localLimit(res, `read:${ip}`, MINUTE, LIMITS.READS_PER_IP_PER_MINUTE, 'Too many requests.')) return;
    if (authFailuresExceeded(ip)) { sendJson(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '60' }); return; }
    const ids = url.searchParams.getAll('id');
    if (ids.length !== 1) throw new HttpError(400, 'An object id is required.');
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return deny(res, ip);
    const a = await authorizeArtifact(store, ids[0], token);
    if (!a.ok) return deny(res, ip);
    try {
      const data = await artifacts.get(a.value.objectId, LIMITS.MAX_SERVED_OBJECT_BYTES);
      sendBuffer(res, 200, 'application/octet-stream', data);
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) throw new HttpError(404, 'Not found.');
      if (e instanceof ArtifactTooLargeError) throw new HttpError(413, 'Object too large.');
      metrics.inc('storage_failures');
      throw e;
    }
  }

  async function exportReport(req: IncomingMessage, res: ServerResponse) {
    const ip = ipOf(req);
    if (!localLimit(res, `write:${ip}`, MINUTE, 120, 'Too many requests.')) return;
    if (authFailuresExceeded(ip)) { sendJson(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '60' }); return; }

    // The body may carry ONLY a simulation id (and an optional assumed SNR). Anything else is ignored, never used.
    const body = await readJsonBody(req, LIMITS.MAX_REPORT_BODY_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be a JSON object.');
    const { simulationId, assumedSnrDb } = body as Record<string, unknown>;
    if (typeof simulationId !== 'string' || simulationId.length === 0 || simulationId.length > 64) throw new HttpError(400, 'simulationId is required.');
    let snr: number | undefined;
    if (assumedSnrDb !== undefined && assumedSnrDb !== null) {
      if (typeof assumedSnrDb !== 'number' || !Number.isFinite(assumedSnrDb) || assumedSnrDb < LIMITS.MIN_ASSUMED_SNR_DB || assumedSnrDb > LIMITS.MAX_ASSUMED_SNR_DB) {
        throw new HttpError(400, `assumedSnrDb must be a number between ${LIMITS.MIN_ASSUMED_SNR_DB} and ${LIMITS.MAX_ASSUMED_SNR_DB}.`);
      }
      snr = assumedSnrDb;
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) return deny(res, ip);
    if (!(await limit(res, 'report-export', ip, HOUR, LIMITS.REPORT_EXPORTS_PER_IP_PER_HOUR, 'Too many report exports. Please try again later.'))) return;

    const a = await authorizeReport(store, simulationId, token);
    if (!a.ok) {
      if (a.reason === 'not_ready') throw new HttpError(409, 'Report is available only after the simulation completes.');
      return deny(res, ip);
    }

    if (reportsInFlight >= LIMITS.MAX_CONCURRENT_REPORTS) {
      metrics.inc('concurrency_rejections');
      sendJson(res, 429, { error: 'The server is busy. Please try again in a moment.' }, { 'Retry-After': '5' });
      return;
    }
    reportsInFlight++;
    try {
      let input;
      try { input = await buildReportInput(a.value, artifacts, snr); }
      catch (e) {
        if (e instanceof ReportNotReadyError) throw new HttpError(409, 'Report is available only after the simulation completes.');
        throw e;
      }
      let pdf: Buffer;
      // Stop rendering if the client goes away before the response is written.
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.once('close', onClose);
      try { pdf = await deps.renderReport(input, ac.signal); }
      catch (e) {
        if (e instanceof ReportAbortedError) return; // client is gone; nothing to send

        if (e instanceof ReportTooLargeError) throw new HttpError(413, 'Report too large.');
        if (e instanceof ReportTimeoutError) throw new HttpError(503, 'Report generation timed out.');
        throw e;
      } finally { res.removeListener('close', onClose); }
      sendBuffer(res, 200, 'application/pdf', pdf, {
        'Content-Disposition': `attachment; filename="cavity_report_${a.value.simulationId}.pdf"`,
      });
    } finally {
      reportsInFlight--;
    }
  }

  async function clientError(req: IncomingMessage, res: ServerResponse) {
    const ip = ipOf(req);
    if (!localLimit(res, `clienterr:${ip}`, MINUTE, LIMITS.CLIENT_ERROR_REPORTS_PER_IP_PER_MINUTE, 'Too many error reports.')) return;
    const body = await readJsonBody(req, LIMITS.MAX_CLIENT_ERROR_BODY_BYTES);
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof b.message !== 'string' || !b.message) throw new HttpError(400, 'Invalid error format.');
    const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
    // logEvent redacts tokens, keys and IPs and JSON-encodes every field (no log-line injection).
    logEvent('client_error', { message: cut(b.message, 500), location: cut(b.location, 500), stack: cut(b.stack, 2000) });
    sendJson(res, 200, { ok: true });
  }

  /** Shared-secret gate for the operator endpoints. Only FAILED attempts consume the limit. */
  async function internalAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const ip = ipOf(req);
    let blocked: boolean;
    try { blocked = await admission.isRateLimited('cleanup-auth', ip, 15 * MINUTE, LIMITS.CLEANUP_AUTH_FAILURES_PER_IP); }
    catch (e) { logError('rate_limiter_unavailable', e); throw new HttpError(503, 'Service temporarily unavailable.'); }
    if (blocked) { metrics.inc('rate_limit_rejections'); sendJson(res, 429, { error: 'Too many attempts.' }, { 'Retry-After': '900' }); return false; }
    const raw = req.headers['x-cleanup-secret'];
    const supplied = typeof raw === 'string' && raw.length <= 256 ? raw : undefined;
    if (!secretsEqual(supplied, deps.config.cleanupSecret)) {
      metrics.inc('auth_rejections');
      try { await admission.rateLimit('cleanup-auth', ip, 15 * MINUTE, LIMITS.CLEANUP_AUTH_FAILURES_PER_IP); }
      catch (e) { logError('rate_limiter_unavailable', e); }
      sendJson(res, 403, FORBIDDEN);
      return false;
    }
    return true;
  }

  async function cleanup(req: IncomingMessage, res: ServerResponse) {
    if (!(await internalAuth(req, res))) return;
    let only: string | undefined;
    if (req.headers['content-length'] && req.headers['content-length'] !== '0') {
      const body = await readJsonBody(req, 1024);
      const id = bodySimulationId(body);
      if (id !== undefined) {
        if (!isUuid(id)) throw new HttpError(400, 'simulationId must be a UUID.');
        only = id;
      }
    }
    const cdeps: CleanupDeps = { ...deps.cleanup, now };
    if (only) { sendJson(res, 200, { ok: true, ...(await expireSimulation(cdeps, only)) }); return; }
    if (cleanupRunning) { sendJson(res, 202, { ok: true, alreadyRunning: true }); return; }
    cleanupRunning = runCleanup(cdeps).finally(() => { cleanupRunning = null; });
    sendJson(res, 200, { ok: true, ...(await cleanupRunning) });
  }

  async function metricsRoute(req: IncomingMessage, res: ServerResponse) {
    if (!(await internalAuth(req, res))) return;
    sendJson(res, 200, metrics.snapshot());
  }

  async function runJobTask(req: IncomingMessage, res: ServerResponse) {
    if (!deps.cloudTasks || !deps.cloudTasks.authorize(req.headers['x-job-dispatch-secret'])) {
      sendJson(res, 403, FORBIDDEN);
      return;
    }
    const body = await readJsonBody(req, 2048);
    const simulationId = bodySimulationId(body);
    if (!isUuid(simulationId)) throw new HttpError(400, 'Invalid job.');
    const accepted = await dispatcher.enqueue(simulationId);
    sendJson(res, accepted === false ? 503 : 202, { status: accepted === false ? 'busy' : 'accepted' });
  }

  // ------------------------------------------------------------------ router

  const JOB_RE = /^\/api\/jobs\/([^/]+)$/;

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://internal.invalid');
    const path = url.pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return false;

    try {
      const method = req.method ?? 'GET';
      // Same-origin app: a browser request from another origin is refused outright.
      if ((method === 'POST' || method === 'DELETE') && deps.config.allowedOrigin) {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== deps.config.allowedOrigin) { sendJson(res, 403, FORBIDDEN); return true; }
      }

      const jobMatch = JOB_RE.exec(path);
      const routes: Array<[string, string | RegExp, () => Promise<void> | void]> = [
        ['GET', '/api/health', () => sendJson(res, 200, { status: 'ok', desktopStorage: deps.config.desktopStorage === true })],
        ['POST', '/api/solver/wave', () => submit(req, res, 'wave')],
        ['POST', '/api/solver/impulse-response', () => submit(req, res, 'impulse-response')],
        ['GET', '/api/storage', () => getArtifact(req, res, url)],
        ['POST', '/api/report/export', () => exportReport(req, res)],
        ['POST', '/api/log-error', () => clientError(req, res)],
        ['POST', '/api/internal/cleanup', () => cleanup(req, res)],
        ['GET', '/api/internal/metrics', () => metricsRoute(req, res)],
        ['POST', '/api/internal/job-run', () => runJobTask(req, res)],
      ];
      if (jobMatch) {
        let id: string;
        try { id = decodeURIComponent(jobMatch[1]); } catch { sendJson(res, 403, FORBIDDEN); return true; }
        if (method === 'GET') await getJob(req, res, id);
        else if (method === 'DELETE') await cancelJob(req, res, id);
        else sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, DELETE' });
        return true;
      }
      const sameRoute = routes.filter(([, p]) => p === path);
      if (sameRoute.length === 0) { sendJson(res, 404, { error: 'Not found.' }); return true; }
      const match = sameRoute.find(([m]) => m === method);
      if (!match) { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: sameRoute.map(([m]) => m).join(', ') }); return true; }
      await match[2]();
      return true;
    } catch (e) {
      if (e instanceof HttpError) {
        const headers: Record<string, string> = e.closeConnection ? { Connection: 'close' } : {};
        sendJson(res, e.status, { error: e.publicMessage, ...(e.extra ?? {}) }, headers);
        if (e.closeConnection) res.once('finish', () => { req.destroy(); });
        if (e.status === 413) metrics.inc('resource_limit_rejections');
        return true;
      }
      // Anything else is an internal fault: log it (redacted), tell the caller nothing.
      logError('request_failed', e, redactValue({ method: req.method, path }) as Record<string, unknown>);
      sendJson(res, 500, { error: 'Internal server error.' });
      return true;
    }
  };
}
