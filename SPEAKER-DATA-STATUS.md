# Cavity Audio — Speaker Data Status

Generated from `src/data/speakers.json`; counts are not hand-maintained.

Updated 2026-10-10.

The authoritative dataset contains **774 catalog records**. A record is `PARTIALLY_VERIFIED` only when at least one sourced acoustic specification (sensitivity, power, impedance, resonant frequency, voice-coil size, woofer size, or a structured frequency-response limit) is retained. Source-backed structural facts such as driver count or active status alone remain `UNVERIFIED` because they do not supply an acoustic specification for simulation. `UNAVAILABLE` is reserved for unresolved catalog identities and confirmed non-loudspeaker components; those records are retained but excluded from speaker selection.

## Record status
- PARTIALLY_VERIFIED: 647
- UNVERIFIED: 50
- UNAVAILABLE: 77

## Current source-backed fields
- Sensitivity: 307
- Power: 415
- Impedance: 351
- Resonant frequency: 17
- Voice-coil size: 63
- Woofer size: 583
- Frequency-response limits: 558

## Response-model policy
- Embedded source-backed response-point datasets: 27 (measurement 5, manufacturer 22, reputable database 0)
- Models derived from published frequency limits: 525
- Generic reference models with missing published bounds: 222
- No synthesized curve is represented as a laboratory measurement.

## Directivity / scatter
- Embedded speaker polar/directivity datasets: 0
- Physical scatter model: not implemented
- Speaker selection alone does not imply speaker-specific room directivity.

## Integrity rule
A missing field is `N/A` rather than guessed. A published bandwidth is not converted into a fabricated frequency-response curve.
