#!/usr/bin/env python3
"""ari-net worker: a small AcmePay settlement/reporting job.

Keeps one Postgres connection open and every few seconds:
  - summarises the ledger by status (reporting query),
  - settles at most one 'pending' transaction older than 2 minutes.
"""
import os, time
import psycopg2

DSN = "host=%s port=5432 dbname=acmepay user=acmepay password=%s connect_timeout=5" % (
    os.environ["DB_HOST"], os.environ["DB_PASS"])


def run():
    conn = psycopg2.connect(DSN)
    conn.autocommit = True
    cur = conn.cursor()
    n = 0
    while True:
        cur.execute("SELECT status, COUNT(*), COALESCE(SUM(amount_cents),0) FROM transactions GROUP BY status")
        rows = cur.fetchall()
        n += 1
        if n % 3 == 0:
            cur.execute("""UPDATE transactions SET status = 'succeeded'
                           WHERE id = (SELECT id FROM transactions WHERE status = 'pending'
                                       AND created_at < to_char(now() - interval '2 minutes', 'YYYY-MM-DD"T"HH24:MI:SS')
                                       ORDER BY id LIMIT 1)""")
        if n % 30 == 0:
            print("ledger:", {r[0]: (r[1], r[2]) for r in rows}, flush=True)
        time.sleep(3)


while True:
    try:
        run()
    except Exception as e:  # db restarting / not ready yet
        print("worker error:", e, flush=True)
        time.sleep(5)
