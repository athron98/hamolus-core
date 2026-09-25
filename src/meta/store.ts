/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { and, eq, sql } from 'drizzle-orm'
import type { CollectionDefinition } from '@hamolus/types'
import { LAND_DEFAULT, collectionDefinitionSchema } from '@hamolus/types'
import type { Db } from '../db/client'
import { metaCollections, type MetaCollectionRow } from '../db/schema'
import { addColumnSql, auditColumns, buildCreateTableSql, buildDropTableSql, isIdentifier, physicalTable, quoteIdentifier, stampPhysicalTable } from '../db/table'
import { badRequest, notFound } from '../errors'

let metaReady: Promise<unknown> | null = null
let defaultCollectionNames: Promise<Set<string>> | null = null

/**
 * Cached names of every registered collection. Used by the land path-rewrite
 * to avoid hijacking a collection URL whose name happens to collide with a
 * registered land id (bare interpretation wins). Considers all lands — the
 * rewrite guard is intentionally conservative.
 */
export function ensureDefaultCollectionNames(db: Db): Promise<Set<string>> {
  if (!defaultCollectionNames) {
    defaultCollectionNames = (async () => {
      await ensureMetaTable(db)
      const rows = await db.all<{ name: string }>(sql`SELECT DISTINCT name FROM _meta_collections`)
      return new Set(rows.map((r) => r.name))
    })().catch((err) => {
      defaultCollectionNames = null
      throw err
    })
  }
  return defaultCollectionNames
}

export function invalidateDefaultCollectionNames(): void {
  defaultCollectionNames = null
}

/** Number of columns backing the table's PRIMARY KEY (0 when none). */
async function pkColumnCount(db: Db, table: string): Promise<number> {
  const indexes = await db.all<{ name: string; origin: string }>(
    sql`PRAGMA index_list(${sql.raw(`'${table}'`)})`,
  )
  const pkIdx = indexes.find((i) => i.origin === 'pk')
  if (!pkIdx) return 0
  const info = await db.all<{ seqno: number }>(
    sql`PRAGMA index_info(${sql.raw(`'${pkIdx.name}'`)})`,
  )
  return info.length
}

async function pkIsComposite(db: Db, table: string): Promise<boolean> {
  return (await pkColumnCount(db, table)) > 1
}

/**
 * Auto-bootstrap of the _meta_collections metadata table, including a
 * land-scoped composite PRIMARY KEY (land, name). Idempotent — runs once per
 * isolate. Legacy single-PK databases are migrated in place.
 */
export function ensureMetaTable(db: Db): Promise<unknown> {
  if (!metaReady) {
    metaReady = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _meta_collections (
          land TEXT NOT NULL DEFAULT 'default',
          name TEXT NOT NULL,
          label TEXT NOT NULL,
          description TEXT,
          "group" TEXT,
          icon TEXT,
          timestamps INTEGER NOT NULL DEFAULT 0,
          soft_delete INTEGER NOT NULL DEFAULT 0,
          primary_key TEXT NOT NULL DEFAULT 'id',
          fields TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, name)
        )
      `))
      .then(async () => {
        // Backfill new columns on databases created before they existed.
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info(${sql.raw('_meta_collections')})`,
        )
        const colNames = new Set(cols.map((c) => c.name))
        if (!colNames.has('land')) {
          await db.run(
            sql`ALTER TABLE _meta_collections ADD COLUMN land TEXT NOT NULL DEFAULT 'default'`,
          )
        }
        if (!colNames.has('group')) {
          await db.run(sql`ALTER TABLE _meta_collections ADD COLUMN "group" TEXT`)
        }
        if (!colNames.has('icon')) {
          await db.run(sql`ALTER TABLE _meta_collections ADD COLUMN icon TEXT`)
        }

        // Reconcile legacy tables that were ever created without a PRIMARY KEY:
        // drop duplicate `name` rows (keep the newest) so the composite-PK
        // rebuild below cannot violate uniqueness.
        const dupes = await db.all<{ name: string }>(
          sql`SELECT name FROM _meta_collections GROUP BY name HAVING COUNT(*) > 1`,
        )
        if (dupes.length > 0) {
          await db.run(sql`
            DELETE FROM _meta_collections
            WHERE rowid NOT IN (
              SELECT MAX(rowid) FROM _meta_collections GROUP BY name
            )
          `)
        }

        // Single-column (land-agnostic) PK → rebuild as composite (land, name).
        if (!(await pkIsComposite(db, '_meta_collections'))) {
          await db.run(sql`DROP INDEX IF EXISTS idx_meta_collections_name`)
          await db.run(sql`ALTER TABLE _meta_collections RENAME TO _meta_collections_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _meta_collections (
              land TEXT NOT NULL DEFAULT 'default',
              name TEXT NOT NULL,
              label TEXT NOT NULL,
              description TEXT,
              "group" TEXT,
              icon TEXT,
              timestamps INTEGER NOT NULL DEFAULT 0,
              soft_delete INTEGER NOT NULL DEFAULT 0,
              primary_key TEXT NOT NULL DEFAULT 'id',
              fields TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, name)
            )
          `))
          await db.run(sql.raw(`
            INSERT INTO _meta_collections (land, name, label, description, "group", icon, timestamps, soft_delete, primary_key, fields, created_at, updated_at)
            SELECT land, name, label, description, "group", icon, timestamps, soft_delete, primary_key, fields, created_at, updated_at
            FROM _meta_collections_legacy
          `))
          await db.run(sql`DROP TABLE IF EXISTS _meta_collections_legacy`)
        }
      })
  }
  return metaReady
}

