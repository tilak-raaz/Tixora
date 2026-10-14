-- 0001: extensions used across the schema.
--
-- Migrations are forward-only and immutable once applied: the runner stores a
-- checksum per file and refuses to start if an applied file was edited.
-- To change the schema, add a new NNNN_description.sql file.

-- Needed for the shows exclusion constraint in M1:
--   EXCLUDE USING gist (screen_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
-- btree_gist lets a plain equality column (screen_id) sit in a GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;
