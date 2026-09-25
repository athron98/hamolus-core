# AGENTS.md

> Working notes for AI agents and humans on **@hamolus/core**, the Cloudflare
> Worker API engine behind the Hamolus platform. Read this before touching code.
> The **Work Log** at the bottom documents what's been done — append to it.

## Project

A Cloudflare Worker (Hono + Drizzle ORM over D1/SQLite + KV + R2) serving a
dynamically-defined CRUD API. Collection schemas are stored as metadata in D1
(`_meta_collections`); physical tables are created/migrated automatically.
Multi-land (lands/colonies) with per-land settings/users/privileges/media/files.

Depends on `@hamolus/types` (Zod schemas + DTOs) — currently via
`"@hamolus/types": "workspace:*"` in `package.json` (switch to
`npm:^0.0.1` once published).

## Layout

```
src/index.ts            # Hono app: land rewrite, JWT middleware, route wiring, /media|/documents|/attachments public serving
src/env.ts              # Env bindings: DB (D1), SETTINGS (KV), MEDIA (R2), JWT_SECRET, ADMIN_KEY, PUBLIC_GETS, CORE_MODE, DEFAULT_LAND, SUPER_ADMIN_*
src/errors.ts           # HttpError helper
src/land.ts             # land resolver/rewrite: x-land headers, physicalTable, LAND_REQUIRED/MISMATCH
src/auth/               # sessions, users, passwords, privileges, super admins
src/db/                 # drizzle client, schema, DDL (table.ts), generic queries, value coercion
src/meta/               # collection registry (store), settings KV, lands/colonies, groups, stats, seed snapshots
src/media/{store,size}.ts  # R2 media store + image dimension parser
src/files/store.ts      # _meta_documents / _meta_attachments file-library store
src/routes/             # auth, meta, dynamic, media, files, plugins, seed, lands
scripts/seed.mjs        # self-cleaning demo seed (12 collections, 296 records, 66 media)
scripts/{dump,apply}-seed.mjs  # seed snapshot CLIs
scripts/bootstrap.sql   # optional eager DDL for _meta_collections (auto-bootstraps anyway)
drizzle.config.ts       # drizzle-kit (generate/studio only; no migration workflow)
wrangler.jsonc          # D1 + KV + R2 bindings, vars (JSONC — comments allowed)
```

## Commands

```bash
pnpm install
pnpm typecheck          # tsc --noEmit (quality gate; no lint config)
pnpm build              # wrangler deploy --dry-run --outdir=dist
pnpm dev                # wrangler dev --port 8789 --ip 0.0.0.0
pnpm -F @hamolus/types build   # rebuild shared/types first after editing it (others use dist/)
```

Local core dev creds live in the gitignored `.dev.vars`
(`ADMIN_KEY`/`JWT_SECRET`). `wrangler dev` does **not** hot-reload TS or
`wrangler.jsonc` changes — kill the workerd on the port and restart.
`fuser` and `setsid` are NOT installed on this machine:

```bash
# find pid: lsof -ti :8789 ; kill it; then start detached:
cd packages/core && ADMIN_KEY=dev-admin-key-change-me nohup pnpm exec wrangler dev --port 8789 --ip 0.0.0.0 >/tmp/core.log 2>&1 & disown %1
```

Seed: `BASE=http://localhost:8789 ADMIN_KEY=dev-admin-key-change-me node scripts/seed.mjs`
(self-cleaning — no manual clears needed).

## Conventions

- Collection & field names are mandatory `snake_case` (`^[a-z][a-z0-9_]*$`);
  identifiers are whitelisted + SQL-quoted before interpolation; values are always
  bound parameters. Never interpolate user input into SQL.
- Zod 4 schemas live in `@hamolus/types`; `.strict()` blocks extra fields.
- UI text and error messages are **English** (the demo seed's localized `{en,id}`
  field values are data, not chrome).
- Don't add comments to code unless asked; docs live in `docs/`.
- Add the SPDX header (see `../header-template.txt`, Variant B) to every new file.
- **No secrets in code**; dev creds are `.dev.vars` only. `wrangler deploy`
  uses secrets via `wrangler secret put`.

## Runtime facts (verified)

- Ports: core defaults to **8789**. `wrangler dev` auto-provisions D1/KV/R2
  locally from the placeholder ids.
- `PUBLIC_GETS=true` bypasses JWT for **all** GETs under `/api/*` (records AND
  meta reads) unless a Bearer token is present. PUT/POST/DELETE always require
  auth. Only `/api/_auth/{token,login,setup,super}` and `/api/health` are always
  public.
- `group`/`land` are SQL keywords — quoted (`"group"`, `"land"`) in DDL.
- `__` is forbidden in land/collection names (physical-table separator safety).
- The core auto-migrates new fields onto existing tables (`ALTER TABLE …
  ADD COLUMN`, diffed against `PRAGMA table_info`) in `meta/store.ts`.

