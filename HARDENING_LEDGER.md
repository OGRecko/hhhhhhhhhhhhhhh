# Cavity Audio v6 — Hardening Ledger (honest status)

States plainly what is PASS / FAIL / BLOCKED — no claims of "fully
verified" beyond what was actually executed with `npx tsx <file>` in this
environment (no network, no `node_modules`; only files with no external
npm dependency could run).

## IMPORTANT: the original 30-item spec text is not available to me

The prompt that started this pass referenced "the original 30-item spec"
and a Phase 3 manual QA checklist as already-known context from an
earlier session, tracked via a memory file (`/areas/cavity.md`) that
does not exist in my memory store, and was not included in this zip or
this conversation. **I do not have the text of spec items #6, #7,
#11–#18, #21–#30, or the Phase 3 checklist.** Everything below is
independent verification/hardening work found by actually running every
test file in the repo, reading and testing previously-untested source
files, and checking two specific claims from the original prompt against
this codebase's actual state - it is NOT guaranteed to correspond to the
specific numbered items. If you have the original spec text, share it
and I'll map this work against it directly.

## Two regressions found against previously-claimed-done work

The prompt that started this pass stated items #8 and #9 were already
fixed and verified in an earlier session. Checking this codebase's
actual current state against those specific claims turned up real gaps:

### Item #8 (MAX_CONCURRENT_SOLVER_JOBS 2→1) — was NOT present, now fixed

`src/lib/publicLimits.ts` still had `MAX_CONCURRENT_SOLVER_JOBS: 2`.
Independently confirmed the real deployed instance size from this repo's
own deploy script (`scripts/deploy-cloud-run.mjs`: `--memory=2Gi`)
rather than taking the "2GiB instance" claim on faith. Two jobs at the
1.5GB per-job default could together demand 3GB against a real 2GiB
instance. Changed to `1`; documented the reasoning in the constant's
comment. Added `server/dispatcher.test.ts` (previously nonexistent) with
a test that runs real concurrent load through `Dispatcher` and verifies
`maxConcurrent` is actually enforced at runtime.

### Item #9 (HARD_MAX_SOLVER_MEMORY_BYTES clamp) — was NOT present, now fixed

`resolveMaxSolverMemoryBytes` validated finite/positive but had no upper
bound. Added `HARD_MAX_SOLVER_MEMORY_BYTES` and a clamp, set to 8GB
rather than 1.5GB specifically to avoid breaking a pre-existing test that
asserts a legitimate 2GB config must be honored verbatim - flagged as a
judgment call in the ledger rather than silently resolved either way (see
detail in git history / earlier turns of this conversation if you need
it - kept brief here since this file is getting long).

## Untested source files reviewed and now covered

### `server/dispatcher.ts` — no bugs found; 5 tests added (`server/dispatcher.test.ts`)

Concurrency actually enforced under real load, enqueue dedup, stop()
rejection, cancelLocal, stats(). All pass.

### `server/admission.ts` — no bugs found; 15 tests added (`server/admission.test.ts`)

Rate limiting (fixed-window allow/deny/reset, per-IP+per-route
independence), slot acquisition (global cap, per-IP cap, expiry without
explicit release, explicit release, extend), and purge pagination all
verified by actually exercising the code against `FakeFirestore`, not
just read-through. The one test worth flagging: **a genuine race between
two concurrent `acquireSlot()` calls** for the last available global
slot, using `FakeFirestore`'s forced-interleaving hook to make both
transactions read before either commits. Confirmed exactly one call
succeeds and `FakeFirestore.stats.transactionAborts >= 1` (i.e. a real
optimistic-concurrency retry happened) - proving the atomicity claim in
the module's own doc comment, not just trusting it. All 15 pass (1
sub-case skips itself with a clear reason when `MAX_ACTIVE_JOBS_PER_IP >=
MAX_CONCURRENT_SOLVER_JOBS`, which is currently true after the item #8
fix above, so the per-IP branch is momentarily indistinguishable from the
global one - noted in the test's own comment).

