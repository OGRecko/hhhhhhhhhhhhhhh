# Research status, round 12

Date: 2026-10-12. Branch `arena/0d89ee76-hhhhhhhhhhhhhhh`. Base commit `9fb069a` (round 11).

This file is the human summary. Machine-readable ledgers:

- `scripts/research/PROVENANCE-QUEUE.md` and `provenance-queue.json`: generated from `speakers.json` and `queue-url-status.json`.
- `scripts/research/queue-url-status.json` (schema `queue-url-status/v2`): one entry per source URL, with status, chunks opened, per-field outcomes and history.
- `scripts/research/provenance-source-ledger.json`: per-source entries, round records and open owner questions.
- `scripts/research/round12-value-history.json`: before and after provenance for every round-12 change.
- `scripts/research/directivity-leads.json`: leads, with the round-12 outcome for Genelec 8331A.

This round is **not complete**. The field-level audit is far from finished. Nothing below is claimed as complete.

## Counts (from data, after round 12b)

| Measure | Value |
|---|---:|
| Live records | 659 |
| Archived records | 118 |
| Total records | 777 |
| Unchecked populated fields (`CITED_IN_NOTES_UNCHECKED`) | 770 (driverCount 430, active 340) |
| Source URLs with outstanding fields | 439 |
| URLs with status `OPEN` (never opened in the status file) | 432 |
| URLs opened, fields still outstanding | 7 |
| URLs opened, no fields outstanding | 9 |
| Field-level provenance `MANUFACTURER_VERIFIED`, driverCount | 62 |
| Field-level provenance `MANUFACTURER_VERIFIED`, active | 45 |
| Directivity leads | 51 (none imported) |

Round-11 starting point was 791 unchecked items across 446 URLs (in the round-11 queue file, which is the comparison point).

## What round 12 did

Source URLs opened this round (fetch tool, chunks noted in the status file):

- DALI OBERON manual (6 chunks, all opened).
- KEF R Series 2018 information sheet (2 chunks).
- EV ZLX user manual, distributor copy, leone.sk (chunks 0 and 4).
- Sonus faber Homage Tradition manual, ManualsLib copy, page 30 (chunks 0 and 1).
- Sonus faber Olympica Nova manual, ManualsLib copy, pages 42 and 43 (chunks 0 and 1 each).
- Mackie CR-X quick start guide (chunks 0, 1, 3, 5).
- JBL 4310 manual, Library of Congress copy (chunk 0).
- JBL SRX815, PRX815, Control 30, VTX A12 spec sheets (adn.harmanpro.com).
- Amphion One18 product page (2 chunks).
- KEF R5 Meta product page, APAC region (chunks 0, 2, 3).
- Zenodo record 10255555 (Genelec 8331A directivity dataset), record page only.

Promotions (`PROMOTED`, MANUFACTURER_VERIFIED): **23 fields**.

- KEF R11 / R3 / R5 / R7 driverCount (4).
- DALI OBERON 3 / 5 / 7 active False (3).
- Mackie CR3-X / CR4-X / CR5-X active True (3).
- JBL SRX815 driverCount 2 and active False (2).
- JBL PRX815W driverCount 2 and active True (2). The sheet is headed PRX815. The W identity rests on the Wi-Fi control in the same sheet. Owner question recorded.
- JBL Control 30 driverCount 3 and active False (2).
- JBL VTX A12 driverCount 9 and active False (2).
- Amphion One18 driverCount 2 and active False (2).
- KEF R5 Meta driverCount 4 and active False (2). Active is supported by the "Passive HiFi Speaker" badge.
- legacy-jbl-3 driverCount 3 (1). Same document as jbl-4310, whose driverCount was already verified.

Supported but **not promoted** (`SUPPORTED_NOT_PROMOTED`, 12 fields). The value is supported by a distributor- or aggregator-hosted copy, and the project's rules allow only MANUFACTURER_VERIFIED for these fields. Affected: EV ZLX-12P and ZLX-15P (driverCount and active, leone.sk), Sonus faber Serafino and Guarneri (driverCount and active, ManualsLib), and Olympica Nova I, II, III and V (driverCount, ManualsLib). Owner question recorded.

Not stated (`NOT_STATED`, 8 fields): the source was opened and does not state the field. Olympica Nova active (4), JBL 4310 active (2), JBL 4430 active (2).

Not extracted (`NOT_EXTRACTED`, 3 fields): DALI OBERON driverCount. The configuration table (Table 2) is absent from the extracted text. Retry needed.

Rejected (`CHECKED_REJECTED`): **0**. Conflicts: **0**. No value was withdrawn or cleared this round.

Demotions (round 12b): `lacoustics-arcs-ii` driverCount and active were MANUFACTURER_VERIFIED on a THIRD_PARTY sourceType (SISME distributor copy). They returned to `CITED_IN_NOTES_UNCHECKED`.

Round 12b also reverted the 12 distributor/aggregator promotions. The test suite (`src/data/speakers.round3.test.ts`) allows only `CITED_IN_NOTES_UNCHECKED`, `UNSOURCED` and `MANUFACTURER_VERIFIED` for these fields. The test was not changed.

