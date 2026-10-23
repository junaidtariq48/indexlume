# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `0.1.x` | Yes       |
| `< 0.1` | No        |

## Reporting a vulnerability

Do not report suspected vulnerabilities in a public issue, discussion, or pull request.

Use [GitHub private vulnerability reporting](https://github.com/junaidtariq48/indexlume/security/advisories/new). Do not include exploit details, credentials or customer data in a public issue, discussion or pull request.

Include the affected revision or version, deployment mode, reproduction steps, impact, and any suggested mitigation. Remove credentials, customer data, raw indexed records, session cookies, setup tokens, encryption keys, and search keys from the report.

Maintainers should acknowledge a complete report within five business days, coordinate validation and remediation privately, and publish a concise advisory after a fix is available. This target is an operational goal, not a service-level agreement.

## Security boundaries

The project is a self-hosted control plane, not a hosted multi-tenant service. Administrators are responsible for network isolation, TLS termination, secret generation and storage, backup access, dependency updates, and restricting the setup token. Operational guidance is available in [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md), [`docs/KEY_ROTATION.md`](docs/KEY_ROTATION.md), and [`docs/SECURITY_SCANS.md`](docs/SECURITY_SCANS.md).
