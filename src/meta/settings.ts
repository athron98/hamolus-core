/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import type { KVNamespace } from '@cloudflare/workers-types'
import { LAND_DEFAULT } from '@hamolus/types'

const LEGACY_SETTINGS_KEY = 'settings:v1'

function settingsKey(land: string): string {
  if (land === LAND_DEFAULT || land === '') return LEGACY_SETTINGS_KEY
  return `settings:${land}:v1`
}

/**
 * Settings are stored as a single JSON blob in Cloudflare KV, keyed per land
 * (`settings:{land}:v1`). The default land keeps the legacy `settings:v1` key so
 * pre-land blobs keep working untouched.
 * Shape is free-form — see docs/settings.md for the recommended structure.
 */
export async function getSettings(kv: KVNamespace, land: string = LAND_DEFAULT): Promise<Record<string, unknown>> {
  try {
    const raw = await kv.get(settingsKey(land))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Merges `patch` over the current settings (shallow top-level merge) and persists. */
export async function putSettings(
  kv: KVNamespace,
  patch: Record<string, unknown>,
  land: string = LAND_DEFAULT,
): Promise<Record<string, unknown>> {
  const current = await getSettings(kv, land)
  const merged = { ...current, ...patch }
  await kv.put(settingsKey(land), JSON.stringify(merged))
  return merged
}