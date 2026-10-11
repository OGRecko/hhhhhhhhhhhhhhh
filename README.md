# Cavity Audio

Cavity Audio is an acoustic simulation web application that estimates room modes, impulse responses, and basic acoustic properties (like RT60, C50, and D50) for various speaker and receiver configurations using a simplified numerical solver.

## Physics Model and Capabilities

**Important Engineering Disclaimer:**
This tool is intended for room-level design guidance, not for compliance documentation or lab-grade acoustic analysis. The numerical physics engine implements specific simplifications:

*   **FDTD Solver**: The engine uses a 3D Finite Difference Time Domain (FDTD) solver for low-frequency modal analysis and impulse response generation.
*   **Boundary Conditions**: The optional frequency-dependent wave solver uses a sparse **seven-band causal relaxation boundary** across 125/250/500/1000/2000/4000/8000 Hz where sourced material coefficients exist. The impulse-response solver evaluates the same seven bands independently. Missing material-band data remains unavailable rather than being copied from another frequency. This is a numerical design model, not a lab/compliance impedance fit.
*   **Directivity**: The room solver is omnidirectional by default. It applies frequency-dependent directivity only when a validated directivity dataset is explicitly supplied with the source; covered octave bands (125 Hz–8 kHz) use source yaw/pitch/roll, while uncovered bands remain omnidirectional. The 671-speaker live database contains no embedded polar/CLF/GLL data, so speaker selection alone does **not** provide speaker-specific room directivity.
*   **Absorption Values**: The absorption coefficients provided for various materials are standard reference estimates, not lab-certified measurements of specific products.

## Architecture
*   **Frontend**: React (Vite), TypeScript, Tailwind CSS, Three.js (for 3D room visualization).
*   **Backend**: Express.js server bundled via ESBuild.
*   **Database**: Firebase Firestore (server-authoritative via Firebase Admin SDK when cloud credentials are configured).
*   **Simulations**: Asynchronous FDTD numerical solver running in isolated Node.js `worker_threads` with strict memory and CPU time guardrails.
*   **Public Access**: The main application is publicly accessible and does not require user registration, authentication, payment, or subscription.
*   **Security**: Anonymous solver jobs generate an unpredictable capability token used for result authorization (polling, reporting, and artifact downloads). Infrastructure security (rate limiting, solver memory budgets, and abuse prevention) remains active.

## Installation & Development
### 1. Requirements
*   Node.js v22.23.3 or newer within Node 22
*   npm

### 2. Environment Setup
Copy `.env.example` to `.env` and fill in the required variables:
*   `FIREBASE_SERVICE_ACCOUNT` - JSON string for the Firebase Admin SDK.

### 3. Run Locally
```bash
npm ci
npm run dev
```

## Public/free runtime model

Cavity runs without accounts, login, subscriptions, checkout, or payment. Solver jobs are anonymous and protected by unpredictable capability tokens retained only for the simulation lifetime rather than user sessions.

- Simulation/job records are retained for 24 hours and then removed with their generated trace/wavefield files.
- Queued jobs older than ten minutes without a claim are marked failed; running jobs have a 15-minute absolute job-age ceiling and lease recovery so a server restart cannot leave them permanently pending.
- Solver cooldowns, report-export limits, and the global solver concurrency lease are stored in Firestore and therefore apply across multiple server instances.
- Stored trace/wavefield objects require the capability token belonging to their simulation.
- `npm start` rebuilds the frontend and backend from the current source before launching the generated production bundle, so stale generated code cannot silently be served.

## Public production storage and cleanup

Anonymous simulations use Firebase/Google Cloud Storage for traces and wavefield frames; the web server's local filesystem is never used for persistent artifacts. Set `FIREBASE_STORAGE_BUCKET` to the production Cloud Storage bucket used by Firebase Admin.

Public simulation artifacts expire after 24 hours. The application runs cleanup hourly and exposes `POST /api/internal/cleanup` for a trusted scheduler. For production, configure Cloud Scheduler or an equivalent cron service to call that endpoint with the `x-cleanup-secret` header set to `CLEANUP_SECRET`. Never expose that secret to the browser.

Set `TRUST_PROXY` explicitly in production to the exact number of trusted reverse proxies. The server refuses to start in production when it is omitted, preventing spoofed forwarded client IPs from weakening public rate limits.

