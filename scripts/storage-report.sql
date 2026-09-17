-- Where has the space gone? Paste the whole thing into Neon's SQL editor.
-- Read-only: every statement here is a SELECT. Nothing is changed.

-- 1 & 2. Did the job touch the old orders?
--    A re-encoded 15-page book is roughly 1.3 MB of text (~85 KB a page).
--    An untouched one is roughly 13 MB (~900 KB a page). The difference is
--    not subtle, so one look down this list answers it.
SELECT o.id,
       o.submitted_at::date                            AS placed,
       COUNT(*)                                        AS pages,
       pg_size_pretty(SUM(length(p.image))::bigint)    AS stored,
       pg_size_pretty(AVG(length(p.image))::bigint)    AS avg_page
  FROM orders o
  JOIN order_pages p ON p.order_id = o.id
 GROUP BY o.id, o.submitted_at
 ORDER BY o.id;

-- The same thing as one line: how many pages are still big?
SELECT COUNT(*)                                             AS pages,
       pg_size_pretty(SUM(length(image))::bigint)           AS total_text,
       pg_size_pretty(AVG(length(image))::bigint)           AS avg_page,
       COUNT(*) FILTER (WHERE length(image) >  300000)      AS still_large,
       COUNT(*) FILTER (WHERE length(image) <= 300000)      AS already_small
  FROM order_pages;

-- 3. If the rows ARE small but the database is not, the space is held by dead
--    row versions. An UPDATE in Postgres writes a new row and leaves the old
--    one behind; the file never shrinks on its own.
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid))   AS total,
       pg_size_pretty(pg_relation_size(relid))         AS heap_only,
       n_live_tup, n_dead_tup,
       last_vacuum, last_autovacuum
  FROM pg_stat_user_tables
 WHERE relname IN ('orders', 'order_pages', 'order_pdfs')
 ORDER BY pg_total_relation_size(relid) DESC;

-- The image text does not live in the table itself - a large TEXT value is
-- pushed out to a TOAST table, and that is where the bloat will be. This is
-- the query that actually locates it.
SELECT c.relname                                    AS parent_table,
       t.relname                                    AS toast_table,
       pg_size_pretty(pg_relation_size(t.oid))      AS toast_size,
       s.n_live_tup, s.n_dead_tup, s.last_autovacuum
  FROM pg_class c
  JOIN pg_class t          ON t.oid = c.reltoastrelid
  LEFT JOIN pg_stat_all_tables s ON s.relid = t.oid
 WHERE c.relname IN ('order_pages', 'orders', 'order_pdfs');

-- And the whole database, for comparison against /health and the Neon console.
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
