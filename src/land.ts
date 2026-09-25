/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import type { CoreMode } from '@hamolus/types'
import { CORE_MODES } from '@hamolus/types'
import type { ExecutionContext, MiddlewareHandler } from 'hono'
import type { Env } from './env'
import type { Db } from './db/client'
import { createDb } from './db/client'
import { HttpError } from './errors'
import { ensureDefaultCollectionNames } from './meta/store'
import { ensureLandsRegistry } from './meta/lands'

export const LAND_REQUIRED = 'LAND_REQUIRED'
export const LAND_MISMATCH = 'LAND_MISMATCH'
export const UNKNOWN_LAND = 'UNKNOWN_LAND'
export const UNKNOWN_COLONY = 'UNKNOWN_COLONY'

/** The resolved land scope for the request being served. */
export interface LandContext {
  mode: CoreMode
  land: string
  colony?: string
}

/** Effective land behavior of an env. Defaults to `independent` (single-land). */
export function landMode(env: Env): CoreMode {
  const m = env.CORE_MODE?.trim()
  return m && (CORE_MODES as readonly string[]).includes(m) ? (m as CoreMode) : 'independent'
}

/** Land used by bare/unprefixed land requests. Defaults to `default`. */
export function defaultLandId(env: Env): string {
  const l = env.DEFAULT_LAND?.trim().toLowerCase()
  return l && /^[a-z][a-z0-9_]*$/.test(l) ? l : 'default'
}

/**
 * Re-dispatch target for the land path rewrite. Wired to the hono app's
 * `fetch` so a rewritten request traverses the whole middleware chain again.
 */
export type LandAppFetch = (
  request: Request,
  bindings: Env,
  executionCtx: ExecutionContext,
) => Response | Promise<Response>

/**
 * Pre-auth land path rewrite (`/api/{land}[/{colony}]/…` → `/api/…` with an
 * `x-land`/`x-colony` header + `x-scope-rewritten: 1` loop guard).
 *
 * Only fires when the first segment is a REGISTERED land (and not rewritten
 * yet, ahead of proxy/bridge modes). A registered land id that collides with a
 * default-land collection name is never rewritten — the bare/collection
 * interpretation wins. Colonies are stripped only when they are a registered
 * colony of the resolved land.
 */
export function createLandRewrite(
  appFetch: LandAppFetch,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    if (c.req.header('x-scope-rewritten')) return next()
    const mode = landMode(c.env)
    if (mode === 'proxy' || mode === 'bridge') return next()
    const path = c.req.path
    if (!path.startsWith('/api/')) return next()
    const segs = path.slice('/api'.length).split('/').filter(Boolean)
    if (segs.length === 0) return next()
    const seg0 = segs[0]
    // Land ids cannot start with `_`; built-in routes (`_meta`/`_auth`/…) never rewrite.
    if (seg0.startsWith('_')) return next()

    const db: Db = createDb(c.env.DB)
    const registry = await ensureLandsRegistry(db)
    if (!registry.lands.has(seg0)) return next()
    // A collection in the default land named like the land id wins (healthy data
    // keeps a collection and a land id from clashing).
    const defaultCols = await ensureDefaultCollectionNames(db)
    if (defaultCols.has(seg0)) return next()

    const colony =
      segs.length >= 2 && registry.colonies.get(seg0)?.has(segs[1]) ? segs[1] : undefined
    const strip = colony ? 2 : 1
    const newPath = '/api' + (segs.length > strip ? '/' + segs.slice(strip).join('/') : '')

    const url = new URL(c.req.url)
    url.pathname = newPath
    const headers = new Headers(c.req.raw.headers)
    headers.set('x-land', seg0)
    if (colony) headers.set('x-colony', colony)
    headers.set('x-scope-rewritten', '1')

    const init: RequestInit = {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
    }
    return appFetch(
      // `duplex: 'half'` is required by the fetch spec when re-posting a stream
      // body; the runtime accepts it even though the ambient type omits it.
      new Request(url, { ...init, duplex: 'half' } as unknown as RequestInit),
      c.env,
      c.executionCtx,
    )
  }
}

/**
 * Global path prefixes that never belong to a land. Requests to these are
 * served without needing a resolved land in centralized mode; everything else
 * under `/api` is per-land and requires an explicit land. Exact paths and
 * their sub-paths match (e.g. `/api/_meta/lands` covers `/api/_meta/lands/{id}`).
 */
const GLOBAL_PATH_PREFIXES = [
  '/api/health',
  '/api/_auth/token',
  '/api/_auth/login',
  '/api/_auth/setup',
  '/api/_auth/super',
  '/api/_auth/supers',
  '/api/_auth/me',
  '/api/_meta/lands',
  '/api/_meta/colonies',
]

/**
 * Resolve the effective `LandContext` for the current request.
 *
 * Priority: `x-land`/`x-colony` headers (set by the rewrite or by clients
 * like the console) → JWT `land`/`colony` claims → the default land. When both
 * a header and a JWT claim resolve to different lands the request is rejected
 * with `LAND_MISMATCH` (a token must never cross-land). Proxy/bridge modes
 * forwarders carry no land semantics of their own.
 *
 * In centralized mode a request with no header and no JWT land claim is
 * rejected with `400 LAND_REQUIRED` unless its path is global (see
 * `GLOBAL_PATH_PREFIXES`).
 */
export function resolveRequestLand(c: {
  env: Env
  req: { header(name: string): string | undefined; path?: string }
  get(key: string): unknown
}): LandContext {
  const mode = landMode(c.env)
  if (mode === 'proxy' || mode === 'bridge') {
    return { mode, land: defaultLandId(c.env) }
  }
  const header = c.req.header('x-land')
  const headerColony = c.req.header('x-colony')
  const payload = c.get('jwtPayload') as { land?: string; colony?: string } | undefined

  if (header && payload?.land && payload.land !== header) {
    throw new HttpError(
      403,
      LAND_MISMATCH,
      `JWT token is scoped to land '${payload.land}' but the request resolved to '${header}'`,
    )
  }

  const path = c.req.path ?? ''
  const isGlobal = GLOBAL_PATH_PREFIXES.some(
    (p) => path === p || (path.startsWith(p) && path.charCodeAt(p.length) === 47 /* '/' */),
  )
  if (mode === 'centralized' && !header && !payload?.land && !isGlobal) {
    throw new HttpError(
      400,
      LAND_REQUIRED,
      `This endpoint requires a land — pass an 'x-land' header or an x-land-header-resolved JWT (path '${path}')`,
    )
  }

  const land = header || payload?.land || defaultLandId(c.env)
  const colony = headerColony || payload?.colony || undefined
  return { mode, land, colony }
}