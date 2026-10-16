-- 00 — preflight on the APP database. READ-ONLY. Run before the window and again
-- at its start:
--   psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 00-preflight-app.sql
-- Prints ids, counts and admin addresses only; never a password hash.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

\echo '== Case audit: non-system rows whose email is not lower(trim(email)) (normalized by the copy)'
SELECT count(*) AS not_normalized
FROM public.users
WHERE system_key IS NULL AND email <> lower(trim(email));

\echo '== Collisions: non-system rows sharing a normalized email (the copy and 0011 ABORT on any; decide each before the window)'
SELECT count(*) AS rows_in_group, array_agg(id ORDER BY created_at, id) AS ids
FROM public.users
WHERE system_key IS NULL
GROUP BY lower(trim(email))
HAVING count(*) > 1
ORDER BY 1 DESC;

\echo '== Rows the copy cannot carry (no legacy password hash): must be zero'
SELECT count(*) AS no_password_hash
FROM public.users
WHERE system_key IS NULL AND password_hash IS NULL;

\echo '== Rows with a NULL timestamp (the copy stores now() for those; informational)'
SELECT count(*) FILTER (WHERE created_at IS NULL) AS null_created_at,
       count(*) FILTER (WHERE updated_at IS NULL) AS null_updated_at
FROM public.users
WHERE system_key IS NULL;

\echo '== Guests by their exact shape (informational; migrated as-is)'
SELECT count(*) AS guests
FROM public.users
WHERE system_key IS NULL
  AND lower(trim(email)) ~ '^guest_[a-z0-9]{10}@(askansari\.ai|ansari\.chat)$';

\echo '== Legacy admin inventory (is_admin): compare with the owner-approved list and ADMIN_EMAILS'
SELECT id, lower(trim(email)) AS email
FROM public.users
WHERE is_admin
ORDER BY 2;

\echo '== System accounts (never copied)'
SELECT id, system_key
FROM public.users
WHERE system_key IS NOT NULL
ORDER BY system_key;

\echo '== Rows to copy'
SELECT count(*) AS to_copy FROM public.users WHERE system_key IS NULL;

\echo '== B-1: sign-ups per minute and per hour over 90 days (peak and p99), all and guest-shaped'
WITH rows AS (
  SELECT created_at,
         lower(trim(email)) ~ '^guest_[a-z0-9]{10}@(askansari\.ai|ansari\.chat)$' AS guest
  FROM public.users
  WHERE system_key IS NULL AND created_at >= now() - interval '90 days'
),
per_minute AS (
  SELECT date_trunc('minute', created_at) AS t, count(*) AS n, count(*) FILTER (WHERE guest) AS g
  FROM rows GROUP BY 1
),
per_hour AS (
  SELECT date_trunc('hour', created_at) AS t, count(*) AS n, count(*) FILTER (WHERE guest) AS g
  FROM rows GROUP BY 1
)
SELECT 'minute' AS bucket,
       max(n) AS peak, percentile_disc(0.99) WITHIN GROUP (ORDER BY n) AS p99,
       max(g) AS guest_peak, percentile_disc(0.99) WITHIN GROUP (ORDER BY g) AS guest_p99
FROM per_minute
UNION ALL
SELECT 'hour', max(n), percentile_disc(0.99) WITHIN GROUP (ORDER BY n),
       max(g), percentile_disc(0.99) WITHIN GROUP (ORDER BY g)
FROM per_hour;

\echo '== B-4: sign-ins and refreshes per minute (legacy tokens rows, inside their retention)'
WITH per_minute AS (
  SELECT date_trunc('minute', created_at) AS t, count(*) AS n
  FROM public.tokens
  WHERE token_type IN ('access', 'refresh')
  GROUP BY 1
)
SELECT max(n) AS peak, percentile_disc(0.99) WITHIN GROUP (ORDER BY n) AS p99,
       min(t) AS oldest_minute, max(t) AS newest_minute
FROM per_minute;

COMMIT;
