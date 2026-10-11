# Round 5 L-Acoustics queue review (updated 2026-10-12 after owner answers)

Script that applies these decisions: `scripts/research/apply-owner-2026-10-12-la.py`.

| Record | Owner answer (2026-10-12) | Source used | Result |
|---|---|---|---|
| legacy-la-7 "X15" | Rename to "X15 HiQ" and verify from the official page | https://www.l-acoustics.com/products/x15-hiq/ (official L-Acoustics page) | Renamed. Verified: 2 drivers, active, LF 15 in, impedance 8 ohm, -10 dB bandwidth 55 Hz to 20 kHz ([X15] preset). Sensitivity and RMS power not published, so N/A. Max SPL 138 dB is a peak level, so not stored. Status PARTIALLY_VERIFIED. |
| legacy-la-2 "ARCS" | Add ARCS II as a separate record; then (2026-10-12 owner decision) remove the "ARCS" row | https://www.sisme.com/media/3071/lacoustics-arcsii_ds.pdf, footer "ARCS II_SP_EN_2-0/10-11" (third-party host; l-acoustics.com ARCS II page not reached) | New record `lacoustics-arcs-ii`: 2 drivers, active, LF 15 in with 4 in coil, impedance 8 ohm, -10 dB 50 Hz to 20 kHz ([ARCS II] preset). THIRD_PARTY_VERIFIED, as for Kara. Max SPL 140 dB not stored (no field; a second copy reports 142 dB). Power per transducer only, so N/A. The "ARCS" row was removed from live and archived unchanged (no exact-model source). |
| legacy-la-1 "V-DOSC" | Search widely; delete if no source is found | Searches returned only third-party-hosted older sheets (yumpu, base.ren-ting.com, tosti-lane.com) for other revisions. No exact-revision L-Acoustics source. | Removed from live and archived unchanged in `removed-owner-round5-records.json` (25 records). Not deleted, per the archive rule. |

Counts after the ARCS removal: live 670, archived 81 + 26 = 107, reviewed total 777 (approved by the owner on 2026-10-12).
Records still UNVERIFIED: 8 (see RESEARCH-QUEUE.md).

Open items:
- legacy-la-2 "ARCS": RESOLVED 2026-10-12. Owner chose removal; archived unchanged.
- The official l-acoustics.com ARCS II page did not load. A fresh attempt is needed to upgrade ARCS II to MANUFACTURER_VERIFIED.
- ARCS II max SPL conflict: the datasheet says 140 dB and a second copy of the ARCS II User Manual says 142 dB. Needs a manufacturer revision check.
