# Architecture

How the Hamolus core is built and how a request flows through it.

```
                 ┌──────────────────────────────────────────────┐
                 │             upstream: site/console            │
                 │   (Cloudflare Pages · Astro / SolidJS SPA)   │
                 └───────────────┬──────────────────────────────┘
                                 │ HTTPS  (Bearer token; x-land for lands)
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │               @hamolus/core (Workers)        │
                 │  Hono app  → /api/*                          │
                 │   ├── JWT auth middleware (HS256)            │
                 │   ├── /api/_auth/token   (login key → JWT)   │
                 │   ├── /api/_meta/collections  (metadata CRUD)│
                 │   ├── /api/_meta/settings   (KV settings)    │
                 │   ├── /api/_meta/seed       (export/restore) │
                 │   ├── /api/_media · /documents · /attachments│
                 │   ├── /api/_plugins        (KV plugin store) │
                 │   └── /api/{collection}       (dynamic CRUD) │
                 └───────┬───────────────┬──────────────────────┘
                         │ D1           │ KV
                         ▼              ▼
                    metadata tables   settings blob
                    + dynamic tables  ("settings:{land}:v1")
```

## The core

A single Cloudflare Worker using **Hono**, **Drizzle ORM (D1/SQLite)**, and
**Cloudflare KV**.

- `src/index.ts` — the Hono app. A pre-auth land rewrite
  (`createLandRewrite`) strips a registered `/{land}[/{colony}]` prefix into
  `x-land`/`x-colony` headers, then all `/api/*` routes require a JWT, except
  the `AUTH_SKIP` set (`/api/_auth/token`, `/api/_auth/login`,
  `/api/_auth/setup`, `/api/_auth/super`, `/api/health`). When
  `PUBLIC_GETS=true` is set, GET endpoints become public (used by the site
  without a token). `/media/:key`, `/documents/:key`, `/attachments/:key` are
  outside `/api` and always public (immutable-cached; content-negotiated HTML
  viewer vs raw bytes).
- `src/meta/store.ts` — the *registry*. Collection definitions are stored in the
  `_meta_collections` D1 table and cached in the isolate. Any `PUT
  /api/_meta/collections/{name}`:
  1. validates the definition with the Zod schema from `@hamolus/types`;
  2. runs `CREATE TABLE IF NOT EXISTS` for the physical table;
  3. migrates **new** fields onto existing tables with `ALTER TABLE … ADD COLUMN`
     (deduplicated against `PRAGMA table_info`);
  4. upserts the metadata row. Bootstrapping also reconciles duplicate rows and
     creates the unique index on `name` so they can never reappear.
- `src/db/table.ts` — SQLite DDL helpers: `TEXT` columns for most types,
  `NUMERIC` for numbers, `INTEGER` for booleans; `id` columns store UUIDs.
  `physicalTable(land, name)` derives per-land table names.
- `src/db/queries.ts` — generic `list / get / create / update / delete` over any
  collection definition, with whitelisted identifiers (SQL-injection safe).
- `src/db/coerce.ts` — value coercion into/out of D1 (`boolean → 0/1`,
  `json/richtext/media/… → TEXT`, localized object resolution, `?locale=`).
- `src/meta/settings.ts` — KV-backed settings blob under `settings:v1` (default
  land) / `settings:{land}:v1`.
- `src/meta/groups.ts` — self-parenting navigation group registry
  (`_meta_groups` table, auto-bootstrapped like `_meta_collections`): `listGroups`,
  `putGroup` (parent-exists + cycle + snake_case validation), `deleteGroup`
  (referential guards). An arbitrarily deep `parent` chain arranges collections
  into a navigation tree; `@hamolus/types` `buildGroupTree` resolves registered
  groups + collection definitions into a normalized tree.
- `src/meta/lands.ts` — land + colony registries (`_meta_lands`, `_meta_colonies`),
  the delete-land cascade (colonies + per-land users), and the `LAST_ADMIN` guard.
- `src/meta/seed.ts` + `routes/seed.ts` — full-state **snapshot export/restore**
  (`GET/POST /api/_meta/seed`): groups, collection definitions, records (with
  rowids), media rows + R2 objects (optional base64), and KV settings. Apply
  validates the entire snapshot *before* any destructive wipe.
- `src/meta/stats.ts` — dashboard stats (`/api/_meta/stats`).
- `src/media/*` + `src/files/*` + `routes/{media,files}.ts` — R2-backed media
  (images: upload/WebP/thumbnails/variants/focus/taxonomy + the public
  content-negotiated viewer) and document/attachment file libraries.
