# Cavity Audio — Release Audit Notes

**Date:** 2026-10-10

This file records the current release-engineering evidence and does not convert unavailable execution environments into PASS results.

## Dependency-free source/data gates

- `node scripts/final-audit.mjs` — **PASS**, 355 files scanned, 0 problems.
- `node scripts/release-audit.mjs` — **PASS**, source-only workspace; binary release verification is enforced when a Windows release artifact is present.
- `node scripts/speaker-quality-audit.mjs` — **PASS**, 774 records, 0 duplicate IDs, 0 duplicate brand/model pairs, 27 embedded response-point datasets (22 manufacturer, 5 measurement), no category-based response synthesis.
- `node scripts/speaker-provenance-audit.mjs` — **PASS**, all populated physical fields have auditable URLs, valid provenance status, and sensitivity reference metadata.

## Speaker DB

**PASS — static database audit.** Counts below are generated from the authoritative `src/data/speakers.json` dataset:

- 774 records
- 774 unique IDs
- 0 duplicate IDs
- 774 unique brand/model pairs
- 0 duplicate brand/model pairs
- `PARTIALLY_VERIFIED`: 648
- `UNVERIFIED`: 48
- `UNAVAILABLE`: 78
- source-backed fields: sensitivity 307, power 416, impedance 351, resonant frequency 17, voice-coil size 63, woofer size 583, frequency-response limits 559
- embedded JSON response-point datasets: 27
- declared response-point provenance: manufacturer 22, measurement 5, verified database 0
- physically modeled response models: 747
- generic reference models: 221
- models derived from published bandwidth limits: 526
- embedded speaker polar/directivity data: 0

The database does not claim that every catalog record is independently web-verified. Records without source-backed fields are explicitly `UNVERIFIED` and retain `N/A` physical fields rather than guessed values.

## Environment blockers

- The available runner is Node `22.22.3`; the package requires `>=22.23.3 <23`.
- `npm ci --ignore-scripts --prefer-offline` completed (745 packages installed) but reported 13 dependency advisories: 10 moderate, 2 high, and 1 critical. No dependency upgrades were applied.
- Full `npm test`: **49/56 suites passed**; all 49 suites that started passed, while six runtime suites could not start because local dependencies were absent (`pdfkit`, `pdf-parse`, `google-auth-library`, and dependencies imported by the API suites). Typecheck could not start because `npx tsc` resolved the unrelated `tsc@2.0.4` package instead of the TypeScript compiler, so this did not establish a typecheck result. The current targeted speaker-data integrity suite passes 52/52 checks, including the Sx100+ URL-alias, first-generation Sonus faber Sonetto, and REL S/812 regressions.
- A prior `npm run build` passed; Vite emitted its existing large-chunk advisory (>500 kB). Firebase emulator execution, Playwright/Electron packaging/signing, and live cloud verification remain unverified.

## Scientific honesty

- Frequency-response bandwidth is never treated as a measured response curve.
- Scatter is not physically modeled.
- Speaker-specific polar/directivity behavior is not fabricated.
- Missing physical specifications remain `N/A` rather than estimated.
- Secondary-source specifications are explicitly labeled as such.

