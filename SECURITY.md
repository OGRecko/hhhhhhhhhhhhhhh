# Security

## Supported release line

Security fixes target the current `3.1.x` release line. Do not disclose exploitable issues publicly before a fix or coordinated disclosure decision is made.

## Reporting

Report suspected vulnerabilities privately to the project owner/maintainer using the contact channel designated for the release. Do not include live credentials, capability tokens, private keys, or user data in an issue or pull request.

## Release security requirements

Production Windows installers must be Authenticode-signed. Production deployment secrets must be stored in the deployment platform or GitHub Actions secrets and must never be committed to the repository.
