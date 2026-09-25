/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from 'hono'
import type { AuthTokenPayload } from '@hamolus/types'
import type { Env } from '../env'
import { badRequest } from '../errors'
import { createDb } from '../db/client'
import { requireSession } from '../auth/session'
import { resolveRequestLand } from '../land'
import { applySnapshot, exportSnapshot } from '../meta/seed'

export const seedRoutes = new Hono<{ Bindings: Env }>()

/** Export the current land state into a reproducible JSON snapshot. */
seedRoutes.get('/export', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'settings.write')
  const landCtx = resolveRequestLand(c)
  const scope = c.req.query('scope') ?? 'all'
  const media = c.req.query('media') ?? 'none'
  const data = await exportSnapshot({
    db,
    kv: c.env.SETTINGS,
    bucket: c.env.MEDIA,
    land: landCtx.land,
    scope,
    withMediaBytes: media === 'bytes',
    origin: new URL(c.req.url).origin,
  })
  return c.json(data)
})

/** Wipe (optionally) and restore a land from a snapshot JSON payload. */
seedRoutes.post('/apply', async (c) => {
  const db = createDb(c.env.DB)
  const payload = c.get('jwtPayload') as AuthTokenPayload | undefined
  requireSession(payload, 'settings.write')
  const landCtx = resolveRequestLand(c)
  const wipe = c.req.query('wipe') !== 'false'
  const body = (await c.req.json().catch(() => null)) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Seed payload must be a JSON snapshot object')
  }
  const data = await applySnapshot({
    db,
    kv: c.env.SETTINGS,
    bucket: c.env.MEDIA,
    land: landCtx.land,
    snap: body,
    wipe,
  })
  return c.json({ data })
})