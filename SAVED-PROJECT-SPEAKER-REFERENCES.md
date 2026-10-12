# Saved projects that reference a speaker

This document describes what happens when a saved project names a speaker ID that is not in the live catalog.
It is hand-written. It matches `src/lib/projectValidation.ts` as of 2026-10-13.

## What is recorded
- Each source in a project can carry an optional `speakerId`.
- A project is accepted only if every non-empty `speakerId` is in the live catalog (`src/data/speakers.json`).
- Archived records (`scripts/research/removed-*.json`) are not live and are not in that set.

## What happens on open
- The whole project is rejected. There is no partial open, and the project data is not changed.
- The message names the ID, for example: `Project references speaker ID "legacy-jbl-5", which is not in the current catalog. It may have been archived or removed; the project was not opened.`
- A project with an invalid ID (a typo or a malformed value) gets the same message. The message does not say whether the ID was archived or never existed.

## How to tell archived from invalid
- Look the ID up in the archive files under `scripts/research/` (`removed-unavailable-records.json`, `removed-owner-round5-records.json`, `removed-owner-2026-10-12-decisions.json`, `removed-unavailable-2026-10-12.json`). Each archived record keeps its original ID, and `archiveMeta` gives the reason.
- If the ID appears in none of these files, it was never in the catalog and the saved file is probably corrupt.

## Recovery (manual)
1. Keep the original project file. Do not edit the speaker ID inside it to a different speaker.
2. Choose a replacement speaker that is live in the catalog, and set the affected source's speaker to that record. Recording the replacement as a new choice keeps the project's history clear.
3. Save the project again. The new file validates because the ID is live.

## What is not done
- No automatic remapping. A saved project is never silently assigned to a different speaker.
- No in-app replacement picker for missing IDs exists yet. Recovery is manual, as above.
- Archived records are not restored to make old projects open. The owner's archive decisions are preserved.
