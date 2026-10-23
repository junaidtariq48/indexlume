# Contributing

## Before opening a change

Use an issue for reproducible defects or an agreed feature proposal. Security reports must follow [`SECURITY.md`](SECURITY.md) and must not be filed publicly.

Discuss substantial feature or API changes in an issue before implementation. Do not expose Typesense administration keys to browsers, add arbitrary SQL execution, store raw query text, or introduce a connector without its security and operational behavior being reviewed. Update the public documentation when behavior or an API contract changes.

## Local setup

Use Node.js 24.15 or newer on the 24.x line and pnpm 10.34.5.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up --detach --build --wait
```

The values in `.env.example` are development placeholders. Never commit a populated `.env`, credentials, customer records, database dumps, or generated search keys.

## Required checks

Run the checks appropriate to the change and, before requesting release review, run the complete gate:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:integration
pnpm security
```

UI changes must be checked at 320px and desktop widths with keyboard operation. Data, authorization, ingestion, or connector changes require negative cross-project and role tests. Migration changes require the clean migration test. Never replace a failing check with an unverified claim.

## Pull requests

Describe the user-visible outcome, security and data implications, migrations, verification commands, and any known limitation. Keep generated artifacts and unrelated formatting out of the change. Release-affecting pull requests must update `CHANGELOG.md` and any relevant public documentation.

## Contribution licensing

By intentionally submitting a contribution, you confirm that you have the right to submit it. Unless you explicitly state otherwise in writing and the maintainers agree, your contribution is submitted under the Apache License, Version 2.0, as described by Section 5 of that license. You retain copyright in your contribution.

Do not copy third-party code, designs, assets, or documentation into a contribution unless its license permits the intended use. Identify its source, copyright holder, license, and any required notice in the pull request, and update [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) when appropriate. Do not remove or alter third-party license notices. See [`docs/LICENSE_REVIEW.md`](docs/LICENSE_REVIEW.md) for the current redistribution boundary and unresolved service-image questions.