### Explicit-evidence rule used

For `active` False, the source must say the product is passive or unpowered, or describe connection to an external amplifier or a 70 V/100 V line. For `active` True, it must say powered or self-powered, or list a built-in amplifier. A "recommended amplifier power" line alone does not count. Applied consistently: KEF R-series (not stated), Olympica (not stated).

### Genelec 8331A directivity lead (`genelec-8331a`)

- Zenodo record page: fetched. Lists `LS_directivity_Calibrated_GENELEC_8331A.sofa` with MD5 `a00e40164556183420c315e9f6ecd7fd` (410.5 MB).
- File download: **failed**. curl to the Zenodo file URL returned an SSL error (HTTP 000). No bytes were obtained, so the checksum was not verified against a local file.
- Format: `server/directivityParser.ts` accepts JSON only. `.sofa` is rejected as unsupported.
- Outcome: **not imported**. No substitute file and no synthesized polar data. Status recorded as INACCESSIBLE_AND_UNSUPPORTED_FORMAT in `directivity-leads.json`.

## Counts for the round-12 report

- Inspected (source URLs opened this round): 15 (14 queue URLs plus the Zenodo record page).
- Confirmed (fields promoted to MANUFACTURER_VERIFIED this round): 23. Round 11 added 6 earlier.
- Supported but not promoted: 12. Not stated: 8. Not extracted: 3.
- Rejected: 0. Withdrawn: 0. Conflicts: 0.
- Still unchecked: 770 fields across 439 URLs.
- Sources unavailable: 1 (Zenodo file download, Genelec 8331A SOFA).
- Response datasets checked: **0 of 25**. Not started this round.
- Directivity leads resolved: **1 of 51** (Genelec 8331A, blocked and not imported). The other 50 are not started.

## Not done this round (open, in priority order)

1. Genelec 8331A SOFA: download still blocked. Retry from a route that can reach Zenodo. Even with a download, the parser has no SOFA support, so import needs a new parser.
2. The 25 live response datasets: each still needs exact-model and revision verification, and comparison against published points. Not started.
3. The remaining 432 OPEN URLs. These include Bose, Electro-Voice, Bowers & Wilkins, Polk, Monitor Audio and other manufacturer URLs. The full list is in `PROVENANCE-QUEUE.md`.
4. The 227 withdrawn `driverCount`/`active` values. Not processed. The figure is not documented in the repo; owner question carried from round 4.
5. The 70 restored values. The 45 still MANUFACTURER_VERIFIED from earlier passes have not been re-audited. The 25 null entries are unchanged.
6. Held records (legacy-mack-4 / Mackie CR3, equator-d5, remaining held values). Not rechecked this round.
7. Catalog 774-to-777 investigation. Not started. The catalog remains 659 / 118 / 777.
8. Owner questions still open: ELX200-15 (keep 85 excluded, EN as alternate), Turbosound iP15B archive decision, Yamaha NS-6490 US-versus-Malaysia variant, and the three questions added in round 12.

Unchanged this round: ELX200-15 handling, LSR32 20 kHz (both disputed points kept out of simulation), QSC WL3082 and WL212-sw `active` (null), Focal Sopra N°2 91 dB (THIRD_PARTY_VERIFIED), NS-6490 impedance (unavailable), saved-project `speakerId` validation, and the solver worker fix with its regression tests.

## Verification (round 12, final state)

- `npm run docs:release` (includes `make-provenance-queue.py`): exit 0.
- `npm run docs:consistency`: exit 0.
- `npm run audit:speaker`: exit 0.
- `npm run audit:provenance`: exit 0.
- `npm run audit:final`: exit 0.
- `npm run release:source` then `release:source:verify`: exit 0. Source manifest refreshed (see `source-release/manifest.json` for the current treeSha256).
- `npm run audit:release`: exit 0 (after the manifest refresh).
- `npm run typecheck`: exit 0.
- `npm run audit:third-party`: exit 0.
- `npm test`: **59/59 suites pass**.
- `scripts/research/make-provenance-queue.py`: 0 consistency warnings.

Earlier audit failures that were fixed in this round:

- `audit:release` initially failed on a stale source-release manifest hash. Fixed by refreshing it with `release:source`.
- `src/data/speakers.round3.test.ts` initially failed on the distributor-copy status. Fixed by round 12b (see above). The test was not changed.

## Scripts added or changed

- `apply-round12-queue-batch.py`: round-12 promotions, the ARCS II demotion, the Genelec outcome, and the v2 status file. Marker `round12-queue-batch`. Also supports `--rebuild-status`.
- `apply-round12b-provenance-correction.py`: reverts the 12 distributor-copy promotions and the 2 ARCS II demotions to unchecked. Marker `round12b-provenance-correction`.
- `make-provenance-queue.py`: reads `queue-url-status.json`; reports status per URL, outstanding fields, recorded outcomes, separate URL and field counts, and cross-checks each recorded outcome against the live provenance.
- `round12-value-history.json`, `queue-url-status.round11.json`: history of the round-12 changes and the round-11 status file, kept as the baseline.
