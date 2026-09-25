/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthTokenPayload } from '@hamolus/types'
import type { Env } from '../env'
import { badRequest } from '../errors'
import { createDb } from '../db/client'
import { requireRead, requireWrite } from '../auth/session'
import {
  colonyDefinitionSchema,
  deleteColony,
  deleteLand,
  getColony,
  getLand,
  landDefinitionSchema,
  listColonies,
  listLands,
  putColony,
  putLand,
} from '../meta/lands'

/**
 * Land registry routes (`/api/_meta/lands{/id}`) and colony registry routes
 * (`/api/_meta/colonies{/id}`). Both are GLOBAL — they describe land scopes
 * and are gated by the `lands.read`/`lands.write` permissions (the
 * platform-level land registry consumed by the console Lands page).
 */
export const landRoutes = new Hono<{ Bindings: Env }>()
export const colonyRoutes = new Hono<{ Bindings: Env }>()

/** Colony body = colony definition (incl. id) + the owning land id. */
const colonyFullSchema = colonyDefinitionSchema
  .extend({
    landId: z.string().trim().min(2).max(40),
  })
  .strict()

function parseError(label: string, issues: readonly { message: string }[]): never {
  throw badRequest(`${label}: ${issues.map((i) => i.message).join('; ')}`, 'INVALID_LAND')
}

// ————————————————————————————— Lands —————————————————————————————

landRoutes.get('/', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'lands.read')
  const db = createDb(c.env.DB)
  return c.json({ data: await listLands(db) })
})

landRoutes.get('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'lands.read')
  const db = createDb(c.env.DB)
  return c.json({ data: await getLand(db, c.req.param('id')) })
})

/** Upsert a land definition (creates it when the id is new). */
landRoutes.put('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'lands.write')
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw badRequest('Body must be a JSON object')
  if (body.id !== undefined && body.id !== id) {
    throw badRequest('Body id must match the path parameter')
  }
  const parsed = landDefinitionSchema.safeParse({ ...body, id })
  if (!parsed.success) parseError('Invalid land definition', parsed.error.issues)
  const db = createDb(c.env.DB)
  return c.json({ data: await putLand(db, parsed.data) })
})

landRoutes.delete('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'lands.write')
  const db = createDb(c.env.DB)
  await deleteLand(db, c.req.param('id'))
  return c.body(null, 204)
})

// ———————————————————————————— Colonies ————————————————————————————

colonyRoutes.get('/', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'lands.read')
  const db = createDb(c.env.DB)
  const land = c.req.query('land') || undefined
  return c.json({ data: await listColonies(db, land) })
})

colonyRoutes.get('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireRead(payload, 'lands.read')
  const db = createDb(c.env.DB)
  const land = c.req.query('land') || undefined
  return c.json({ data: await getColony(db, c.req.param('id'), land) })
})

/** Upsert a colony under an existing land. */
colonyRoutes.put('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'lands.write')
  const id = c.req.param('id')
  const idCheck = colonyDefinitionSchema.shape.id.safeParse(id)
  if (!idCheck.success) parseError('Invalid colony definition', idCheck.error.issues)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw badRequest('Body must be a JSON object')
  if (body.id !== undefined && body.id !== id) {
    throw badRequest('Body id must match the path parameter')
  }
  const parsed = colonyFullSchema.safeParse({ ...body, id })
  if (!parsed.success) parseError('Invalid colony definition', parsed.error.issues)
  const db = createDb(c.env.DB)
  const colony = await putColony(db, parsed.data.landId, {
    id,
    label: parsed.data.label,
    description: parsed.data.description ?? null,
  })
  return c.json({ data: colony })
})

colonyRoutes.delete('/:id', async (c) => {
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'lands.write')
  const db = createDb(c.env.DB)
  const land = c.req.query('land') || undefined
  await deleteColony(db, c.req.param('id'), land)
  return c.body(null, 204)
})