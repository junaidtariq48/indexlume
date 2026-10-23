# Backup and restore

This guide covers the pinned single-host Docker Compose deployment. A backup contains sensitive PostgreSQL metadata, Typesense documents, Redis state, and staged uploads. Store it encrypted with access controls and retention appropriate to the indexed data.

## What is and is not included

`infra/backup.sh` creates:

- a consistent PostgreSQL custom-format dump;
- stopped-service archives of the Typesense, Redis, and upload-staging volumes;
- a manifest with source revision, image name, timestamp, and a one-way fingerprint of `APP_ENCRYPTION_KEY`;
- SHA-256 checksums for every payload.

The backup deliberately does **not** contain `.env`, `APP_ENCRYPTION_KEY`, setup token, TLS private keys, reverse-proxy configuration, or external PostgreSQL data. Back up those through the operator's secret-management and source-database procedures. Losing `APP_ENCRYPTION_KEY` makes encrypted connector credentials unrecoverable.

## Create a backup

Use an absolute or operator-controlled destination on a filesystem with enough free space. The script briefly stops web, API, worker, Redis, and Typesense while capturing state, then waits for the stack to become healthy again.

```bash
OSC_COMPOSE_PROJECT=open-search-console \
  ./infra/backup.sh /secure/backups/osc-2026-10-22
```

Copy the backup off the application host, encrypt it at rest, and retain `APP_ENCRYPTION_KEY` separately. Check the final health state and retain the command output with the backup record.

## Restore

Restore only into the same pinned application/service versions first. Confirm the exact Compose project explicitly; restore replaces its PostgreSQL metadata and the three archived volumes.

```bash
docker compose up --detach --wait

OSC_COMPOSE_PROJECT=open-search-console \
OSC_RESTORE_CONFIRM=open-search-console \
  ./infra/restore.sh /secure/backups/osc-2026-10-22
```

The restore refuses missing files, checksum changes, an encryption-key mismatch, or a confirmation that does not exactly match the target project. Before returning traffic, run health and application checks:

```bash
./infra/smoke.sh
pnpm smoke:m2
```

Verify login, connector test, alias-backed search, recent jobs, and any external source credentials relevant to the deployment. External databases and object storage require their own recovery procedures.

## Automated recovery drill

The M7 drill uses an isolated Compose project and separate ports. It seeds the existing M1/M2 fixtures, backs up the stack, destroys only the isolated volumes, recreates an empty deployment, restores it, and reruns the M2 connection/alias/search checks.

```bash
pnpm test:restore
```

The clean migration test likewise uses its own project and removes it afterward:

```bash
pnpm test:migrations
```

Run both drills after migration, encryption, storage, image-version, or Compose changes. A successful script is evidence for that revision only; operators still need scheduled backups, retention, off-host copies, monitoring, and periodic recovery exercises.

## Deployment-owner retention decision

Indexlume is self-hosted and Oryxsol does not operate or retain a deployment's PostgreSQL, Redis, Typesense, upload, secret or backup data. Before production use, the deployment owner must record:

- backup frequency, retention period, encryption and off-host location;
- who can access backups and the separately retained encryption/HMAC/search-pepper secrets;
- setup-token retirement after bootstrap and secret-rotation cadence;
- database, Redis, Typesense and upload-volume recovery objectives;
- deletion/retention rules appropriate to the indexed source data; and
- the recovery-drill owner and schedule.

The repository deliberately does not invent one universal retention period because the correct value depends on the operator's data, jurisdiction and recovery requirements.
