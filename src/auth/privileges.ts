/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import type { Permission } from '@hamolus/types'
import { LAND_DEFAULT, PRIVILEGE_SEEDS as SEEDS } from '@hamolus/types'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { putCollection, getCollection } from '../meta/store'
import { createRecord, listRecords } from '../db/queries'
import { physicalTable, quoteIdentifier } from '../db/table'

/**
 * The `privileges` collection is a first-class, bootstrapped dynamic collection:
 * its definition is owned by the platform (the definition endpoint refuses to
 * change it) but its records can be edited through the normal record API by
 * anyone holding `users.write`. The four default system roles are seeded on the
 * first boot so user provisioning never has an empty role set.
 */
export const PRIVILEGES_DEF: Record<string, unknown> = {
  name: 'privileges',
  label: 'Privileges',
  description: 'Role definitions that grant console/API capabilities to users.',
  group: 'System',
  icon: 'star',
  timestamps: true,
  fields: [
    { name: 'id', label: 'ID', type: 'id', required: true },
    { name: 'name', label: 'Name', type: 'slug', required: true, unique: true, indexed: true },
    { name: 'label', label: 'Label', type: 'string', required: true },
    { name: 'description', label: 'Description', type: 'text' },
    { name: 'permissions', label: 'Permissions', type: 'json', default: [] },
    { name: 'is_system', label: 'System role', type: 'boolean', default: false },
  ],
}

export const PROTECTED_COLLECTION = 'privileges'

export interface PrivilegeRecord {
  id: string
  name: string
  label: string
  description: string | null
  permissions: Permission[]
  is_system: boolean
}

let privReady = new Map<string, Promise<unknown>>()

/**
 * Deterministic UUID (UUIDv5-ish) for a seed privilege so re-bootstraps never
 * change role ids — existing `_auth_users.privilege_id` references stay valid
 * even if the privileges collection is deleted and recreated by a reseed.
 */
function stableUuid(name: string): string {
  // FNV-1a over the name bytes, expanded to a full 128-bit UUID.
  const bytes = Array.from(new TextEncoder().encode(`privilege:${name}`))
  let a = 0x811c9dc5 ^ 0x1f6304d2
  let b = 0x811c9dc5
  let c = 0xc9dc5115
  let d = 0x81f5e24b
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 16777619) >>> 0
    b = Math.imul(b ^ byte, 16777619) >>> 0
    c = Math.imul(c ^ byte, 16777619) >>> 0
    d = Math.imul(d ^ byte, 16777619) >>> 0
  }
  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setUint32(0, a, true)
  view.setUint32(4, b, true)
  view.setUint32(8, c, true)
  view.setUint32(12, d ^ 0x0a45, true)
  out[6] = (out[6]! & 0x0f) | 0x40
  out[8] = (out[8]! & 0x3f) | 0x80
  const hex = Array.from(out, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function privilegeIdFor(name: string): string {
  return stableUuid(name)
}

/** Bootstrap the privileges collection and seed the default roles once per land. */
export function ensurePrivileges(db: Db, land: string = LAND_DEFAULT): Promise<unknown> {
  if (!privReady.has(land)) {
    privReady.set(
      land,
      (async () => {
        await putCollection(db, PRIVILEGES_DEF, land)
        const def = await getCollection(db, PROTECTED_COLLECTION, land)
        const { total } = await listRecords(db, def, { page: 1, pageSize: 1 })
        if (total === 0) {
          for (const seed of SEEDS) {
            await createRecord(db, def, {
              id: stableUuid(seed.name),
              name: seed.name,
              label: seed.label,
              description: seed.description ?? null,
              permissions: [...seed.permissions],
              is_system: seed.isSystem ?? false,
            })
          }
        }
        // Additively reconcile the seeded system roles with the current
        // PERMISSIONS list so pre-existing installs gain new platform
        // capabilities (e.g. `lands.*`) without removing any customization.
        const table = physicalTable(land, PROTECTED_COLLECTION)
        const { rows } = await listRecords(db, def, { page: 1, pageSize: 100 })
        for (const seed of SEEDS) {
          const rec = (rows as unknown as PrivilegeRecord[]).find(
            (r) => r.name === seed.name && r.is_system === true,
          )
          if (!rec) continue
          const stored = Array.isArray(rec.permissions) ? rec.permissions : []
          const missing = seed.permissions.filter((p) => !(stored as string[]).includes(p))
          if (missing.length === 0) continue
          const merged = [...stored, ...missing]
          await db.run(
            sql`UPDATE ${sql.raw(quoteIdentifier(table))} SET ${sql.raw(quoteIdentifier('permissions'))} = ${JSON.stringify(merged)}, ${sql.raw(quoteIdentifier('updated_at'))} = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${sql.raw(quoteIdentifier('name'))} = ${seed.name}`,
          )
        }
      })(),
    )
  }
  return privReady.get(land)!
}

async function collectionDef(db: Db, land: string = LAND_DEFAULT) {
  await ensurePrivileges(db, land)
  return getCollection(db, PROTECTED_COLLECTION, land)
}

/** All privilege records (id, name, label, permissions, is_system). */
export async function listPrivileges(db: Db, land: string = LAND_DEFAULT): Promise<PrivilegeRecord[]> {
  const def = await collectionDef(db, land)
  const out: PrivilegeRecord[] = []
  let page = 1
  const pageSize = 100
  for (;;) {
    const { rows, total } = await listRecords(db, def, { page, pageSize })
    for (const r of rows) {
      out.push(r as unknown as PrivilegeRecord)
    }
    if (out.length >= total) break
    page += 1
  }
  return out
}

export async function getPrivilegeById(db: Db, id: string, land: string = LAND_DEFAULT): Promise<PrivilegeRecord | undefined> {
  const all = await listPrivileges(db, land)
  return all.find((p) => p.id === id)
}

export async function getPrivilegeByName(db: Db, name: string, land: string = LAND_DEFAULT): Promise<PrivilegeRecord | undefined> {
  const all = await listPrivileges(db, land)
  return all.find((p) => p.name === name)
}

/** id → { name, label } map for serializing AuthUser rows. */
export async function getPrivilegesMap(db: Db, land: string = LAND_DEFAULT): Promise<Map<string, { name: string; label: string }>> {
  const all = await listPrivileges(db, land)
  return new Map(all.map((p) => [p.id, { name: p.name, label: p.label }]))
}

export { SEEDS as PRIVILEGE_SEEDS }