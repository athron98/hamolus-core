/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import type { CollectionDefinition, FieldDefinition, FieldType } from '@hamolus/types'
import { LAND_DEFAULT } from '@hamolus/types'

const IDENTIFIER = /^[a-z][a-z0-9_]*$/

export function isIdentifier(value: string): boolean {
  return IDENTIFIER.test(value)
}

export function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"'
}

/**
* Physical D1 table name for a collection under a land. The default land keeps
  * the bare `{name}` tables (backwards compatible); any other land gets a
  * `{land}__{name}` table so lands can never collide.
  */
export function physicalTable(land: string, name: string): string {
  if (land === LAND_DEFAULT || land === '') return name
  if (!isIdentifier(land)) throw new Error(`Invalid land id for physical table: ${land}`)
  return `${land}__${name}`
}

/**
 * Non-enumerable stamp carrying the resolved physical table name on a
 * `CollectionDefinition`. The registry computes it once per land; `db/queries`
 * reads it so no caller has to thread a land argument through.
 */
export const PHYSICAL_TABLE = Symbol.for('@hamolus/core/physicalTable')
export type StampedCollection = CollectionDefinition & { [PHYSICAL_TABLE]: string }
export function stampPhysicalTable(def: CollectionDefinition, land: string): StampedCollection {
  const stamped = def as StampedCollection
  if (stamped[PHYSICAL_TABLE] === undefined) {
    Object.defineProperty(stamped, PHYSICAL_TABLE, {
      value: physicalTable(land, def.name),
      enumerable: false,
      configurable: true,
    })
  }
  return stamped
}
export function physicalTableName(def: CollectionDefinition): string {
  const stamped = def as Partial<StampedCollection>
  const table = stamped[PHYSICAL_TABLE]
  return table ?? def.name
}

const SQLITE_COLUMN: Record<FieldType, string> = {
  id: 'TEXT',
  string: 'TEXT',
  slug: 'TEXT',
  text: 'TEXT',
  richtext: 'TEXT',
  email: 'TEXT',
  url: 'TEXT',
  date: 'TEXT',
  datetime: 'TEXT',
  enum: 'TEXT',
  relation: 'TEXT',
  media: 'TEXT',
  document: 'TEXT',
  attachment: 'TEXT',
  json: 'TEXT',
  number: 'NUMERIC',
  currency: 'TEXT',
  boolean: 'INTEGER',
}

export function columnType(field: FieldDefinition): string {
  return SQLITE_COLUMN[field.type]
}

function renderDefault(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

function fieldTimestamps(): string[] {
  return [
    `created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    `updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ]
}

/** Define all non-id columns usable in INSERT/UPDATE. */
export function dataFields(def: CollectionDefinition): FieldDefinition[] {
  return def.fields.filter((f) => f.type !== 'id')
}

/** Kolom id / primary key. */
export function pkField(def: CollectionDefinition): FieldDefinition {
  const pk = def.primaryKey ?? 'id'
  return def.fields.find((f) => f.name === pk) ?? { name: pk, type: 'id' }
}

/** Audit-trace columns names (created_by / updated_by / deleted_by). */
export function auditColumns(def: CollectionDefinition): string[] {
  const names = new Set(def.fields.map((f) => f.name))
  const cols: string[] = []
  if (def.timestamps && !names.has('created_by') && !names.has('updated_by')) {
    cols.push('created_by', 'updated_by')
  }
  if (def.softDelete && !names.has('deleted_by')) {
    cols.push('deleted_by')
  }
  return cols
}

/** Ensure the physical table for a collection exists (idempotent). */
export function buildCreateTableSql(def: CollectionDefinition, land: string = LAND_DEFAULT): string {
  const pk = pkField(def)
  const columns: string[] = []

  if (land !== LAND_DEFAULT) {
    columns.push(`${quoteIdentifier('land')} TEXT NOT NULL DEFAULT ${renderDefault(land)}`)
  }

  if (!def.fields.some((f) => f.name === pk.name)) {
    const pkParts = [`${quoteIdentifier(pk.name)} TEXT`]
    if (land === LAND_DEFAULT) pkParts.push('PRIMARY KEY')
    columns.push(pkParts.join(' '))
  }

  for (const field of def.fields) {
    const parts = [quoteIdentifier(field.name), columnType(field)]
    if (field.name === pk.name && land === LAND_DEFAULT) parts.push('PRIMARY KEY')
    if (field.required) parts.push('NOT NULL')
    if (field.unique) parts.push('UNIQUE')
    if (field.default !== undefined && field.type !== 'id') {
      parts.push(`DEFAULT ${renderDefault(field.default)}`)
    }
    columns.push(parts.join(' '))
  }

  if (def.timestamps) columns.push(...fieldTimestamps())
  if (def.softDelete) columns.push(`deleted_at TEXT`)

  // Audit trail — who created/updated/deleted each row. The actor username is
  // written by the queries layer from the JWT (fallback 'system'); a user field
  // named exactly like an audit column keeps its own column (no collision).
  for (const col of auditColumns(def)) columns.push(`${quoteIdentifier(col)} TEXT`)

  if (land !== LAND_DEFAULT) {
    columns.push(`PRIMARY KEY (${quoteIdentifier('land')}, ${quoteIdentifier(pk.name)})`)
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(physicalTable(land, def.name))} (${columns.join(', ')})`
}

export function buildDropTableSql(name: string, land: string = LAND_DEFAULT): string {
  return `DROP TABLE IF EXISTS ${quoteIdentifier(physicalTable(land, name))}`
}

/** Render a single column definition (without PRIMARY KEY), usable for ALTER TABLE ADD COLUMN. */
export function addColumnSql(def: CollectionDefinition, field: FieldDefinition, land: string = LAND_DEFAULT): string {
  const parts = [quoteIdentifier(field.name), columnType(field)]
  if (field.required) parts.push('NOT NULL')
  if (field.default !== undefined && field.type !== 'id') {
    parts.push(`DEFAULT ${renderDefault(field.default)}`)
  }
  return `ALTER TABLE ${quoteIdentifier(physicalTable(land, def.name))} ADD COLUMN ${parts.join(' ')}`
}