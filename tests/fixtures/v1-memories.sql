-- tests/fixtures/v1-memories.sql - a small v1 DB for T2.12 (spec S2.12).
--
-- The CREATE TABLE is copied once from archive/v1-final:db/migrations-sqlite/001_core.sql
-- (the memories table only; the FTS and vec0 sidecars need nothing here).
-- Tests build a DB from this file; they never call git.
--
-- 5 current rows (m-001 .. m-005), 1 superseded (m-006), 1 expired (m-007).
-- Current rows carry the v1-only columns the importer drops and counts:
-- pinned (m-003), tier 2 (m-003), lang (m-004), confidence (m-004), a future expires_at (m-004).

CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN (
                  'fact','preference','project','decision',
                  'solution','source','person','inference','workflow'
                )),
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]'  CHECK (json_valid(tags)),
  importance    INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  tier          INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (1, 2, 3)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',
  lang          TEXT NOT NULL DEFAULT 'english',
  valid_from    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_until   TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0.0 AND 1.0),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1))
);

INSERT INTO memories (id, type, title, content, tags, importance, tier, created_at, updated_at, expires_at, source, lang, valid_until, confidence, pinned) VALUES
  ('m-001', 'fact',       'Coffee order',  'Flat white with oat milk, every morning.', '["drink","habit"]', 4, 1,
   '2025-03-01T08:15:00.000Z', '2025-04-02T09:00:00.000Z', NULL, 'chat', 'english', NULL, 1.0, 0),
  ('m-002', 'preference', 'Любим град',    'Пловдив, заради стария град и тепетата.',  '["bg","город"]',     3, 1,
   '2025-05-10T18:30:12.345Z', '2025-05-10T18:30:12.345Z', NULL, 'manual', 'english', NULL, 1.0, 0),
  ('m-003', 'project',    'Nimbus bus',    'Nimbus uses NATS JetStream as its event bus.', '["nimbus"]',     5, 2,
   '2025-06-01T10:00:00.000Z', '2025-07-01T10:00:00.000Z', NULL, 'system', 'english', NULL, 1.0, 1),
  ('m-004', 'person',     'Dentist',       'Dr. Petrova, clinic on Vasil Levski street.', '[]',              2, 1,
   '2025-08-20T07:00:00.000Z', '2025-08-20T07:00:00.000Z', '2099-01-01T00:00:00.000Z', 'chat', 'bulgarian', NULL, 0.8, 0),
  ('m-005', 'decision',   'Editor',        'We use plain Vim; no plugins on servers.',  '["tools"]',         3, 1,
   '2025-09-09T09:09:09.009Z', '2025-09-10T10:10:10.010Z', NULL, 'manual', 'english', NULL, 1.0, 0),
  ('m-006', 'fact',       'Old phone',     'Phone is a Pixel 4. (replaced since)',      '[]',                3, 1,
   '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', NULL, 'chat', 'english', '2025-01-01T00:00:00.000Z', 1.0, 0),
  ('m-007', 'fact',       'Hotel booking', 'Room 12 until Friday.',                     '[]',                2, 1,
   '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z', '2024-02-05T00:00:00.000Z', 'chat', 'english', NULL, 1.0, 0);
