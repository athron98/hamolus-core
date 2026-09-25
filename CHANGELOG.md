# Changelog

All notable changes to **@hamolus/core**.

## 0.0.1 — 2026-09-24

Initial public release. Extracted from the internal `worker-stacks` monorepo and
rebranded as the standalone `@hamolus/core` package.

### Added

- Dynamically-defined CRUD API (`/api/{collection}`) with 15+ field types,
  relations (`belongsTo`/`hasMany`/`hasOne`), localization, richtext
  (`lexical`/`markdown`/`mdx`), media and currency fields.
- Auto-migrations: new fields are `ALTER TABLE … ADD COLUMN`-ed live against a
  `PRAGMA table_info` diff.
- R2 media library (WebP uploads, thumbnails, crop variants, focus points,
  taxonomy, public content-negotiated serving + HTML viewer).
- Document / attachment file libraries (`/api/_documents`, `/api/_attachments`).
- Multi-land core (lands/colonies): per-land settings, users, privileges,
  collections, media, files; strict `LAND_REQUIRED` in `centralized` mode.
- Auth: admin-key JWT, username/password login, per-land privileges, super
  admin bootstrap, self-service password change.
- KV settings blob, self-parenting navigation groups, KV-backed plugin storage.
- Full-state seed snapshots: `GET/POST /api/_meta/seed` export/restore plus
  `scripts/dump-seed.mjs` / `scripts/apply-seed.mjs` CLIs.
- Self-cleaning demo seed (`scripts/seed.mjs`): 12 collections, 296 records,
  66 media assets, nested nav groups, deterministic output.

### Changed

- Rebranded from `@proj/core` → `@hamolus/core` (0.0.1, MIT, non-private).
- `@proj/types` → `@hamolus/types`; seed snapshot `kind` is now `hamolus-seed`.
- Standalone config: inline `tsconfig.json`, zeroed-out D1/KV/R2 ids in
  `wrangler.jsonc` (local dev auto-provisions), gitignored `.dev.vars`.
- Excluded all BrokenLight-specific payload seeds and data from the published
  package.