# Cavity Audio — Speaker Data Status

Generated from `src/data/speakers.json`; counts are not hand-maintained.

Updated 2026-10-12.

The live authoritative dataset contains **670 active catalog records**; the reviewed catalog total is **777** (670 live + 81 archived in scripts/research/removed-unavailable-records.json + 26 archived in scripts/research/removed-owner-round5-records.json, removed at owner request 2026-10-11). The archived records were removed from the live dataset at the owner's request on 2026-10-10 (all UNAVAILABLE records, including the duplicate Sonos aliases). They are excluded from speaker selection and from every count in this document. A record is `PARTIALLY_VERIFIED` only when at least one sourced acoustic specification (sensitivity, power, impedance, resonant frequency, voice-coil size, woofer size, or a structured frequency-response limit) is retained. Source-backed structural facts such as driver count or active status alone remain `UNVERIFIED` because they do not supply an acoustic specification for simulation. `UNAVAILABLE` is reserved for unresolved catalog identities and confirmed non-loudspeaker components; those records are retained but excluded from speaker selection.

## Record status
- PARTIALLY_VERIFIED: 662
- UNVERIFIED: 8
- UNAVAILABLE: 0

## Current source-backed fields
- Sensitivity: 309
- Power: 418
- Impedance: 358
- Resonant frequency: 17
- Voice-coil size: 64
- Woofer size: 593
- Frequency-response limits: 565
- Of these, THIRD_PARTY_VERIFIED (retailer or third-party copy of an exact-model spec, not a manufacturer page): 22 field(s) on 12 record(s)

## Response-model policy
- Embedded source-backed response-point datasets: 26 (measurement 0, manufacturer 26, reputable database 0)
- Models derived from published frequency limits: 533
- Generic reference models with missing published bounds: 111
- No synthesized curve is represented as a laboratory measurement.

## Directivity / scatter
- Embedded speaker polar/directivity datasets: 0
- Physical scatter model: not implemented
- Speaker selection alone does not imply speaker-specific room directivity.

## Integrity rule
A missing field is `N/A` rather than guessed. A published bandwidth is not converted into a fabricated frequency-response curve.