Public solver jobs are durably recorded in Firestore and can be recovered after a process restart when their persisted payload is available. Jobs that predate durable payload persistence and therefore cannot be reconstructed are marked failed instead of being silently lost.

`npm start` runs `npm run build` first and then launches the freshly generated `dist/server.cjs`. `dist/` is intentionally excluded from source archives; deployment builds it from the exact checked-out source.

## Firebase security requirements

The browser is deliberately denied direct Firestore and Cloud Storage access. Deploy both `firestore.rules` and `storage.rules` so all anonymous simulation access goes through the Express API. The API stores only a SHA-256 hash of each capability token; the raw token exists only in the browser's active session and in server memory while a newly submitted job is running.

Capability tokens are sent in `Authorization: Bearer <token>` headers for job polling, cancellation, and artifact downloads. They are not placed in URLs, which prevents normal proxy/access logs and browser history from recording the credential. Report export sends the capability token in the `Authorization` header and only the simulation ID (plus an optional bounded SNR value) in the JSON body.

The distributed solver concurrency limit is protected by a Firestore transaction and expiring leases. A recovered job uses its persisted non-secret payload and token hash; no capability secret is reconstructed or written to Firestore.

Production startup fails fast unless Firebase credentials are available through Application Default Credentials or explicit Firebase service-account credentials, plus `CLEANUP_SECRET`, `TRUST_PROXY`, and a Firebase Storage bucket are configured. `CLEANUP_SECRET` is accepted only in the `x-cleanup-secret` header and failed attempts are rate-limited.

For cleanup, call `POST /api/internal/cleanup` from Cloud Scheduler or another trusted scheduler. The application also performs hourly cleanup while running. Configure Firestore TTL for the `expireAt` field in `publicRateLimits` as an additional backstop; the application cleanup loop remains the primary portable mechanism.

For real deployment verification, use the Firebase Emulator Suite and a dedicated test Firebase project. The GitHub Actions `production-verify.yml` workflow exercises anonymous create → poll → artifact → report → wrong-token rejection → cleanup/expiration checks against the deployed service.


## Public/free production hardening

- Anonymous solver runs use a cryptographically random capability token. Only its SHA-256 hash is persisted server-side.
- Protected APIs use `Authorization: Bearer <capability-token>`; capability tokens are not accepted in JSON bodies.
- Firestore is the durable job record and uses transactional recovery/execution claims to prevent duplicate work across server instances.
- Recovery and cleanup paginate until exhausted rather than stopping at an arbitrary global pass limit.
- Browser clients have no direct Firestore or Storage access; Firebase rules deny unauthenticated reads and writes.
- A 1-day Google Cloud Storage lifecycle rule is a second-line cleanup safety net for the app's 24-hour retention policy, scoped to `public-simulations/`. The production verification workflow applies it and then verifies it; operators can also run `npm run storage:lifecycle` after authenticating `gcloud`.
- The internal cleanup endpoint should be invoked by a trusted scheduler at least daily with `x-cleanup-secret`. The process-local hourly timer is only a fallback.
- CI runs on Node 22.23.3, then typecheck, the complete discovered test suite, production build, dependency audit, and Firebase Emulator security smoke tests.

### Firebase emulator security tests

Run `npm run firebase:rules:test`. This starts Firestore and Storage emulators and verifies unauthenticated reads/writes are rejected by the deployed rules.

### Scheduled cleanup

Configure your deployment scheduler (Cloud Scheduler, cron, or an equivalent trusted scheduler) to POST `/api/internal/cleanup` daily with the `x-cleanup-secret` header. Do not expose the cleanup secret to browser code.


### GitHub scheduled cleanup

The repository includes `.github/workflows/cleanup.yml`, which runs daily and can also be triggered manually. Configure repository secrets `APP_URL` and `CLEANUP_SECRET`. A separate manually-triggered `production-verify.yml` runs the full deployed smoke flow and lifecycle check when `APP_URL`, `CLEANUP_SECRET`, `FIREBASE_STORAGE_BUCKET`, and `GCP_SERVICE_ACCOUNT_KEY` are configured.

### Verification commands

```bash
npm ci
npm run typecheck
npm test
npm run firebase:rules:test
npm run build
npm audit --audit-level=high
```

For a deployed environment:

