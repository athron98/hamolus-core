/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { sql, type SQL } from 'drizzle-orm'
import type { ConfigEntry, ConfigScope } from '@hamolus/types'
import { LAND_DEFAULT } from '@hamolus/types'
import type { Db } from '../db/client'
import { badRequest, notFound } from '../errors'

// Matches configEntrySchema's key pattern (bind parameter, never a SQL identifier).
const KEY_PATTERN = /^[a-z][a-z0-9._-]*$/

/** Internal key/value table backing the configurations feature (never a dynamic collection). */
const TABLE = '_configs'

interface ConfigRow {
  key: string
  value: string
  scope: string
  description: string | null
  updated_at: string
}

let configReady: Promise<unknown> | null = null

async function pkIsComposite(db: Db, table: string): Promise<boolean> {
  const indexes = await db.all<{ name: string; origin: string }>(
    sql`PRAGMA index_list(${sql.raw(`'${table}'`)})`,
  )
  const pkIdx = indexes.find((i) => i.origin === 'pk')
  if (!pkIdx) return false
  const info = await db.all<{ seqno: number }>(
    sql`PRAGMA index_info(${sql.raw(`'${pkIdx.name}'`)})`,
  )
  return info.length > 1
}

export function ensureConfigTable(db: Db): Promise<unknown> {
  if (!configReady) {
    configReady = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _configs (
          land TEXT NOT NULL DEFAULT 'default',
          key TEXT NOT NULL COLLATE NOCASE,
          value TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'core',
          description TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, key)
        )
      `))
      .then(async () => {
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info('_configs')`,
        )
        if (!cols.some((c) => c.name === 'land')) {
          await db.run(sql`ALTER TABLE _configs ADD COLUMN land TEXT NOT NULL DEFAULT 'default'`)
        }
        if (!(await pkIsComposite(db, '_configs'))) {
          await db.run(sql`ALTER TABLE _configs RENAME TO _configs_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _configs (
              land TEXT NOT NULL DEFAULT 'default',
              key TEXT NOT NULL COLLATE NOCASE,
              value TEXT NOT NULL,
              scope TEXT NOT NULL DEFAULT 'core',
              description TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, key)
            )
          `))
          await db.run(sql.raw(`
            INSERT INTO _configs (land, key, value, scope, description, updated_at)
            SELECT 'default', key, value, scope, description, updated_at FROM _configs_legacy
          `))
          await db.run(sql`DROP TABLE IF EXISTS _configs_legacy`)
        }
      })
  }
  return configReady
}

function rowToEntry(row: ConfigRow): ConfigEntry {
  let value: unknown = row.value
  try {
    value = JSON.parse(row.value) as unknown
  } catch {
    value = row.value
  }
  return {
    key: row.key,
    value,
    scope: (row.scope as ConfigScope) || 'core',
    description: row.description,
    updatedAt: row.updated_at,
  }
}

export async function listConfigs(db: Db, scope?: string, land: string = LAND_DEFAULT): Promise<ConfigEntry[]> {
  await ensureConfigTable(db)
  const where: SQL[] = [sql`land = ${land}`]
  if (scope) where.push(sql`scope = ${scope}`)
  const cond = sql`WHERE ${sql.join(where, sql` AND `)}`
  const rows = await db.all<ConfigRow>(sql`SELECT * FROM ${sql.raw(TABLE)} ${cond} ORDER BY scope ASC, key ASC`)
  return rows.map(rowToEntry)
}

export async function getConfig(db: Db, key: string, land: string = LAND_DEFAULT): Promise<ConfigEntry> {
  await ensureConfigTable(db)
  const rows = await db.all<ConfigRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} WHERE land = ${land} AND key = ${key} LIMIT 1`,
  )
  if (rows.length === 0) throw notFound(`Config '${key}' not found`)
  return rowToEntry(rows[0]!)
}

export interface PutConfigInput {
  key: string
  value: unknown
  scope: ConfigScope
  description?: string | null
}

export async function putConfig(db: Db, input: PutConfigInput, land: string = LAND_DEFAULT): Promise<ConfigEntry> {
  await ensureConfigTable(db)
  if (!KEY_PATTERN.test(input.key)) throw badRequest('Invalid config key')
  const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value)
  await db.run(
    sql`INSERT INTO ${sql.raw(TABLE)} (land, key, value, scope, description, updated_at) VALUES (${land}, ${input.key}, ${value}, ${input.scope}, ${input.description ?? null}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(land, key) DO UPDATE SET value = excluded.value, scope = excluded.scope, description = excluded.description, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
  return getConfig(db, input.key, land)
}

export async function deleteConfig(db: Db, key: string, land: string = LAND_DEFAULT): Promise<void> {
  await ensureConfigTable(db)
  const res = await db.run(sql`DELETE FROM ${sql.raw(TABLE)} WHERE land = ${land} AND key = ${key}`)
  if (res.meta.changes === 0) throw notFound(`Config '${key}' not found`)
}