class MetaRegistry {
  private loadedLands = new Set<string>()
  private cache = new Map<string, CollectionDefinition>()
  private order = new Map<string, string[]>()

  invalidate(): void {
    this.loadedLands.clear()
    this.cache.clear()
    this.order.clear()
    invalidateDefaultCollectionNames()
  }

  async getAll(db: Db, land: string = LAND_DEFAULT): Promise<CollectionDefinition[]> {
    await ensureMetaTable(db)
    if (!this.loadedLands.has(land)) {
      const rows = await db
        .select()
        .from(metaCollections)
        .where(eq(metaCollections.land, land))
        .orderBy(metaCollections.createdAt)
      const defs: CollectionDefinition[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        if (seen.has(row.name)) continue
        seen.add(row.name)
        try {
          defs.push(rowToDefinition(row, land))
        } catch (err) {
          console.error('Skipping corrupt meta collection:', row.name, err)
        }
      }
      const order = this.order.get(land) ?? []
      for (const d of defs) {
        this.cache.set(`${land}\u0000${d.name}`, d)
        order.push(d.name)
      }
      this.order.set(land, order)
      this.loadedLands.add(land)
    }
    const order = this.order.get(land) ?? []
    return order.map((n) => this.cache.get(`${land}\u0000${n}`)!).filter(Boolean)
  }

  async get(db: Db, name: string, land: string = LAND_DEFAULT): Promise<CollectionDefinition> {
    await this.getAll(db, land)
    const def = this.cache.get(`${land}\u0000${name}`)
    if (!def) throw notFound(`Collection '${name}' is not registered`)
    return def
  }
}

function rowToDefinition(row: MetaCollectionRow, land: string): CollectionDefinition {
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields
  return stampPhysicalTable(
    {
      name: row.name,
      label: row.label,
      description: row.description ?? undefined,
      group: row.group ?? undefined,
      icon: row.icon ?? undefined,
      timestamps: row.timestamps ?? false,
      softDelete: row.softDelete ?? false,
      primaryKey: row.primaryKey ?? 'id',
      fields,
    },
    land,
  )
}

export const registry = new MetaRegistry()

/** Upsert collection metadata and guarantee the physical table exists (idempotent). */
export async function putCollection(
  db: Db,
  input: Record<string, unknown>,
  land: string = LAND_DEFAULT,
): Promise<CollectionDefinition> {
  await ensureMetaTable(db)

  const parsed = collectionDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    throw badRequest('Invalid collection definition: ' + parsed.error.issues.map((i) => i.message).join('; '), 'INVALID_COLLECTION')
  }
  const def = parsed.data
  if (!isIdentifier(def.name)) throw badRequest('Collection name must be snake_case', 'INVALID_COLLECTION')

  const table = physicalTable(land, def.name)

  // Ensure the physical table exists/stays in sync for new columns (idempotent).
  await db.run(sql.raw(buildCreateTableSql(def, land)))

  // Migrate newly added fields onto an existing table (ALTER TABLE ADD COLUMN).
  const existing = await db.all<{ name: string }>(
    sql`PRAGMA table_info(${sql.raw(quoteIdentifier(table))})`,
  )
  const existingNames = new Set(existing.map((c) => c.name))
  for (const field of def.fields) {
    if (field.type === 'id' && field.name === (def.primaryKey ?? 'id')) continue
    if (field.name === 'land' && land !== LAND_DEFAULT) continue
    if (existingNames.has(field.name)) continue
    await db.run(sql.raw(addColumnSql(def, field, land)))
  }
  // Backfill audit-trace columns (created_by/updated_by/deleted_by) onto tables
  // created before they existed — same PRAGMA-diff pattern as the field loop.
  for (const col of auditColumns(def)) {
    if (existingNames.has(col)) continue
    await db.run(sql`ALTER TABLE ${sql.raw(quoteIdentifier(table))} ADD COLUMN ${sql.raw(quoteIdentifier(col))} TEXT`)
  }

  const now = new Date().toISOString()
  await db
    .insert(metaCollections)
    .values({
      land,
      name: def.name,
      label: def.label,
      description: def.description ?? null,
      group: def.group ?? null,
      icon: def.icon ?? null,
      timestamps: def.timestamps ?? false,
      softDelete: def.softDelete ?? false,
      primaryKey: def.primaryKey ?? 'id',
      fields: JSON.stringify(def.fields),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [metaCollections.land, metaCollections.name],
      set: {
        label: def.label,
        description: def.description ?? null,
        group: def.group ?? null,
        icon: def.icon ?? null,
        timestamps: def.timestamps ?? false,
        softDelete: def.softDelete ?? false,
        primaryKey: def.primaryKey ?? 'id',
        fields: JSON.stringify(def.fields),
        updatedAt: now,
      },
    })

  registry.invalidate()
  return stampPhysicalTable(def, land)
}

/** Remove metadata and drop the physical table. */
export async function deleteCollection(db: Db, name: string, land: string = LAND_DEFAULT): Promise<void> {
  await ensureMetaTable(db)
  if (!isIdentifier(name)) throw badRequest('Invalid collection name')
  await db.run(sql.raw(buildDropTableSql(name, land)))
  await db.delete(metaCollections).where(and(eq(metaCollections.land, land), eq(metaCollections.name, name)))
  registry.invalidate()
}

export async function getCollection(db: Db, name: string, land: string = LAND_DEFAULT): Promise<CollectionDefinition> {
  return registry.get(db, name, land)
}

export async function listCollections(db: Db, land: string = LAND_DEFAULT): Promise<CollectionDefinition[]> {
  return registry.getAll(db, land)
}