```bash
APP_URL=https://your-host.example SMOKE_RUN_SOLVER=true SMOKE_RUN_CLEANUP=true CLEANUP_SECRET=... npm run production:smoke
APP_URL=https://your-host.example npm run production:smoke
APP_URL=https://your-host.example npm run abuse:smoke
FIREBASE_STORAGE_BUCKET=your-bucket npm run storage:lifecycle:check
```

The production smoke script never treats unavailable cloud infrastructure as a successful test. It exits non-zero on any failed assertion.

### Distributed solver dispatch

Production uses Google Cloud Tasks as a durable liveness trigger in addition to the Firestore-fenced local dispatcher. The task endpoint is protected by a separate random `CLOUD_TASKS_DISPATCH_SECRET`; task delivery is idempotent because Firestore job claiming remains authoritative. A duplicate Cloud Task can therefore safely hit any application instance.

Required production variables:
- `CLOUD_TASKS_LOCATION` (for example `us-central1`)
- `CLOUD_TASKS_QUEUE` (for example `cavity-solver`)
- `CLOUD_TASKS_DISPATCH_SECRET` (at least 32 random characters)
- `CLOUD_TASKS_ENABLED` is for development/test only; production always enables Cloud Tasks.

Create the queue after authenticating `gcloud`:
```bash
CLOUD_TASKS_PROJECT_ID=your-project CLOUD_TASKS_LOCATION=us-central1 CLOUD_TASKS_QUEUE=cavity-solver npm run cloudtasks:ensure
```
The runtime service account must have permission to create tasks on that queue.

## One-click GCP production deployment

The repository includes `.github/workflows/deploy-production.yml`. It is the authoritative production path and performs, in order:

1. Node 22.23.3 dependency installation and full type/test/build checks.
2. Firebase Firestore and Storage rule deployment.
3. Required GCP API enablement, Artifact Registry creation, Cloud Tasks queue creation, and runtime IAM setup.
4. Cloud Run image build and deployment using Node 22.23.3.
5. Firebase Admin authentication through Google Application Default Credentials (ADC), so a Firebase private key does not need to be stored inside the container.
6. Live anonymous solver, job authorization, artifact authorization, report export, cleanup, and abuse smoke tests.
7. Application of and verification of the one-day `public-simulations/` Cloud Storage lifecycle rule.

Required GitHub Actions secrets:

- `GCP_PROJECT_ID`
- `GCP_SERVICE_ACCOUNT_KEY` — deployment identity JSON
- `CLOUD_RUN_SERVICE`
- `CLOUD_RUN_REGION`
- `CLOUD_RUN_SERVICE_ACCOUNT` — runtime identity email
- `APP_URL` — the HTTPS public URL already mapped to the Cloud Run service
- `TRUST_PROXY` — exact proxy hop count
- `FIREBASE_STORAGE_BUCKET`
- `CLEANUP_SECRET`
- `CLOUD_TASKS_QUEUE`
- `CLOUD_TASKS_LOCATION`
- `CLOUD_TASKS_DISPATCH_SECRET`

The deployment identity must be allowed to enable services, deploy Cloud Run, submit Cloud Build builds, create Artifact Registry repositories, update IAM, deploy Firebase rules, and manage the Cloud Tasks queue. The workflow grants the runtime identity the minimum project-level roles required by the application: Firestore access, Storage object access, Cloud Tasks enqueue, and log writing.

For GCP-hosted production, set `FIREBASE_USE_APPLICATION_DEFAULT_CREDENTIALS=true` and do not provide a Firebase private key. The Cloud Run runtime service account is the credential used by Firebase Admin and Google APIs.

## Windows desktop app and installer

### Desktop mode
The installer ships an Electron shell (`electron/main.cjs`) that starts the bundled server on a free `127.0.0.1` port and opens it in a window. It is configured through a dedicated desktop path in `server/config.ts`, **not** by faking `NODE_ENV`:

| Variable | Set by | Meaning |
| --- | --- | --- |
| `CAVITY_DESKTOP=1` | shell | Selects desktop config: loopback only, no cloud credentials, Cloud Tasks off |
| `CAVITY_DATA_DIR` | shell (`<userData>/data`) | Where jobs and artifacts persist |
| `CAVITY_APP_ROOT` | shell | Install root (used for `dist/` and the solver worker; no `process.chdir`) |
| `PORT` | shell | The chosen loopback port |

