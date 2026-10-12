# Cavity Audio — Final Release Verification

**Audit date:** 2026-10-12  
**Product:** Cavity Audio 3.1.0  
**Release constraints:** free/public/no login/no payment; 50,000,000 FDTD grid-cell ceiling; 1–16 sources; 1–64 receivers.

## Verdict

# NOT RELEASE READY

The source/data gates are prepared and current documentation is generated from the authoritative source. External runtime, Windows signing, cloud credentials, and legal approval remain release-owner responsibilities and are not represented as completed by this source archive.

## Speaker database

- Records: 670
- Unique IDs: 670
- Unique brand/model pairs: 670
- PARTIALLY_VERIFIED: 662
- UNVERIFIED: 8
- UNAVAILABLE: 0
- Source-backed fields: sensitivity 309; power 418; impedance 358; resonant frequency 17; voice-coil size 64; woofer size 593; frequency-response limits 565.
- Response models: 670; 533 are modeled from published response limits, 111 use the generic reference path, and 26 use source-backed response-point datasets.
- Source-backed response-point datasets: 26 (measurement 0, manufacturer 26, reputable database 0).
- Embedded polar/CLF/GLL speaker directivity datasets: 0.
- Unsupported information remains unavailable rather than guessed.

## Scientific/data honesty

- Published bandwidth limits are not presented as measured response curves.
- No laboratory measurement is claimed without measurement provenance.
- Generic/reference speaker models are labeled as modeled.
- Speaker-specific polar/directivity behavior is not fabricated.
- Physical scatter is not modeled.
- 2.83 V/1 m sensitivity is normalized to the 1 W/1 m DSP reference only when nominal impedance is known.

## Implemented production safeguards

- Cloud Run, Cloud Tasks, Storage lifecycle, and Cloud Monitoring provisioning scripts are included.
- Production deployment requires configured release/cloud resources.
- Windows production release requires a signed Authenticode installer.
- Privacy, Terms, license, and third-party notice assets are included.
- Speaker data gaps and source provenance are generated from the current database.

## External requirements

- Owner/legal approval of the shipped license, Privacy Policy, and Terms is still required.
- GCP/Firebase resources, secrets, notification email, and IAM must be configured in the production project.
- Windows signing credentials/certificate must be configured on the Windows release runner.
- Clean Node 22.23.3+ <23 installation and the complete runtime release gate must be executed in a supported environment.

## Release rule

This source archive must not be described as a fully runtime-verified Windows production release until the external requirements above produce release evidence.
