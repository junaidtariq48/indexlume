# Changelog

All notable changes to Indexlume are documented here.

## [0.1.0] — 2026-10-23

Initial open-source release candidate.

### Added

- Self-hosted web, API, worker, PostgreSQL, Redis, and Typesense stack with health checks.
- One-time owner setup, session authentication, workspace/project RBAC, and audit trail.
- Bundled or external Typesense connections, collection lifecycle, Search Studio, presets, and constrained public search keys/API/TypeScript client.
- Encrypted upload and PostgreSQL ingestion with durable jobs, retries, cancellation, incremental cursors, reconciliation, and alias promotion.
- Multi-table relational projections with bounded joins, immutable versions, change tracking, guarded hard-delete reconciliation, and crash-safe replay.
- Live aggregate analytics, accessible responsive operations UI, typed notifications, and role management including editor.
- Versioned encryption envelopes, key rewrap tooling, backup/restore tooling, CI gates, vulnerability scans, license inventory, SBOMs, and release evidence.
- Apache-2.0 licensing for Oryxsol-owned original code, with explicit third-party and container-component notices.

### Database migrations

The release contains 12 forward Prisma migrations. The API applies pending migrations before it starts. Back up PostgreSQL and the Typesense, Redis, and upload volumes before upgrading; follow [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md).

### Upgrade

1. Back up metadata and named volumes and retain the active encryption/HMAC/search-pepper secrets.
2. Review `.env.example` for new required secrets and defaults.
3. Pull the exact release source/images and run `docker compose up --detach --build --wait`.
4. Run `./infra/smoke.sh` and validate representative connections, indexes, projections, and public searches.

### Rollback

Application rollback alone is not a database rollback. Stop writes and restore the pre-upgrade PostgreSQL and service-volume backup as one consistent set, restore the prior secrets, deploy the prior source revision, and run readiness plus search checks. Do not manually edit Prisma migration records or projection checkpoints.

### Known limitations

- Initial production target is a self-hosted single-machine Compose deployment. Horizontal worker/API scaling and managed object staging require deployment-specific design.
- Hard deletes require reconciliation when no supported soft-delete field exists.
- Raw query text and top-query analytics are intentionally not stored.
- External databases and Typesense endpoints are default-deny for private/insecure addresses unless the operator explicitly enables trusted-network development settings.
- Capacity results are observations from documented local hardware, not service guarantees.
- Oryxsol-hosted derived Typesense or Redis images must not be published until the distribution-specific obligations documented in `docs/LICENSE_REVIEW.md` are closed.

[0.1.0]: https://github.com/junaidtariq48/indexlume/releases/tag/v0.1.0
