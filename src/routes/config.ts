/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from 'hono'
import type { AuthTokenPayload } from '@hamolus/types'
import { configEntrySchema, configListQuerySchema } from '@hamolus/types'
import type { Env } from '../env'
import { createDb } from '../db/client'
import { badRequest } from '../errors'
import { deleteConfig, getConfig, listConfigs, putConfig } from '../auth/config'
import { requireSession, requireWrite } from '../auth/session'
import { resolveRequestLand } from '../land'

export const configRoutes = new Hono<{ Bindings: Env }>()

/** List key/value configuration entries (optional `?scope=` filter). Session required. */
configRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'config.read')
  const parsed = configListQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams.entries()))
  if (!parsed.success) throw badRequest('Invalid query: ' + parsed.error.issues.map((i) => i.message).join('; '), 'INVALID_QUERY')
  const landCtx = resolveRequestLand(c)
  const entries = await listConfigs(db, parsed.data.scope, landCtx.land)
  return c.json({ data: entries })
})

/** Read a single config entry. Session required. */
configRoutes.get('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'config.read')
  const landCtx = resolveRequestLand(c)
  const entry = await getConfig(db, c.req.param('key'), landCtx.land)
  return c.json({ data: entry })
})

/** Upsert a config entry (`key` must match the path parameter). */
configRoutes.put('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'config.write')
  const landCtx = resolveRequestLand(c)
  const key = c.req.param('key')
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') throw badRequest('Body must be a JSON object')
  if (body.key !== undefined && body.key !== key) {
    throw badRequest('Body key must match the path parameter')
  }
  const parsed = configEntrySchema.safeParse({ ...body, key })
  if (!parsed.success) {
    throw badRequest('Invalid config: ' + parsed.error.issues.map((i) => i.message).join('; '), 'VALIDATION')
  }
  const entry = await putConfig(db, {
    key: parsed.data.key,
    value: parsed.data.value,
    scope: parsed.data.scope,
    description: parsed.data.description ?? null,
  }, landCtx.land)
  return c.json({ data: entry })
})

/** Delete a config entry. */
configRoutes.delete('/:key', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireWrite(payload, 'config.write')
  const landCtx = resolveRequestLand(c)
  await deleteConfig(db, c.req.param('key'), landCtx.land)
  return c.body(null, 204)
})