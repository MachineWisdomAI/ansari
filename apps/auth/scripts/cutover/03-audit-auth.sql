-- 03 — copy audit, AUTH side. READ-ONLY. The same `key|value` lines as
-- 03-audit-app.sql; copy.sh diffs them. The query is 03-audit-auth-query.sql,
-- which 02 also runs inside its own transaction under copy.sh --dry-run.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
\ir 03-audit-auth-query.sql
COMMIT;
