# Indexlume

**Built for developers. Designed for simplicity. Ready to scale.**

Public search integration is documented in [docs/PUBLIC_SEARCH_API.md](docs/PUBLIC_SEARCH_API.md), with JavaScript/TypeScript and PHP examples.

Indexlume is an open-source, self-hosted search operations platform built on top of Typesense.

The `0.1.x` release line is distributed as source. Oryxsol does not publish modified Typesense or Redis images as part of this release.

## Requirements

- Docker Engine 29 or another current Docker release with Compose v2 support
- At least 4 GB of memory available to Docker for the local stack
- Node.js 24.15 or newer on the 24.x line and pnpm 10.34.5 for host-side development

The Compose images are pinned and intended to support Linux `amd64` and `arm64`. macOS runs the Linux containers through Docker Desktop. Windows users should use WSL2; native Windows execution is not part of the initial compatibility target.

## Quickstart

```bash
cp .env.example .env
docker compose up --detach --build --wait
./infra/smoke.sh
```

Open the dashboard at <http://localhost:3000>. API liveness and readiness are available at:

- <http://localhost:3001/api/v1/health/live>
- <http://localhost:3001/api/v1/health/ready>

Stop the stack without deleting its named data volumes:

```bash
docker compose down
```

## Host-side checks

Install the pinned Node.js and pnpm versions, copy the environment file, and run:

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The Compose `DATABASE_URL` uses the service hostname `postgres`. When running commands that require a database directly on the host, replace that hostname with `localhost`.

## Workspace layout

```text
apps/web             Next.js dashboard
apps/api             NestJS REST API
apps/worker          NestJS background worker
packages/db          Prisma schema, migrations, and database client
packages/contracts   Shared Zod contracts and TypeScript types
packages/ts-client   Public TypeScript client package
infra                Container, verification, backup, and release tooling
docs                 Public API, operations, security, licensing, and release documentation
```

## Configuration and secrets

`.env.example` contains development-only placeholder credentials. Change them before any non-local deployment. Never commit `.env` or real credentials. The API validates required environment configuration at startup.

The dashboard supports bundled and explicitly configured external Typesense connections. Public clients use the guarded platform proxy; the Typesense administrative key is never exposed.

External PostgreSQL and Typesense targets are server-side connections. Private or insecure endpoints are denied by default and must only be enabled for an operator-controlled network. The platform stores aggregate search counters and latency histograms; it does not store raw query text or top-query analytics. Source records and projected documents are processed for indexing and must be protected by the deployment's database, volume, network, backup, and retention controls.

## Documentation

- [`docs/PUBLIC_SEARCH_API.md`](docs/PUBLIC_SEARCH_API.md) — public search API and client examples
- [`CHANGELOG.md`](CHANGELOG.md) — versioned release notes, upgrade, rollback, and known limitations
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — direct dependency and container-component attributions
- [`docs/LICENSE_REVIEW.md`](docs/LICENSE_REVIEW.md) — licensing decision, audit results, and unresolved binary-redistribution questions
- [`docs/BACKUP_RESTORE.md`](docs/BACKUP_RESTORE.md) — protected backup, guarded restore, and recovery drills
- [`docs/KEY_ROTATION.md`](docs/KEY_ROTATION.md) — versioned envelope, rewrap, and key-retirement procedure
- [`docs/SECURITY_SCANS.md`](docs/SECURITY_SCANS.md) — reproducible dependency, secret, license, image, and SBOM gates
- [`SECURITY.md`](SECURITY.md) — private vulnerability reporting policy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution scope and required checks

## License

Copyright 2026 Oryxsol. Indexlume's original application code and documentation owned by Oryxsol are licensed under the [Apache License 2.0](LICENSE).

Third-party components retain their independent licenses and copyrights; see [`NOTICE`](NOTICE), [`COPYRIGHT`](COPYRIGHT), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). In particular, Typesense Server remains independently licensed under GPL-3.0 and is not relicensed or owned by Oryxsol. Redis 8.10.2 is offered under its own tri-license. This project is not an official Typesense product.

Verified source archives, manifests and checksums are published with the [GitHub releases](https://github.com/junaidtariq48/indexlume/releases).
