/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { sql, type SQL } from 'drizzle-orm'
import type { CollectionDefinition, FieldDefinition, FilterMap } from '@hamolus/types'
import type { Db } from './client'
import { auditColumns, dataFields, isIdentifier, physicalTableName, pkField, quoteIdentifier } from './table'
import { fromDbValue, toDbValue } from './coerce'
import { formatCurrency } from '@hamolus/types'
import { badRequest, notFound } from '../errors'

export interface ListOptions {
  page: number
  pageSize: number
  sortBy?: string
  sortDesc?: boolean
  filter?: FilterMap
  locale?: string
  search?: string
}

function assertKnownColumn(def: CollectionDefinition, name: string, ctx: string): void {
  if (!isIdentifier(name)) throw badRequest(`Column '${name}' is invalid`)
  const known = def.fields.some((f) => f.name === name) || name === 'id'
  if (!known) throw badRequest(`Unknown column '${name}' in '${def.name}'`, 'UNKNOWN_FIELD')
}

function buildWhere(def: CollectionDefinition, filter?: FilterMap, search?: string): SQL {
  const clauses: SQL[] = [sql`1=1`]
  if (def.softDelete) clauses.push(sql`deleted_at IS NULL`)
  if (filter) {
    for (const [key, clause] of Object.entries(filter)) {
      assertKnownColumn(def, key, 'filter')
      const field = def.fields.find((f) => f.name === key)
      const col = sql.raw(quoteIdentifier(key))
      const value = toDbValue(field ?? { name: key, type: 'string' }, clause.value)
      switch (clause.op) {
        case 'eq':
          clauses.push(sql`${col} = ${value}`)
          break
        case 'neq':
          clauses.push(sql`${col} != ${value}`)
          break
        case 'gt':
          clauses.push(sql`${col} > ${value}`)
          break
        case 'gte':
          clauses.push(sql`${col} >= ${value}`)
          break
        case 'lt':
          clauses.push(sql`${col} < ${value}`)
          break
        case 'lte':
          clauses.push(sql`${col} <= ${value}`)
          break
        case 'like':
          clauses.push(sql`${col} LIKE ${`%${String(value)}%`}`)
          break
        case 'contains':
          clauses.push(sql`${col} LIKE ${`%${String(value)}%`}`)
          break
        case 'in': {
          const values = Array.isArray(clause.value) ? clause.value : [clause.value]
          clauses.push(sql`${col} IN (${sql.join(values.map((v) => sql`${toDbValue(field ?? { name: key, type: 'string' }, v)}`), sql`, `)})`)
          break
        }
        default:
          throw badRequest(`Filter operator '${clause.op}' is not supported`)
      }
    }
  }
  if (search) {
    const stringFields = def.fields.filter(
      (f) => ['string', 'text', 'email', 'url', 'slug', 'richtext'].includes(f.type) && !f.hidden,
    )
    if (stringFields.length > 0) {
      const likeClauses = stringFields.map((f) => {
        const col = sql.raw(quoteIdentifier(f.name))
        return sql`${col} LIKE ${`%${search}%`}`
      })
      clauses.push(sql`(${sql.join(likeClauses, sql` OR `)})`)
    }
  }
  return clauses.length === 1 ? clauses[0]! : sql`(${sql.join(clauses, sql` AND `)})`
}

