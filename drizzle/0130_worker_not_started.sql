-- needs_human_reason is unconstrained SQLite TEXT. Adding the Drizzle enum
-- member worker-not-started needs no table rebuild; existing values are preserved.
SELECT 1;
