# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting for security issues when it is available for this repository. Do not place credentials, private account data, browser snapshots, device tokens, deployment origins, or exploit details in a public issue.

If private reporting is unavailable, open a public issue with only a redacted description and ask the maintainers for a private channel. Do not include a working exploit or sensitive value.

## Supported code

Security fixes target the current `main` branch. This personal-assistant project has no published compatibility or long-term-support branches.

## Deployment responsibility

A source checkout is not a secure deployment by itself. Operators must use separate control and executor credentials, keep local configuration outside version control, review source before cloud upload, restrict native workspace access, and follow the deployment and recovery boundaries in [Development and operation](docs/runbooks/local-development.md).