Jobs persist in `<data>/store.bin` (atomic writes; a corrupt file is moved aside as `store.bin.corrupt-<ts>`), artifacts as files in `<data>/artifacts/`. A job that was running at shutdown is recovered by the normal lease-expiry sweep. Desktop mode is always local; it does not connect to the hosted backend. Logs: `%APPDATA%\Cavity Audio\cavity-desktop.log`.

Headless self-test (what CI runs): `"Cavity Audio.exe" --smoke-test --smoke-out=result.json`. It opens the window, checks `/api/health` and `/app`, runs a solver job, reads the artifact, and on a second launch confirms the previous job persisted.

### Building and releasing
`npm run release:windows` builds the app, packages the NSIS installer, validates it, and writes `releases/manifest.json`. `npm run release:verify` is the gate: it fails if the manifest is missing, the EXE has no `MZ` header, or its size / SHA-256 differ from the manifest.

CI: `.github/workflows/windows-release.yml` (manual dispatch or `v*` tag) runs on `windows-latest`: `npm ci`, `npm run release:windows`, the release gate, silent install, two real launches, silent uninstall, then uploads `releases/` as an artifact. The `publish` job (tag, or dispatch with `publish: true`) uploads the EXE and then the manifest to `gs://$RELEASES_BUCKET` and checks that the deployed server advertises it and serves matching bytes.

The Download EXE button reads `GET /release/windows` and downloads `GET /download/windows-exe` from `RELEASES_DIR` (default `./releases`). In production, set the `RELEASES_BUCKET` secret before `deploy-production.yml`; it mounts that bucket read-only at `/mnt/releases` and sets `RELEASES_DIR`. The Cloud Run service account needs `roles/storage.objectViewer` on the bucket, and the publishing service account needs object write access.

### Tests for the download button and release gate
- `scripts/releaseCheck.test.ts` (runs in `npm test`): the release gate against valid, missing-manifest, bad-MZ, size-mismatch, SHA-mismatch and path-traversal fixtures.
- `tests/e2e/download-exe.spec.ts` (`npm run test:e2e`, CI job `e2e-download-button` under `xvfb-run`): starts the built server three times (valid release, empty `RELEASES_DIR`, tampered manifest) and checks the button labels, that the downloaded file is a `.exe` whose SHA-256 equals `manifest.json`, the disabled "EXE not built" state, and the 404 from `/download/windows-exe`.
- The desktop shell flushes the local job store explicitly (`flushStore()` exported by `server.ts`) before every exit path, because `app.exit()` skips `before-quit` and the store otherwise saves on a short debounce.
- `index.html` must not contain inline scripts: the production/desktop CSP is `script-src 'self'`. The client error reporter lives in `public/error-reporter.js`, and `npm run audit:final` fails if an inline script reappears.

### Code signing
Add `WIN_CSC_LINK` (base64 of the `.pfx`, or an https URL) and `WIN_CSC_KEY_PASSWORD` as repository secrets; electron-builder then signs the installer and uninstaller, and the workflow fails if the resulting signature is not `Valid`. An OV certificate still builds SmartScreen reputation gradually; an EV certificate avoids the warning immediately.

**Unsigned production releases are not supported.** The Windows release workflow fails when the signing secrets are absent or the resulting Authenticode signature is not `Valid`. Do not publish an unsigned production installer.

### Auto-update
Not implemented by design. Cavity Audio does not include an automatic update mechanism in this release.

## Current release verification status — 2026-10-04

The current source passes the dependency-free static release gates: `npm run audit:final`, `npm run audit:release`, `npm run audit:speaker`, and `node scripts/speaker-provenance-audit.mjs`, with their counts derived from the current source/data. No EXE is included in the source archive. The six-speaker DSP regression covers Yamaha NS-10M, Neumann KH 120 II, Genelec 8351B, ATC SCM25A Pro, Magico M2, and QSC K12.2.

The remaining runtime/release gates are environment-dependent and are not represented as PASS by this source archive: supported Node 22.23.3+, clean `npm ci`, the complete test/build/audit/E2E release gate, a real Windows `windows-latest` signed installer, and credentialed Firebase/GCP deployment. Wine is not used as a substitute for the required Windows runner. See `FINAL_VERIFICATION.md` for exact status and external requirements.
