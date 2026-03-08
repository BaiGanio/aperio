-- ============================================================
-- Aperio - pgvector Migration
-- Migration: 002_pgvector.sql
-- Run this manually after upgrading to pgvector/pgvector:pg16
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to memories
-- 1536 dimensions = Anthropic's text-embedding-3 size
-- We use 1024 dimensions for voyage-3 (Anthropic's recommended model)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Index for fast similarity search (cosine distance)
-- Using HNSW — best for recall quality on smaller datasets
CREATE INDEX IF NOT EXISTS idx_memories_embedding
ON memories
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ============================================================
-- Helper view: memories without embeddings (for backfill)
-- ============================================================
CREATE OR REPLACE VIEW memories_without_embeddings AS
SELECT id, title, content, type, tags
FROM memories
WHERE embedding IS NULL;
