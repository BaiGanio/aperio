-- 009_workflow_memory_type.sql
-- Add 'workflow' to the memories type CHECK constraint so existing Postgres
-- databases can store workflow-type memories alongside the existing types.

ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_type_check
  CHECK (type IN ('fact','preference','project','decision','solution','source','person','inference','workflow'));
