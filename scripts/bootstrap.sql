-- Copyright (c) 2026 Hamolus Labs
-- Author: Gilang Albathin Nurhabibi <athron98.github.io>
-- SPDX-License-Identifier: MIT
-- Bootstrap metadata table for collection definitions (manual, optional).
-- Runtime also creates it automatically (CREATE TABLE IF NOT EXISTS) in meta/store.ts.
CREATE TABLE IF NOT EXISTS _meta_collections (
  name TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  timestamps INTEGER NOT NULL DEFAULT 0,
  soft_delete INTEGER NOT NULL DEFAULT 0,
  primary_key TEXT NOT NULL DEFAULT 'id',
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);