/** Serialize a D1 row into public JSON (hidden fields dropped, values coerced). */
export function serializeRow(
  def: CollectionDefinition,
  row: Record<string, unknown>,
  locale?: string,
): Record<string, unknown> {
  const hidden = new Set(def.fields.filter((f) => f.hidden).map((f) => f.name))
  const out: Record<string, unknown> = {}
  for (const field of def.fields) {
    if (field.hidden) continue
    if (!(field.name in row)) continue
    let val = fromDbValue(field, row[field.name])
    if (field.localized && typeof val === 'string' && val.trimStart().startsWith('{')) {
      try {
        val = JSON.parse(val) as unknown
      } catch {
        /* not json — keep the string as-is */
      }
    }
    if (locale && field.localized && val != null) {
      let obj: Record<string, unknown> | null = null
      if (typeof val === 'object') {
        obj = val as Record<string, unknown>
      } else if (typeof val === 'string') {
        try { obj = JSON.parse(val) as Record<string, unknown> } catch { /* not json */ }
      }
      if (obj && typeof obj === 'object') {
        val = obj[locale] ?? obj[Object.keys(obj)[0]] ?? null
      }
    }
    if (field.type === 'currency') {
      if (val && typeof val === 'object') {
        const m = val as { amount?: unknown; code?: unknown }
        const amount = typeof m.amount === 'number' ? m.amount : Number(m.amount ?? 0)
        const code = typeof m.code === 'string' ? m.code : 'USD'
        out[field.name] = { amount, code, display: formatCurrency(amount, code, locale) }
      } else if (typeof val === 'number') {
        out[field.name] = { amount: val, code: 'USD', display: formatCurrency(val, 'USD', locale) }
      } else {
        out[field.name] = val
      }
      continue
    }
    out[field.name] = val
  }
  const pk = pkField(def)
  if (!(pk.name in out) && pk.name in row) out[pk.name] = row[pk.name]
  for (const key of Object.keys(row)) {
    if (hidden.has(key) || out[key] !== undefined || key === 'deleted_at') continue
    out[key] = row[key]
  }
  return out
}

