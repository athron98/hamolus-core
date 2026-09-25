/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import type { FieldDefinition } from '@hamolus/types'

/** Convert input values (JSON) into the values stored in D1. */
export function toDbValue(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const isHasMany = field.type === 'relation' && field.relation?.kind === 'hasMany'
  switch (field.type) {
    case 'boolean':
      return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0
    case 'number': {
      const n = Number(value)
      return Number.isNaN(n) ? null : n
    }
    case 'currency': {
      // Accept a bare number (defaults to USD) or a serialized
      // `{ amount, code }` object — store the canonical pair as JSON.
      const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
      const amount = Number(v ? v.amount : value)
      const code = v && typeof v.code === 'string' ? v.code : 'USD'
      return JSON.stringify({ amount: Number.isNaN(amount) ? 0 : amount, code })
    }
    case 'richtext':
    case 'json':
    case 'media':
    case 'document':
    case 'attachment':
      return typeof value === 'string' ? value : JSON.stringify(value)
    default:
      if (isHasMany) return typeof value === 'string' ? value : JSON.stringify(value)
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
  }
}

/** Convert a D1 row value back into the API shape. */
export function fromDbValue(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const isHasMany = field.type === 'relation' && field.relation?.kind === 'hasMany'
  const isMultiEnum = field.type === 'enum' && field.control === 'multichecklist'
  switch (field.type) {
    case 'boolean':
      return value === 1 || value === '1' || value === true
    case 'json':
    case 'media':
    case 'document':
    case 'attachment':
    case 'currency':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    case 'richtext':
      if (field.format === 'markdown' || field.format === 'mdx') return value
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    default:
      if ((isHasMany || isMultiEnum) && typeof value === 'string') {
        try { return JSON.parse(value) as unknown[] } catch { return value }
      }
      return value
  }
}