## Work Log

### 2–0 Extracted from worker-stacks → @hamolus/core

- Copied `src/` (34 TS files), generic `scripts/seed.mjs` + `bootstrap.sql` +
  `dump-seed.mjs` + `apply-seed.mjs`, `drizzle.config.ts` from
  `vibe/worker-stacks/packages/core`. **Excluded** the BrokenLight-private
  payload seeds (`seed-payload.mjs`, `payload-seed-new.mjs`, `payload-data.json`,
  `payload-extract.mjs`) and the site/console/mcp packages.
- Rebranded: `@proj/types` → `@hamolus/types` (47 imports) + the
  `PHYSICAL_TABLE` symbol; `SEED_KIND` `'worker-stacks-seed'` → `'hamolus-seed'`
  (core + `apply-seed.mjs`); demo seed branding → Hamolus; fixed a
  `brokenlight.biz.id` link leak in the seed markdown.
- Added the SPDX Variant B header to all 34 `src/*.ts` + `drizzle.config.ts` +
  `scripts/*.mjs` + `scripts/bootstrap.sql`.
- Standalone `package.json` (`@hamolus/core` 0.0.1, non-private, MIT,
  `@hamolus/types` via `workspace:*`), inline `tsconfig.json`
  (ES2022, Bundler, workers-types), rebranded `wrangler.jsonc` (name
  `hamolus-core`, placeholder D1/KV/R2 ids, no prod secrets), gitignored
  `.dev.vars`, `.env.example`, `pnpm-workspace.yaml` with `allowBuilds`
  (esbuild, workerd).
- Docs: `docs/api.md` + `docs/settings.md` ported (rebranded), new
  `docs/architecture.md`, new `README.md`, this AGENTS.md.
- Verified: `pnpm typecheck` clean, `pnpm build` (wrangler dry-run) green
  (1286 KiB / 219 KiB gzip). Local dev core on **8789** (8788 occupied by the old
  worker-stacks core): health ok, admin-key token mint ok, full demo seed
  (12 / 296 / 66), nested group tree, locale resolution, markdown `case_study`
  as string, media taxonomy, settings brand = Hamolus, CRUD roundtrip
  (create/get/delete), media public serve 200 `image/png`, lands registry ok.

### 2–1 tenant → land, price → currency

- **tenant → land end-to-end**: `src/tenant.ts` → `src/land.ts` (git mv);
  `createTenantRewrite`→`createLandRewrite`, `resolveRequestTenant`→
  `resolveRequestLand`, `TenantContext`→`LandContext`, `TenantAppFetch`→
  `LandAppFetch`, `tenantMode`→`landMode`, `TENANT_REQUIRED`→`LAND_REQUIRED`,
  `TENANT_MISMATCH`→`LAND_MISMATCH`, `applyTenant`→`applyLand`, wire header
  `x-tenant`→`x-land` (`x-colony` retained), `x-tenant-header-resolved`→
  `x-land-header-resolved`, permissions `tenants.read/write`→`lands.read/write`,
  hono `Variables` context `tenant`→`landCtx`. `colony` stays as the per-land
  sub-tenant scope. Error text: "This endpoint requires a land — pass an
  '`x-land`' header...". BSD-sed gotcha: `\b` word boundaries are unsupported on
  macOS sed (ran renames without them).
- **price → currency field type**: `src/db/table.ts` maps `currency` → TEXT
  (JSON), `src/db/coerce.ts` stores `{ amount, code }` (bare number → USD) and
  parses it back, `src/db/queries.ts::serializeRow` emits
  `{ amount, code, display }` via `@hamolus/types` `formatCurrency`
  (`Intl.NumberFormat` per `?locale=`; `CODE amount` fallback on invalid code).
  Seed products now store `price`/`compare_at_price` as `{ amount, code: 'USD' }`.
- Docs synced: README ("multi-land", "sub-tenants", currency), AGENTS.md layout,
  CHANGELOG (land + currency lines), `docs/api.md` (Land header block, field-type
  list, `type: "currency"` definition, seed `x-land` mention), `docs/architecture.md`
  (Multi-tenancy section, data-flow, diagram), package.json description.
- Verified: `pnpm typecheck` green, `pnpm build` green (1286 KiB / 219 KiB gzip);
  core restarted + reseeded on 8789. Live E2E: products `price` reads as
  `{amount:17,code:"USD",display:"$17.00"}` (en) / `US$17,00` (id);
  bare-number write → USD default; object write `{amount:99.5,code:"EUR"}` →
  `€99.50`; lowercase code `usd` rejected `VALIDATION`; `x-land: default` still
  resolves collections; lands registry intact. Committed in both repos
  (`hamolus-types` e20b334, `hamolus-core` d5950fc).