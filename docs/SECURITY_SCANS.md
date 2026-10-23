# Security scan gates

Run the complete local supply-chain gate from a clean install with Docker available:

```bash
pnpm security
```

The gate has four independent parts:

1. `security:deps` submits the pinned `pnpm-lock.yaml` dependency graph to the npm advisory service and fails on high or critical findings.
2. `security:secrets` scans committed Git history with Gitleaks 8.30.1. `.gitleaks.toml` contains only exact content-and-path-specific exceptions for three documented local-only key placeholders and one plain-English documentation phrase.
3. `security:licenses` inventories the declared license metadata of every installed package resolved through pnpm. This is evidence for legal review, not a legal approval or a license compatibility decision.
4. `security:images` rebuilds the application image, scans it and every pinned runtime image with Trivy 0.75.0, writes full JSON reports and CycloneDX SBOMs, and fails when a high or critical vulnerability has a published fixed version.

Generated evidence is written to the ignored `artifacts/security/` directory. Retain that directory with release evidence; it includes the image IDs, scan timestamps, Trivy database metadata, full vulnerability reports, a compact policy summary, the dependency license inventory, the redacted secret report, and one CycloneDX SBOM per current release image.

Unfixed findings remain in the full reports for review. They do not pass through an allowlist and must be assessed in the release checklist. A failing image gate must be resolved by updating or rebuilding the pinned image, or recorded as a release blocker; do not add a broad ignore rule.

The CI workflow pins every third-party GitHub Action to a full immutable commit
SHA, with the reviewed release tag retained in a comment. The repository also
requires full-length SHA pinning, preventing a later workflow change from using
a mutable action tag.

## 0.1.0 candidate result

The final no-cache run on 23 October 2026 used Trivy 0.75.0 with a vulnerability database updated at 13:13:41 UTC. The application image, hardened PostgreSQL 17.11 image, Redis 8.10.2 image, and hardened Typesense 30.2 image each reported zero **fixable** High or Critical findings. Full findings, image IDs, scan timestamps, and CycloneDX SBOMs are retained locally.

Trivy still reports vendor-unfixed High/Critical package records: 59 in the Debian application image, 74 in the Debian PostgreSQL image, 43 in the Debian Redis image, and zero in the Typesense image. These include distribution statuses such as `affected`, `fix_deferred`, and `will_not_fix`; they have no published package upgrade in the scanned repositories. They are retained as explicit residual supply-chain risk, not hidden by an ignore rule. The release policy blocks a finding as soon as a fixed package version exists, and operators must rerun this gate immediately before publication and on every base-image update.
