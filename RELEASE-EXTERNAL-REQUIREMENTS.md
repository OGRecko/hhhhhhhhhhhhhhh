# Cavity Audio — External Production Requirements

These items require external credentials, live infrastructure, a supported Windows runner, or owner/legal approval.

## Owner / legal
- Approve `LICENSE` (Proprietary Freeware License).
- Approve `PRIVACY.md` and `TERMS.md`.
- Review `THIRD-PARTY-NOTICES.md`.

## GitHub secrets
- `GCP_SERVICE_ACCOUNT_KEY`
- `GCP_PROJECT_ID`
- `CLOUD_RUN_SERVICE`
- `CLOUD_RUN_REGION`
- `CLOUD_RUN_SERVICE_ACCOUNT`
- `FIREBASE_STORAGE_BUCKET`
- `RELEASES_BUCKET`
- `CLEANUP_SECRET`
- `CLOUD_TASKS_QUEUE`
- `CLOUD_TASKS_LOCATION`
- `CLOUD_TASKS_DISPATCH_SECRET`
- `MONITORING_ALERT_EMAIL`
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

Production deployment now requires `RELEASES_BUCKET` and `MONITORING_ALERT_EMAIL`; the Windows production workflow requires signing secrets and a valid Authenticode signature.

## Toolchain
- Node 22.23.3 through 22.x.
- npm 10.9.9.
- `windows-latest` for Windows packaging.
- Network access to the npm registry for a clean install.
