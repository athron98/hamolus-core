# @hamolus/core

> The Hamolus core — a Cloudflare Worker API engine. Hono + Drizzle ORM over
> D1/SQLite + Cloudflare KV + R2. Serves a **dynamically-defined CRUD API**:
> collections are not hard coded; their schema is stored as metadata in D1 and
> the physical tables are created (and migrated) automatically from a definition.

Metadata is the schema: `PUT /api/_meta/collections/{name}` with a JSON
definition creates the D1 table, and CRUD is served at `/api/{collection}`.

Multi-land out of the box: one core can serve many **lands** (sub-tenants), each
with its own settings, users, privileges, collections, media, and document
libraries (`CORE_MODE=centralized`).

## Features

- Dynamic CRUD — 15+ field types, relations (`belongsTo`/`hasMany`/`hasOne`),
  localization, richtext (`lexical`/`markdown`/`mdx`), media + currency fields.
- Auto-migrations — new fields are `ALTER TABLE … ADD COLUMN`-ed live.
- Media library — R2-backed uploads (WebP, thumbnails, crop variants, focus
  points, taxonomy), public `/media/{key}` serving with an HTML viewer.
- Document / attachment file libraries (`/api/_documents`, `/api/_attachments`).
- Multi-land (lands/colonies) with per-land everything + strict mode.
- Auth — admin-key JWT, username/password, per-land privileges, super admins,
  self-service password change.
- KV settings blob, navigation groups (`_meta_groups`), plugin KV storage.
- **Seed export/restore** — dump a full land state to JSON and restore it
  (`/api/_meta/seed`, plus the `scripts/dump-seed.mjs` / `apply-seed.mjs` CLIs).

## Commands

```bash
pnpm install
pnpm typecheck          # tsc --noEmit
pnpm build              # wrangler deploy --dry-run --outdir=dist
pnpm dev                # wrangler dev --port 8789 --ip 0.0.0.0
```

Local dev reads `.dev.vars` (gitignored) for `ADMIN_KEY`/`JWT_SECRET`. The
D1/KV/R2 ids in `wrangler.jsonc` are placeholders — local `wrangler dev`
auto-provisions them; replace them for production.

### Seed demo data

```bash
BASE=http://localhost:8789 ADMIN_KEY=dev-admin-key-change-me node scripts/seed.mjs
```

Self-cleaning: drops every collection + media asset and rebuilds 12 collections,
296 records, 66 media, nested nav groups, deterministic output. The payload
(BrokenLight) seeds are intentionally **not** part of this package.

### Seed snapshot export/restore

```bash
BASE=http://localhost:8789 ADMIN_KEY=dev-admin-key-change-me node scripts/dump-seed.mjs all bytes
BASE=http://localhost:8789 ADMIN_KEY=dev-admin-key-change-me node scripts/apply-seed.mjs seed-out.json true
```

## Documentation

- [`docs/api.md`](docs/api.md) — full API reference (auth, meta, dynamic CRUD,
  media/files, plugins, seed, errors, env vars).
- [`docs/settings.md`](docs/settings.md) — KV settings blob shape.
- [`docs/architecture.md`](docs/architecture.md) — how the core is built and how
  requests flow through it.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Hamolus Labs / Gilang Albathin
Nurhabibi.