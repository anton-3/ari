#!/usr/bin/env bash
# =============================================================================
#  seed-bulk.sh — load a large AcmePay dataset into Postgres on the ari-net db
#  node, fast, via COPY, in batches with a COMMIT per batch, watching disk.
# =============================================================================
#  Run ON the db node as root:
#    TARGET_GB=120 bash seed-bulk.sh
#  Env:
#    TARGET_GB      final pg_database_size goal (default 120)
#    MAX_DISK_PCT   stop if the data filesystem exceeds this %% used (default 80)
#    BATCH          transactions per COPY batch (default 10000000)
#    NUSERS NMERCH  how many users / merchants to ensure (default 1e6 / 2000)
#    PGDB           database (default acmepay)
#
#  Strategy: ensure users+merchants, DROP the transaction indexes (incl PK),
#  COPY batches until the size target or the disk guard, then rebuild indexes
#  and ANALYZE. Re-runnable: re-running once at target just rebuilds indexes.
#  Deterministic generator: fleet-roles/seed-bulk.py (random+arrays, no LLM).
# =============================================================================
set -euo pipefail
TARGET_GB=${TARGET_GB:-120}       # desired FINAL pg_database_size (incl. indexes)
# Indexes are dropped during load, so the heap-only load must stop earlier. The
# rebuilt indexes (PK + user_id/created_at + created_at + status over ISO-TEXT)
# roughly double the size, so heap ~= HEAP_FRACTION * final. Measured ~0.48 for
# this schema; tune if your final size lands off-target (re-run tops it up).
HEAP_FRACTION=${HEAP_FRACTION:-0.48}
MAX_DISK_PCT=${MAX_DISK_PCT:-80}
BATCH=${BATCH:-10000000}   # rows per COPY stream per wave
PAR=${PAR:-4}              # parallel COPY streams per wave
NUSERS=${NUSERS:-1000000}
NMERCH=${NMERCH:-2000}
PGDB=${PGDB:-acmepay}
HERE="$(cd "$(dirname "$0")" && pwd)"
GEN="$HERE/seed-bulk.py"
PSQL=(sudo -u postgres psql -d "$PGDB" -v ON_ERROR_STOP=1 -qtA)
TARGET_BYTES=$(( TARGET_GB * 1024 * 1024 * 1024 ))
# Heap stop size during the index-less load (final is ~TARGET after rebuild).
HEAP_TARGET_BYTES=$(awk "BEGIN{printf \"%d\", $TARGET_BYTES * $HEAP_FRACTION}")

q() { "${PSQL[@]}" -c "$1"; }
dbsize()  { q "SELECT pg_database_size('$PGDB')"; }
diskpct() { df -P "$(q "SHOW data_directory")" | awk 'NR==2{gsub("%","",$5); print $5}'; }
pretty()  { q "SELECT pg_size_pretty(pg_database_size('$PGDB'))"; }

echo "[seed-bulk] target=${TARGET_GB}GB batch=${BATCH} users=${NUSERS} merch=${NMERCH} maxdisk=${MAX_DISK_PCT}%"

# --- schema (no-op if the app created it) + session tuning ---
"${PSQL[@]}" <<SQL
SET synchronous_commit=off;
CREATE TABLE IF NOT EXISTS merchants (id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, country TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, password_md5 TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', ssn_last4 TEXT, card_last4 TEXT, balance_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, merchant_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
SQL

# --- merchants up to NMERCH ---
"${PSQL[@]}" <<SQL
INSERT INTO merchants (name, category, country, created_at)
SELECT (ARRAY['Blue Bottle Coffee','Northwind Electronics','Contoso Cloud','Fabrikam Logistics','Globex Airlines','Initech Payroll','Umbrella Pharmacy','Acme Hardware','Wonka Industries','Stark Supply Co','Wayne Grocers','Soylent Foods','Tyrell Systems','Cyberdyne Robotics','Gekko Capital','Oceanic Travel','Duff Brewing','Krusty Burger','Monsters Inc','Pied Piper'])[1+(g%20)] || ' #' || g,
       (ARRAY['food_and_drink','retail','software','shipping','travel','business_services','healthcare','entertainment','utilities','finance'])[1+(g%10)],
       (ARRAY['US','US','US','GB','DE','IE','FR','CA','AU','JP'])[1+(g%10)],
       '2019-01-15T00:00:00.000Z'
FROM generate_series((SELECT count(*) FROM merchants)+1, ${NMERCH}) g;
SQL

# --- users up to NUSERS (demo logins id 1,2 from seed.js are left intact) ---
"${PSQL[@]}" <<SQL
INSERT INTO users (email, full_name, password_md5, role, ssn_last4, card_last4, balance_cents, created_at)
SELECT 'customer'||g||'@acmepay.example', 'Customer '||g,
       md5((ARRAY['password1','qwerty','letmein','hunter2','sunshine','123456','dragon'])[1+(g%7)]),
       'customer', lpad((g%10000)::text,4,'0'), lpad((g%10000)::text,4,'0'),
       (random()*2000000)::int, '2020-01-01T00:00:00.000Z'
FROM generate_series((SELECT count(*) FROM users)+1, ${NUSERS}) g;
SQL
echo "[seed-bulk] users=$(q 'SELECT count(*) FROM users') merchants=$(q 'SELECT count(*) FROM merchants')"

# --- drop transaction indexes (incl PK) for a fast bulk COPY ---
"${PSQL[@]}" <<SQL
DROP INDEX IF EXISTS idx_txn_user_created;
DROP INDEX IF EXISTS idx_txn_created;
DROP INDEX IF EXISTS idx_txn_status;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_pkey;
SQL

# --- COPY waves (PAR parallel streams each) until size target or disk guard ---
copy_one() { # seed
  python3 "$GEN" "$BATCH" "$NUSERS" "$NMERCH" "$1" \
    | "${PSQL[@]}" -c "COPY transactions (user_id,merchant_id,amount_cents,currency,status,description,created_at) FROM STDIN"
}
wave=0
while :; do
  sz=$(dbsize); pct=$(diskpct)
  echo "[seed-bulk] $(date +%H:%M:%S) size=$(pretty) disk=${pct}% wave=${wave} txns=$(q 'SELECT count(*) FROM transactions')"
  if [ "$sz" -ge "$HEAP_TARGET_BYTES" ]; then echo "[seed-bulk] reached heap target (final ~${TARGET_GB}GB after index rebuild)"; break; fi
  if [ "$pct" -ge "$MAX_DISK_PCT" ]; then echo "[seed-bulk] STOP: disk ${pct}% >= ${MAX_DISK_PCT}% guard"; break; fi
  wave=$((wave+1))
  pids=()
  for s in $(seq 1 "$PAR"); do copy_one $((wave*100 + s)) & pids+=($!); done
  for p in "${pids[@]}"; do wait "$p"; done
done

echo "[seed-bulk] rebuilding indexes (maintenance_work_mem=2GB, parallel) ..."
"${PSQL[@]}" <<SQL
SET maintenance_work_mem='2GB';
SET max_parallel_maintenance_workers=4;
ALTER TABLE transactions ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS idx_txn_user_created ON transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
SQL
echo "[seed-bulk] ANALYZE ..."
q "ANALYZE transactions" >/dev/null; q "ANALYZE users" >/dev/null; q "ANALYZE merchants" >/dev/null
echo "[seed-bulk] DONE size=$(pretty) txns=$(q 'SELECT count(*) FROM transactions') disk=$(diskpct)%"