### `src/lib/roomAcoustics.ts` (`computeEstimatedGAndSPL`) — investigated in depth, found correct; 3 tests added

Had visible in-progress working-out comments in its own source ("Wait,
ISO 3382-1...") that looked like a strong bug signal, and zero test
coverage despite live use in `LeftSidebar.tsx`. Verified the formula
(`Lp = Lw + 10*log10(Q/(4*pi*r^2) + 4/R)`, `R = S*alpha/(1-alpha)`)
against multiple independent published sources and reproduced a worked
numeric example within rounding. **Conclusion: correct** - the comments
reflect the author rejecting a wrong path (literal ISO 3382-1, a
*measured* quantity) before landing on the right analytical one. Added
`src/lib/roomAcoustics.gspl.test.ts` (3 tests, all pass).

### `src/lib/sti.ts` (real MTF/Schroeder-method STI) — no bugs found; 7 tests added (`src/lib/sti.test.ts`)

Extremely well-documented file that discloses its own simplifications
(no IEC masking correction, equal band weighting, 125Hz excluded) rather
than overclaiming. Contained one numerically load-bearing claim in a
comment - a factor of 2 needed in `modulationIndex()` to recover true
modulation depth, "verified against a synthetic 100%-modulated test
signal" - but that verification wasn't captured anywhere runnable before
this pass. Independently reproduced it: confirmed 100%/50%/0%-depth
synthetic modulated signals return modulation index ≈1.0/≈0.5/≈0
respectively, and confirmed the Nyquist-guard band exclusion and the
present-band-count averaging (already fixed in-line per the file's own
comment) are both correct end-to-end. All 7 tests pass.

### `src/lib/audioEngine.ts` — mostly BLOCKED; pure geometry verified via shadow copy; 10 tests added (`src/lib/audioEngine.geometry.test.ts`)

1232 lines, the largest untested file. **The module cannot be imported in
this environment**: it pulls in `useStore` -> `zustand` (not installed, no
network), and the class itself is built around `AudioContext`,
`PannerNode`, etc. So `play()`, the mic/stream handling, the convolver and
FDTD-IR wiring, and everything else that touches Web Audio are **BLOCKED
and not verified at all** - reading them is not testing them.

Two methods are pure geometry with no real dependency on the browser or
the store: `lineIntersect` (segment intersection) and
`checkWallIntersections` (wall transmission-loss occlusion, including the
L/W <= 0 / NaN guard and the doorway/full-opening bypass). Those are
verified by testing a copy in `audioEngine.geometry.test.ts`. The
important part is that the copy cannot silently go stale: a **behavioral
drift check** extracts the real method source from `audioEngine.ts` at
test time, evaluates it, and compares it to the copy across ~10k input
combinations (two polygons, several room-dimension edge cases including
0/negative/NaN, four opening configurations, three material setups
including an unknown material id).

I first tried a textual comparison of the function bodies and it failed
on purely cosmetic compiler differences (dropped parens, `0.5` -> `.5`,
quote style, trailing semicolons), so I replaced it rather than keep
stacking normalization rules. I then **mutation-tested the guard**:
- changing `ua >= 0` to `ua > 0` in the real source -> caught;
- changing the `|| 30` fallback to `|| 31` -> **missed at first**, because
  my grid only used a known material and never reached the fallback.
  Added an unknown-material case to the grid plus two direct tests
  (unknown-material fallback = 30 dB/wall; per-segment override
  precedence) and re-ran the mutation: now caught.
`audioEngine.ts` was confirmed byte-identical to the original after each
mutation. No bug found in these two methods.

One number worth knowing: my first standalone copy used made-up
transmission-loss values (drywall 33, concrete 50). The real table says
35 and 55. The test now imports the real `MATERIALS` and asserts against
production values instead.

**Absorption-table divergence check (`materials.ts` vs `absorption.ts`).**
`audioEngine.ts`'s header comment says the two tables once disagreed
(e.g. acoustic_panel 0.70 vs 0.75). I probed for a remaining
divergence, and my first probe reported "0 diverge" - which was
**vacuous**: `materials.ts` entries now only have `id`, `name`, `tl` (no
absorption field), so the comparison never ran. What is actually
established: all 37 material ids in `materials.ts` exist in the shared
absorption table, and a grep shows only 3 files import `materials.ts`
(`ThreeView.tsx` for colours, `RightSidebar.tsx`, `audioEngine.ts`) with
none reading an absorption value from it. So there is no second
absorption table left to drift; the original divergence was resolved by
removing the duplicate values.

### `server/jobExecutor.ts` — no production bug found; 20 tests added (`server/jobExecutor.test.ts`)

The function that runs one durable job under a lease (claim -> heartbeat ->
solve -> persist -> fenced complete). Until now the only thing that ran it
was the dispatcher test, whose stub solver always succeeds, so **the
failure, timeout, cancel, lease-loss, artifact-budget and cleanup branches
had never executed.** The new tests drive each outcome and check both the
persisted job state and what is left in artifact storage (the dangerous
part is cleanup deleting another worker's completed result).

Covered: success; empty/absent receiver traces; refused claim backs off
without running the solver; plain `Error` -> `solver_failed` with the raw
message not persisted; `SolverError` keeps its public code; hung solver
aborted at timeout; solver that ignores the abort signal and finishes late
is still `timeout`, not success; client cancel mid-run deletes artifacts;
storage outage -> `storage_failed`; wavefield frame cap (both the rejected
index and the last legal index); total artifact byte budget; result
document size cap; `onFinished` exactly once per claimed job and never on a
back-off; `registerAbort`/`unregisterAbort` paired and the registered
controller really aborts the solver; completed job's artifacts survive;
failed job's frames are removed, including via the per-id fallback when
bulk delete fails.

**Test-environment note, not a production bug:** the executor `unref()`s its
heartbeat and timeout timers on purpose so a lingering job can't keep a
shutting-down server alive. In a bare test process nothing else holds the
event loop open, so a test waiting on the timeout exited with "unsettled
top-level await". I initially suspected the executor and isolated it
(a standalone script returned `timeout` in 64 ms). Fixed by holding the loop
open in the test file; production code untouched.

**Mutation testing, honestly reported.** I ran 8 mutants against the
executor. 5 were caught immediately. 3 survived, and the survivors were
informative:
- *Cleanup deletes a completed job's artifacts* (the most dangerous rule):
  survived, because my "not deleted by a later attempt" test backs off at
  the claim and never reaches cleanup. Added a test that reaches the guard;
  now caught.
- *Failure path skips cleanup*: survived, because the storage was never
  populated in those tests. Added tests where frames are written before the
  failure, including a bulk-delete-fails case that forces the per-id
  fallback; now caught (and the fallback removal is caught too).
- *Raw error text persisted*: one of my two attempts at this mutant was a
  no-op (old string == new string) and the other only stashed the message in
  a global without persisting it, so neither proved anything. A mutant that
  actually writes the message to the failure record is caught by the
  existing "no raw message leaked" test.
`jobExecutor.ts` was confirmed byte-identical to the original after every
mutation run.

**Housekeeping slip, caught before shipping:** two scratch files
(`server/_scratch2.test.ts`, `server/_scratch_timeout.test.ts`) were left in
`server/` because my cleanup `rm` sat after a shell line that errored and
never ran. They would have been packaged and picked up as tests. Removed
and verified gone.

## Every runnable test file in the repo: ALL PASSING (19 files, up from 13 at the start of this multi-round pass)

Ran `npx tsx <file>` directly (90s timeout).

| File | Result |
|---|---|
| `server/solverWorker.test.ts` | 32/32 PASS |
| `server/reportAuthorization.test.ts` | 6/6 PASS (2 real test bugs found & fixed) |
| `server/dispatcher.test.ts` | 5/5 PASS (new) |
| `server/admission.test.ts` | 15/15 PASS (new) |
| `server/jobExecutor.test.ts` | 20/20 PASS (new; mutation-tested) |
| `server/storage.test.ts` | 6/6 PASS (2 real test bugs found & fixed) |
| `server/jobStore.concurrency.test.ts` | 23/23 PASS |
| `server/config.test.ts` | PASS |
| `server/jobStateMachine.test.ts` | 166/166 PASS, 141 illegal transitions enumerated |
| `server/capabilityToken.test.ts` | PASS |
| `server/publicLimits.test.ts` | 10/10 PASS |
| `src/data/speakers.test.ts` | 9/9 PASS |
| `src/lib/decay.test.ts` | 11/11 PASS |
| `src/lib/projectValidation.test.ts` | PASS |
| `src/lib/impulseResponseParams.test.ts` | 30/30 PASS |
| `src/lib/acousticComparison.test.ts` | PASS |
| `src/lib/roomAcoustics.gspl.test.ts` | 3/3 PASS (new) |
| `src/lib/sti.test.ts` | 7/7 PASS (new) |
| `src/lib/audioEngine.geometry.test.ts` | 10/10 PASS (new; shadow copy + behavioral drift check, mutation-tested) |
| `src/lib/roomAcoustics.validation.ts` (script) | 3/3 PASS, unaffected |

### BLOCKED — real npm dependencies, no network to install

| File | Blocked by |
|---|---|
| `server/reportGenerator.test.ts` | missing `pdf-parse` |
| `server/cloudTaskDispatcher.test.ts` | missing `google-auth-library` |
| `server/api.integration.test.ts` | missing `pdfkit` (transitively) |

## Untested source files NOT yet reviewed

Still not gotten to (`audioEngine.ts` is now partially covered - see above; its Web Audio parts remain BLOCKED): `server/api.ts`, `server/directivityParser.ts`,
`server/reportInput.ts`, `server/reportRenderer.ts`,
`server/workerRunner.ts`, `src/lib/absorption.ts`,
`src/lib/interpolation.ts`, `src/lib/materials.ts`, `src/lib/octaveFilter.ts`
(only indirectly exercised via sti.ts's tests, not directly), `src/lib/spatialAnalysis.ts`,
`src/lib/speakerDSP.ts`, `src/lib/speakers.ts`, `src/lib/splCalibration.ts`,
`src/physics/gpu-solver.ts`. All confirmed to have no blocking external
npm dependency, so all are reviewable/testable here - just not reached yet.

## Bugs found and fixed in prior rounds of this pass (summary)

- **`runWave` exponential instability at coarse grids** (sentinel-value
  bug misrouting interior faces into the wall-reflection branch) - fixed.
- **Override/opening cluster**: `runWave`'s broadband path ignored
  per-wall material overrides - fixed.
- **Test D / Test E**: grid-resolution-vs-target-mode mismatches;
  Test E also exceeded the 3000-step cap - retuned both.
- **Test C6/C7**: `diffuseFieldValid` compared the wrong frequency
  against Schroeder frequency - fixed.
- **Test C3**: invalid fixed-dB-window comparison for a near-lossless
  baseline - fixed (test-only).
- **`reportAuthorization.test.ts` / `storage.test.ts`**: malformed
  placeholder tokens meant these tests never exercised real token
  comparison; `storage.test.ts` also had a stale `suffix` vs `index`
  field-shape mismatch - both fixed (test-only).
- Two `assert.equal is not a function` bugs fixed.

Full detail on each is in earlier turns of this conversation; this file
is the single current source of truth for the codebase's status.

## Environment constraints (unchanged)

No network access: `npm ci`, `npm run build`, `npm audit`, and the three
BLOCKED test files above cannot run. Everything else with no external npm
dependency has now actually been executed with `tsx` and passes.