export async function listRecords(
  db: Db,
  def: CollectionDefinition,
  opts: ListOptions,
): Promise<{ rows: Record<string, unknown>[]; total: number; lastUpdate: string | null }> {
  const table = sql.raw(quoteIdentifier(physicalTableName(def)))
  const where = buildWhere(def, opts.filter, opts.search)

  const countRow = await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${table} WHERE ${where}`)
  const total = Number(countRow?.total ?? 0)

  // Compute lastUpdate: max updated_at or created_at across all rows in the table
  const hasTimestamps = def.fields.some((f) => f.name === 'updated_at' || f.name === 'created_at')
  let lastUpdate: string | null = null
  if (hasTimestamps) {
    const luRow = await db.get<{ lu: string }>(
      sql`SELECT MAX(COALESCE(updated_at, created_at)) AS lu FROM ${table}`,
    )
    lastUpdate = luRow?.lu ?? null
  }

  if (total === 0) return { rows: [], total, lastUpdate }

  let order: SQL = sql`ORDER BY rowid DESC`
  if (opts.sortBy) {
    assertKnownColumn(def, opts.sortBy, 'sort')
    const dir = opts.sortDesc ? sql`DESC` : sql`ASC`
    order = sql`ORDER BY ${sql.raw(quoteIdentifier(opts.sortBy))} ${dir}`
  }
  const offset = (opts.page - 1) * opts.pageSize
  const rows = await db.all<Record<string, unknown>>(
    sql`SELECT * FROM ${table} WHERE ${where} ${order} LIMIT ${opts.pageSize} OFFSET ${offset}`,
  )
  return { rows: rows.map((r) => serializeRow(def, r, opts.locale)), total, lastUpdate }
}

export async function getRecord(
  db: Db,
  def: CollectionDefinition,
  id: string,
  locale?: string,
): Promise<Record<string, unknown>> {
  const pk = pkField(def)
  const table = sql.raw(quoteIdentifier(physicalTableName(def)))
  const where = buildWhere(def)
  const rows = await db.all<Record<string, unknown>>(
    sql`SELECT * FROM ${table} WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} = ${id} LIMIT 1`,
  )
  const row = rows[0]
  if (!row) throw notFound(`Record '${id}' not found in '${def.label}'`)
  return serializeRow(def, row, locale)
}

export async function createRecord(
  db: Db,
  def: CollectionDefinition,
  input: Record<string, unknown>,
  actor: string = 'system',
): Promise<Record<string, unknown>> {
  const pk = pkField(def)
  const values: Record<string, unknown> = { ...input }
  if (!values[pk.name] || values[pk.name] === '') {
    values[pk.name] = crypto.randomUUID()
  }

  const columns: string[] = []
  const params: SQL[] = []
  if (def.timestamps && auditColumns(def).includes('created_by')) {
    columns.push(quoteIdentifier('created_by'), quoteIdentifier('updated_by'))
    params.push(sql`${actor}`, sql`${actor}`)
  }
  for (const col of [...dataFields(def), pk]) {
    const key = col.name
    if (!(key in values)) continue
    if (col.type === 'id' && key === pk.name && values[key] == null) continue
    columns.push(quoteIdentifier(key))
    params.push(sql`${toDbValue(col, values[key])}`)
  }

  const table = sql.raw(quoteIdentifier(physicalTableName(def)))
  await db.run(
    sql`INSERT INTO ${table} (${sql.raw(columns.join(', '))}) VALUES (${sql.join(params, sql`, `)})`,
  )
  return getRecord(db, def, String(values[pk.name]))
}

export async function updateRecord(
  db: Db,
  def: CollectionDefinition,
  id: string,
  input: Record<string, unknown>,
  actor: string = 'system',
): Promise<Record<string, unknown>> {
  const pk = pkField(def)
  const sets: SQL[] = []
  for (const field of dataFields(def)) {
    if (!(field.name in input)) continue
    sets.push(sql`${sql.raw(quoteIdentifier(field.name))} = ${toDbValue(field, input[field.name])}`)
  }
  if (def.timestamps) {
    sets.push(sql`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    if (auditColumns(def).includes('updated_by')) {
      sets.push(sql`${sql.raw(quoteIdentifier('updated_by'))} = ${actor}`)
    }
  }
  if (sets.length === 0) throw badRequest('No fields to update')

  const table = sql.raw(quoteIdentifier(physicalTableName(def)))
  const where = buildWhere(def)
  const res = await db.run(
    sql`UPDATE ${table} SET ${sql.join(sets, sql`, `)} WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound(`Record '${id}' not found in '${def.label}'`)
  return getRecord(db, def, id)
}

export async function deleteRecord(
  db: Db,
  def: CollectionDefinition,
  id: string,
  actor: string = 'system',
): Promise<void> {
  const pk = pkField(def)
  const table = sql.raw(quoteIdentifier(physicalTableName(def)))
  const where = buildWhere(def)

  if (def.softDelete) {
    const soft = auditColumns(def).includes('deleted_by')
    const res = await db.run(
      soft
        ? sql`UPDATE ${table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${sql.raw(quoteIdentifier('deleted_by'))} = ${actor} WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} = ${id}`
        : sql`UPDATE ${table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} = ${id}`,
    )
    if (res.meta.changes === 0) throw notFound(`Record '${id}' not found in '${def.label}'`)
    return
  }

  const res = await db.run(
    sql`DELETE FROM ${table} WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound(`Record '${id}' not found in '${def.label}'`)
}

/** Remove many records in one statement (soft-delete collections get tombstoned). */
export async function bulkDeleteRecords(
  db: Db,
  def: CollectionDefinition,
  ids: string[],
  actor: string = 'system',
): Promise<number> {
  const pk = pkField(def)
  const table = sql.raw(quoteIdentifier(physicalTableName(def)))
  const where = buildWhere(def)
  const placeholders = sql.join(ids.map((id) => sql`${id}`), sql`, `)

  if (def.softDelete) {
    if (auditColumns(def).includes('deleted_by')) {
      const res = await db.run(
        sql`UPDATE ${table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${sql.raw(quoteIdentifier('deleted_by'))} = ${actor} WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} IN (${placeholders})`,
      )
      return res.meta.changes
    }
    const res = await db.run(
      sql`UPDATE ${table} SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} IN (${placeholders})`,
    )
    return res.meta.changes
  }

  const res = await db.run(
    sql`DELETE FROM ${table} WHERE ${where} AND ${sql.raw(quoteIdentifier(pk.name))} IN (${placeholders})`,
  )
  return res.meta.changes
}