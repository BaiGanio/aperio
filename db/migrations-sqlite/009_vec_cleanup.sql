-- 009_vec_cleanup.sql — keep the vec_memories sidecar in sync on delete.
--
-- vec0 virtual tables are not covered by the FTS triggers in 001_core.sql, so
-- deleting a memory left its embedding row behind. When SQLite later reused
-- the freed rowid, the next embedded insert failed with a vec constraint
-- violation ("remember" broke after any "forget"). self_memories already
-- guards against this via trg_self_memories_vec_cleanup (006); this brings
-- the memories table in line. SQLite-only: the Postgres schema stores the
-- embedding as a column on memories, so row deletion removes it there.

-- Repair orphans left behind by deletes that ran before this migration.
DELETE FROM vec_memories
 WHERE rowid NOT IN (SELECT rowid FROM memories);

CREATE TRIGGER trg_memories_vec_cleanup AFTER DELETE ON memories BEGIN
  DELETE FROM vec_memories WHERE rowid = OLD.rowid;
END;
