/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { sql } from 'drizzle-orm'
import type { ColonyDefinitionInput, ColonyDto, LandDefinitionInput, LandDto } from '@hamolus/types'
import { colonyDefinitionSchema, landDefinitionSchema } from '@hamolus/types'
import type { Db } from '../db/client'
import { badRequest, notFound, forbidden } from '../errors'

/**
 * The land registry: which lands (and their colonies) the core is allowed to
 * serve. `_meta_lands` / `_meta_colonies` are GLOBAL tables (they are not
 * land-scoped themselves) — every colony references its land by `land_id`.
 *
 * The `default` land always exists; the single-land build (independent mode)
 * lives entirely under it.
 */

interface LandRow {
  id: string
  label: string
  description: string | null
  created_at: string
  updated_at: string
}

interface ColonyRow {
  id: string
  land_id: string
  label: string
  description: string | null
  created_at: string
  updated_at: string
}

let tablesReady: Promise<unknown> | null = null
let registered: Promise<{ lands: Set<string>; colonies: Map<string, Set<string>> }> | null = null

function landRowToDto(row: LandRow): LandDto {
  return {
    id: row.id,
    label: row.label,
    description: row.description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function colonyRowToDto(row: ColonyRow): ColonyDto {
  return {
    id: row.id,
    landId: row.land_id,
    label: row.label,
    description: row.description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Auto-bootstrap `_meta_lands` + `_meta_colonies` (idempotent per isolate). */
export function ensureLandsTable(db: Db): Promise<unknown> {
  if (!tablesReady) {
    tablesReady = db
      .run(sql`
      CREATE TABLE IF NOT EXISTS _meta_lands (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `)
      .then(() =>
        db.run(sql`
        CREATE TABLE IF NOT EXISTS _meta_colonies (
          id TEXT PRIMARY KEY,
          land_id TEXT NOT NULL,
          label TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      )
  }
  return tablesReady
}

/** Invalidate the cached registry after any land/colony write. */
export function invalidateLandsRegistry(): void {
  registered = null
}

/** Ensure the `default` land row exists (used by the land rewrite + setup). */
export async function ensureDefaultLandRow(db: Db): Promise<void> {
  await ensureLandsTable(db)
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM _meta_lands WHERE id = ${'default'} LIMIT 1`)
  if (rows.length === 0) {
    await db.run(
      sql`INSERT INTO _meta_lands (id, label) VALUES (${'default'}, ${'Default land'})`,
    )
    invalidateLandsRegistry()
  }
}

/**
 * Cached snapshot of registered land ids + per-land colony id sets. Used by the
 * land path-rewrite to decide whether a path segment is a land prefix.
 */
export function ensureLandsRegistry(
  db: Db,
): Promise<{ lands: Set<string>; colonies: Map<string, Set<string>> }> {
  if (!registered) {
    registered = (async () => {
      await ensureDefaultLandRow(db)
      const landRows = await db.all<{ id: string }>(sql`SELECT id FROM _meta_lands`)
      const lands = new Set(landRows.map((r) => r.id))
      const colonyRows = await db.all<{ land_id: string; id: string }>(
        sql`SELECT land_id, id FROM _meta_colonies`,
      )
      const colonies = new Map<string, Set<string>>()
      for (const row of colonyRows) {
        const set = colonies.get(row.land_id) ?? new Set<string>()
        set.add(row.id)
        colonies.set(row.land_id, set)
      }
      return { lands, colonies }
    })().catch((err) => {
      registered = null
      throw err
    })
  }
  return registered
}

export async function listLands(db: Db): Promise<LandDto[]> {
  await ensureLandsTable(db)
  const rows = await db.all<LandRow>(sql`SELECT * FROM _meta_lands ORDER BY created_at`)
  return rows.map(landRowToDto)
}

export async function getLand(db: Db, id: string): Promise<LandDto> {
  await ensureLandsTable(db)
  const rows = await db.all<LandRow>(sql`SELECT * FROM _meta_lands WHERE id = ${id} LIMIT 1`)
  const row = rows[0]
  if (!row) throw notFound(`Land '${id}' is not registered`)
  return landRowToDto(row)
}

/** Upsert a land definition (creates it if the id is new). */
export async function putLand(db: Db, input: LandDefinitionInput): Promise<LandDto> {
  await ensureLandsTable(db)
  const now = new Date().toISOString()
  await db.run(
    sql`INSERT INTO _meta_lands (id, label, description, created_at, updated_at)
        VALUES (${input.id}, ${input.label}, ${input.description ?? null}, ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          label = ${input.label},
          description = ${input.description ?? null},
          updated_at = ${now}`,
  )
  invalidateLandsRegistry()
  return getLand(db, input.id)
}

/** Delete a land. The `default` land and land with colonies are protected. */
export async function deleteLand(db: Db, id: string): Promise<void> {
  await ensureLandsTable(db)
  if (id === 'default') {
    throw forbidden("The default land cannot be deleted", 'DEFAULT_LAND_RESERVED')
  }
  const res = await db.all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM _meta_colonies WHERE land_id = ${id}`,
  )
  if (res[0]?.n > 0) {
    throw badRequest(`Land '${id}' still has colonies; remove them first`, 'LAND_IN_USE')
  }
  await db.run(sql`DELETE FROM _meta_lands WHERE id = ${id}`)
  // Auth users live in the global `_auth_users` table (land column) — cascade
  // them so deleting a land never leaves orphan accounts behind.
  const users = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_auth_users'`,
  )
  if (users.length > 0) {
    await db.run(sql`DELETE FROM _auth_users WHERE land = ${id}`)
  }
  invalidateLandsRegistry()
}

export async function listColonies(db: Db, landId?: string): Promise<ColonyDto[]> {
  await ensureLandsTable(db)
  const rows = landId
    ? await db.all<ColonyRow>(
        sql`SELECT * FROM _meta_colonies WHERE land_id = ${landId} ORDER BY created_at`,
      )
    : await db.all<ColonyRow>(sql`SELECT * FROM _meta_colonies ORDER BY created_at`)
  return rows.map(colonyRowToDto)
}

export async function getColony(db: Db, id: string, landId?: string): Promise<ColonyDto> {
  await ensureLandsTable(db)
  const rows = landId
    ? await db.all<ColonyRow>(
        sql`SELECT * FROM _meta_colonies WHERE id = ${id} AND land_id = ${landId} LIMIT 1`,
      )
    : await db.all<ColonyRow>(sql`SELECT * FROM _meta_colonies WHERE id = ${id} LIMIT 1`)
  const row = rows[0]
  if (!row) throw notFound(`Colony '${id}' is not registered`)
  return colonyRowToDto(row)
}

/** Upsert a colony under an existing land. */
export async function putColony(
  db: Db,
  landId: string,
  input: ColonyDefinitionInput,
): Promise<ColonyDto> {
  await ensureLandsTable(db)
  await getLand(db, landId)
  const now = new Date().toISOString()
  await db.run(
    sql`INSERT INTO _meta_colonies (id, land_id, label, description, created_at, updated_at)
        VALUES (${input.id}, ${landId}, ${input.label}, ${input.description ?? null}, ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          land_id = ${landId},
          label = ${input.label},
          description = ${input.description ?? null},
          updated_at = ${now}`,
  )
  invalidateLandsRegistry()
  return getColony(db, input.id, landId)
}

/** Delete a colony row (optionally scoped to a land). */
export async function deleteColony(db: Db, id: string, landId?: string): Promise<void> {
  await ensureLandsTable(db)
  const res = landId
    ? await db.run(sql`DELETE FROM _meta_colonies WHERE id = ${id} AND land_id = ${landId}`)
    : await db.run(sql`DELETE FROM _meta_colonies WHERE id = ${id}`)
  if (res.meta.changes === 0) throw notFound(`Colony '${id}' is not registered`)
  invalidateLandsRegistry()
}

// Re-export validation schemas so the routes can parse bodies consistently.
export { colonyDefinitionSchema, landDefinitionSchema }