- `src/routes/plugins.ts` — KV-backed plugin storage (`/api/_plugins/:plugin[/:key]`,
  per-land `plugin:{land}:{plugin}:` prefix).
- `src/auth/*` — sessions, users, privileges, super admins, password hashing.
- `src/routes/{auth,meta,dynamic}.ts` — route groups. `dynamic.ts` is the
  metadata-driven CRUD dispatcher.

### Bootstrapping

On the isolate's first use, `ensureMetaTable` creates `_meta_collections` and
backfills any columns added in later versions; `ensureGroupsTable` creates
`_meta_groups`; `ensureMediaTable`/file-store equivalents create the media and
file tables; `ensurePrivileges` seeds the per-land privileges registry. D1 tables
are created lazily on their first `PUT` definition. Nothing runs at deploy time.

## Multi-tenancy (lands / colonies)

A single core instance can serve one or more **lands** (sub-tenants), each
optionally split into **colonies**. Land behavior is gated by `CORE_MODE`
(`independent` [default — single-land] | `centralized` [every per-land request
must carry a land] | `proxy` | `bridge`) and `DEFAULT_LAND`. `src/land.ts`
owns the machinery; `meta/lands.ts` and `meta/colonies.ts` are the registries.

- **URL grammar**: CORE `/api/{land}[/{colony}][/{group…}]/{collection}[/{id}…]`,
  PROXY `/api[/{group…}]/{collection}[/{id}…]`, BRIDGE via `upstreams:v1`. A
  pre-auth rewrite strips a registered land[/colony] prefix into `x-land`/
  `x-colony` headers (`x-scope-rewritten` loop guard), re-dispatching through the
  whole middleware chain. `__` is forbidden in land/collection names.
- **Isolation**: `physicalTable(land, name)` — bare `{name}` for the default land,
  `{land}__{name}` otherwise — applies to collections, per-land records and
  `{land}__privileges`. Settings are KV-isolated under `settings:{land}:v1`
  (default keeps legacy `settings:v1`). `config` rows key on `(land, key)`.
- **Auth**: one global `_auth_users` table with a `land` column; login resolves
  the land from the username row and JWTs carry a `land` claim. A header/claim
  mismatch is `403 LAND_MISMATCH`. Admin-key tokens carry no `land` claim
  (land-agnostic). Privileges bootstrap lazily per land with stable UUIDs, so
  role ids match across lands.
- **Scopes**: global paths are `health`, `_auth/{token,login,setup,me}`,
  `_meta/lands`, `_meta/colonies`; everything else (settings/groups/collections/
  stats, users/config, media/document/attachment libraries, dynamic CRUD) is
  per-land.
- **Strict mode**: in `centralized`, a request with no `x-land` header and no
  JWT `land` claim hitting a per-land path is rejected with `400 LAND_REQUIRED`
  (the global allowlist is prefix-matched, so `/api/_meta/lands/{id}` stays
  global).

## Service endpoints

- `src/routes/auth.ts` — `/api/_auth/token` (admin key → JWT), `/api/_auth/login`
  (username/password), `/api/_auth/setup`, `/api/_auth/super`,
  `/api/_auth/me[/password]`, users/config management (per-land).
- `src/routes/dynamic.ts` — the metadata-driven CRUD for `/{collection}`.
- `src/routes/media.ts` / `src/routes/files.ts` — media + document/attachment
  libraries (see `docs/api.md`).
- `src/routes/plugins.ts` — KV plugin storage.

## data flow for a page load (upstream → core)

1. Upstream (site/console) requests `/api/posts`.
2. The upstream `lib/api` composes the URL from its configured base, attaches the
   Bearer token (and `x-land` for non-default lands) if present.
3. Core runs the land rewrite, then the JWT middleware, parses the route, builds
   a whitelisted SQL query, runs it against D1, and returns `{ data, meta }`.
4. Upstream renders the result (or a "no records" fallback); header/brand are
   driven by `GET /api/_meta/settings`.

## identifiers are SQL-injection-safe

Every table/column name from user input (collection names, field names, sort keys,
filter keys) passes through `isIdentifier` / `quoteIdentifier`:

- identifiers must match `^[a-z][a-z0-9_]*$` or the request is rejected;
- identifiers are quoted (`"name"`) when interpolated into SQL;
- values are passed as bound parameters (Drizzle `sql` values), never interpolated.