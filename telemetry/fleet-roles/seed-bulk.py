#!/usr/bin/env python3
"""Deterministic bulk-row generator for the AcmePay demo bank.

Streams tab-separated `transactions` rows to stdout for a Postgres COPY, which
is the fast bulk path. PURE generation: random + fixed arrays, NO model/LLM
inference. Columns match the final schema in target-app/src/db.js:
  user_id  merchant_id  amount_cents  currency  status  description  created_at
created_at is ISO-8601 TEXT (e.g. 2023-07-04T12:34:56.000Z) so ORDER BY
created_at DESC sorts chronologically for the bank's recent-activity feed.

Usage (driver pipes this into psql COPY):
  seed-bulk.py <count> <nusers> <nmerch> <seed>
Deterministic for a given (count, seed): re-running with the same args emits the
same rows.
"""
import random
import sys

count = int(sys.argv[1]) if len(sys.argv) > 1 else 5_000_000
nusers = int(sys.argv[2]) if len(sys.argv) > 2 else 1_000_000
nmerch = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
rnd = random.Random(seed)

# 'succeeded' dominates, with some pending/failed/refunded (looks real).
STATUS = (['succeeded'] * 16) + ['pending', 'pending', 'failed', 'refunded']
# created_at spread over 2019-01-01 .. 2025-12-31 (days since epoch 2019-01-01).
DAY_MIN, DAY_MAX = 0, 2556
EPOCH_2019 = 1546300800  # 2019-01-01T00:00:00Z in unix seconds
import time as _time
_gmtime = _time.gmtime

out = sys.stdout
w = out.write
ri = rnd.randint
rc = rnd.choice
for _ in range(count):
    uid = ri(1, nusers)
    mid = ri(1, nmerch)
    amount = ri(100, 500000)
    status = rc(STATUS)
    desc = 'Order #%d' % ri(1000000, 9999999)
    ts = EPOCH_2019 + ri(DAY_MIN, DAY_MAX) * 86400 + ri(0, 86399)
    g = _gmtime(ts)
    created = '%04d-%02d-%02dT%02d:%02d:%02d.000Z' % (g.tm_year, g.tm_mon, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec)
    # TSV row (COPY default format). No embedded tabs/newlines in any field.
    w('%d\t%d\t%d\tUSD\t%s\t%s\t%s\n' % (uid, mid, amount, status, desc, created))
