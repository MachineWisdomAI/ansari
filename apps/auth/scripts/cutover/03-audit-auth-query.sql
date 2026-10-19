-- 03 — the auth-side audit query, included (never run on its own) by
-- 03-audit-auth.sql (read-only, after the copy) and by 02-import-auth.sql under
-- copy.sh --dry-run (inside the import's transaction, before its ROLLBACK:
-- another session cannot see uncommitted rows). It opens no transaction.
-- The hash checksum is over the credential accounts' password column, ordered
-- by user id, so a hash altered or truncated in transit fails the audit before
-- the app migration runs.
\pset tuples_only on
\pset format unaligned
WITH c AS (
  SELECT user_id, password FROM auth.account WHERE provider_id = 'credential'
)
SELECT 'rows|' || count(*) FROM auth.users
UNION ALL SELECT 'id_checksum|' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), '') FROM auth.users
UNION ALL SELECT 'email_checksum|' || coalesce(md5(string_agg(email, ',' ORDER BY id)), '') FROM auth.users
UNION ALL SELECT 'hash_checksum|' || coalesce(md5(string_agg(password, '' ORDER BY user_id)), '') FROM c
UNION ALL SELECT 'credentials|' || count(*) FROM c
UNION ALL SELECT 'system_domain_rows|' || count(*) FROM auth.users WHERE email LIKE '%@system.ansari.chat';
