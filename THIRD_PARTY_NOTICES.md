# Third-party notices

Indexlume's original application code and documentation owned by Oryxsol are
licensed under the Apache License, Version 2.0. This file records material
third-party software used by the project. Third-party works remain under their
own licenses and copyrights; nothing in this repository relicenses them or
claims Oryxsol ownership of them.

This notice is a technical inventory, not legal advice. The generated inventory
at `artifacts/security/dependency-licenses.json` records the declared license
metadata for every installed JavaScript package resolved from `pnpm-lock.yaml`.

## Direct production dependencies

| Dependency                                                   | Version | Declared license |
| ------------------------------------------------------------ | ------- | ---------------- |
| `@nestjs/bullmq`                                             | 12.0.0  | MIT              |
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | 12.2.0  | MIT              |
| `@prisma/adapter-pg`, `@prisma/client`, `prisma`             | 7.10.1  | Apache-2.0       |
| `@radix-ui/react-popover`                                    | 1.3.1   | MIT              |
| `@radix-ui/react-slot`                                       | 1.5.0   | MIT              |
| `argon2`                                                     | 0.45.1  | MIT              |
| `bullmq`                                                     | 6.4.0   | MIT              |
| `class-variance-authority`                                   | 0.7.1   | Apache-2.0       |
| `clsx`                                                       | 2.1.1   | MIT              |
| `cmdk`                                                       | 1.1.1   | MIT              |
| `cookie-parser`                                              | 1.4.7   | MIT              |
| `ioredis`                                                    | 6.0.0   | MIT              |
| `lucide-react`                                               | 1.61.0  | ISC              |
| `next`                                                       | 16.4.2  | MIT              |
| `pg`                                                         | 8.23.1  | MIT              |
| `react`, `react-dom`                                         | 19.3.1  | MIT              |
| `reflect-metadata`                                           | 0.2.2   | Apache-2.0       |
| `rxjs`                                                       | 7.8.2   | Apache-2.0       |
| `tailwind-merge`                                             | 3.7.0   | MIT              |
| `zod`                                                        | 4.6.7   | MIT              |
| Next.js SWC Linux packages                                   | 16.4.2  | MIT              |
| Lightning CSS Linux packages                                 | 1.32.0  | MPL-2.0          |

Direct development dependencies are declared under MIT, Apache-2.0, BSD-2-Clause,
or their respective `@types` package licenses. They include ESLint, Prettier,
Turbo, TypeScript, typescript-eslint, Vitest, Playwright, Tailwind CSS, PostCSS,
`tsx`, `dotenv`, and type-definition packages. Consult the generated inventory
and each installed package for the complete text and copyright notices.

## Container and service components

### Typesense Server 30.2

Typesense Server is an independent service licensed under GPL-3.0. It is not
part of the Apache-2.0 grant for Indexlume and is not owned by Oryxsol. The
Compose configuration builds a security-updated image derived from
`typesense/typesense:30.2`. Any distribution of that derived image must preserve
the upstream GPL notice and provide the complete corresponding source in the
manner required by the GPL. The image keeps a copy of the GPL at
`/usr/share/doc/typesense/COPYING`.

Upstream source and license information:
<https://github.com/typesense/typesense/tree/v30.2>

### Redis 8.10.2

Redis 8.10.2 is offered under the Redis Source Available License 2.0, the Server
Side Public License 1.0, or the GNU Affero General Public License 3.0. The
Compose file references the upstream `redis:8.10.2` image as a separate service;
Redis is not relicensed under Apache-2.0. Anyone redistributing, mirroring, or
embedding that image must deliberately select and comply with an offered Redis
license. The BSD license for the Docker Official Image packaging scripts does
not replace the Redis server license.

Upstream license information:
<https://github.com/redis/redis/blob/8.10.2/LICENSE.txt>

### PostgreSQL 17.11 and gosu 1.19

PostgreSQL is independently licensed under the PostgreSQL License. The derived
database image also contains `gosu` 1.19, licensed under Apache-2.0. The build
copies the gosu license to `/usr/share/doc/gosu/copyright`; the PostgreSQL base
image retains its own copyright file.

Upstream license information:

- <https://github.com/postgres/postgres/blob/REL_17_11/COPYRIGHT>
- <https://github.com/tianon/gosu/blob/1.19/LICENSE>

### Node.js and Debian packages

The application image copies the Node.js 24.19.0 runtime from the official
Node.js image. Node.js is MIT-licensed and contains additional third-party
notices in its upstream license file, which is copied into the runtime image at
`/usr/local/share/licenses/node/LICENSE`. Debian packages retain their package
copyright information under `/usr/share/doc`.

Upstream Node.js license information:
<https://github.com/nodejs/node/blob/v24.19.0/LICENSE>

## Trademarks and independence

Typesense, Redis, PostgreSQL, Node.js, and other names may be trademarks of
their respective owners. Indexlume is independent software and is not an
official Typesense product.
