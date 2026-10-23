# License and redistribution review

## Project decision

Oryxsol-owned original Indexlume application code and documentation are
licensed under the Apache License, Version 2.0. The repository contains the
official license text in `LICENSE`, the Oryxsol notice in `NOTICE` and
`COPYRIGHT`, and a component inventory in `THIRD_PARTY_NOTICES.md`.

This grant applies only to work Oryxsol owns. Contributors and third-party
authors retain their copyrights. Independently licensed software is not
relicensed under Apache-2.0.

## Direct dependency audit

The direct JavaScript production and development dependencies were reviewed
against the versions pinned by the workspace manifests and `pnpm-lock.yaml`.
Their declared licenses are MIT, Apache-2.0, ISC, BSD-2-Clause, or MPL-2.0. The
complete installed-package inventory contains 479 packages and, at the time of
the recorded audit, no package lacked declared license metadata.

Declared package metadata is useful evidence, but it is not a legal clearance
or a substitute for reviewing the actual license and notice files included with
a release. `pnpm security:licenses` now fails when installed packages have no
declared license metadata.

## Independently licensed services and image contents

- **Typesense Server 30.2:** GPL-3.0 and independent from Indexlume. Source-only
  publication of Indexlume does not relicense Typesense. Distribution of the
  locally derived Typesense image requires the applicable GPL notices and a
  compliant complete-corresponding-source delivery method.
- **Redis 8.10.2:** offered under RSALv2, SSPLv1, or AGPLv3. The Compose file
  references it as a separate upstream image. If Oryxsol mirrors, bundles, or
  redistributes it, Oryxsol must choose an offered license and meet its terms;
  the Docker packaging repository's BSD license is not the Redis server license.
- **PostgreSQL 17.11:** independently licensed under the PostgreSQL License.
- **gosu 1.19:** Apache-2.0. Its license is copied into the derived PostgreSQL
  image.
- **Node.js 24.19.0 and Debian packages:** independently licensed. The Node.js
  license and bundled notices are copied into the application runtime image;
  Debian package copyright material remains under `/usr/share/doc`.

The Apache Software Foundation states that Apache-2.0 software can be combined
with GPLv3 software under the GPLv3 terms. That compatibility does not remove
the GPL obligations that apply when the combined or derived binary is
distributed.

## Version 0.1.0 publication decision

Version 0.1.0 publishes the Apache-2.0 Indexlume source archive and release metadata only. It does not attach or publish an Oryxsol-hosted application, Typesense, Redis or PostgreSQL image. Operators build the application locally and obtain/build independently licensed services through the documented Compose process.

This source-only boundary means the Typesense and Redis binary-redistribution questions below are not applicable to the 0.1.0 release assets. They remain mandatory review items before any later Oryxsol-hosted service image or combined binary distribution.

## Conflicts and uncertainties to close before publishing binaries

1. Confirm the exact GPL-3.0 variant and the complete-corresponding-source or
   written-offer process for any Oryxsol-published Typesense image.
2. Decide whether Oryxsol will redistribute Redis. If so, select one of Redis
   8.10.2's offered licenses and document the resulting source/network-service
   obligations before publication.
3. Re-run the dependency inventory and container SBOM generation from the final
   tagged revision and retain the CI artifacts with the release evidence.
4. Verify that any later image-pruning step preserves license and copyright
   material from Node.js, Debian, PostgreSQL, gosu, Typesense, and Redis.
5. Complete an owner/legal trademark, name and supplied-logo review for the public repository and any website. This technical audit does not claim that clearance.
6. The source repository URL is <https://github.com/junaidtariq48/indexlume> and is recorded in the root and public-client package metadata.

## Safe initial publication boundary

Publish the Apache-2.0 Indexlume source repository and verified source archive.
Have operators obtain/build independently licensed service components themselves.
Do not publish Oryxsol-hosted derived Typesense or Redis images until the items
above are closed and recorded. Version 0.1.0 follows this boundary.

This is a technical compliance review, not legal advice or a determination that
a particular distribution is legally compliant.
