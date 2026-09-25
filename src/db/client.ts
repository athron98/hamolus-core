/**
 * Copyright (c) 2026 Hamolus Labs
 * Author: Gilang Albathin Nurhabibi <athron98.github.io>
 * SPDX-License-Identifier: MIT
 */

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from './schema'

export type Db = DrizzleD1Database<typeof schema>

export function createDb(binding: D1Database): Db {
  return drizzle(binding, { schema })
}