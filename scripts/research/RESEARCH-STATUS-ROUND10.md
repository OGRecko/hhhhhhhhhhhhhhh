# Research status after round 10 (2026-10-12)

Counts come from the current `src/data/speakers.json` and the regenerated queue. Nothing here is a manual total.

## Counts (live database)
- Live records: 659 (speakers.json). Archived records are not recounted here; the archive files are unchanged.
- Populated structural fields still `CITED_IN_NOTES_UNCHECKED`: 797 (driverCount 444, active 353).
- Fields `UNSOURCED`: 252 (driverCount 120, active 132). Fields `MISSING`: 189.
- Unchecked queue items: 797 across 447 source URLs (`scripts/research/provenance-queue.json`).
- Records with simulated published points: 23. Records with a non-simulated third-party table: 1 (turbosound-ip15b).
- Round-4 restored values (70): 45 currently show MANUFACTURER_VERIFIED from earlier passes, and 25 are null. The 45 were NOT re-opened in round 10, so they are not re-audited here.
- Directivity leads: 51. Imported: 0. All are `LEAD_NOT_IMPORTED`.

## Task status
| Task | Status | Evidence / blocker |
|---|---|---|
| Field-level audit of 797 unchecked fields | PARTIAL | Not complete. Round 10 settled 1 field (Motion 60XT driverCount). |
| 70 restored values individually checked | PARTIAL | 45 unverified by this round; 25 remain null. 3 of their sources (Echo blog, Peavey price guide, Pioneer homepage) were opened and rejected. |
| Motion 60XT | PARTIAL | driverCount 4 verified from the manufacturer spec table. active stays cited-unchecked (page does not say passive). |
| Remaining research queue (447 URLs) | NOT STARTED beyond sampled items | Each URL needs its own open-and-check pass. |
| Focal Sopra N2 91 dB | DONE (kept) | Value and 2.83V/1m reference on the Focal-Naim sheet. |
| QSC WL3082 / WL212-sw active | UNRESOLVED | Null. Cited WL8 sheet does not state active or passive. |
| Turbosound iP15B | PARTIAL | Dealer copy only. Points are third-party and not simulated. sourceType unset. Manufacturer original (media63.musictribe.com) not reachable. |
| LSR32 20 kHz | UNRESOLVED | Disputed, kept out of simulation. Owner chose to keep both readings disputed. |
| NS-6490 impedance | UNRESOLVED (kept N/A) | US page says 8 ohms. Market/variant of the record is not settled, so N/A stays. |
| JBL 4311 | KEPT | Owner-approved: stored values kept. |
| ELX200-15 | UNRESOLVED (kept excluded) | Stored 85 points are disputed and not simulated. EN 87-row table is an unverified alternate. |
| 27 response datasets re-audit | PARTIAL | Audit gate passes. Row-by-row re-audit against exact-model sources not done for all 23 simulated tables. Only ELX (EN, 87/87 rows) was checked row-by-row this round. |
| 51 directivity leads | INSPECTED (reasons recorded), 0 imported | See `scripts/research/directivity-leads.json`. Notes classify them as nominal angles only, beamwidth-only tables, unsupported formats (GLL, CLF/SOFA without a parser), or duplicates/archived. |
| Genelec 8331A SOFA | BLOCKED | Zenodo host unreachable from the sandbox. Not substituted. Checksum not verified because the file was not obtained. Format (SOFA) also has no parser in `server/directivityParser.ts`. |
| Test runner discovery | DONE | `src/lib/newSpeakers.test.ts` is discovered and ran (PASS in the last full run). |
| Test suite | PASS | 59/59 suites passed (`npm test`). |
| Audits | PASS | audit:speaker, audit:provenance, audit:final, docs:consistency, audit:release all exit 0 after regeneration in dependency order. |
