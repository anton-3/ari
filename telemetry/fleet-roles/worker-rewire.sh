#!/usr/bin/env bash
# Re-point the worker at the db in /etc/ari-net/env and restart it.
set -euo pipefail
set -a; . /etc/ari-net/env; set +a
(umask 077; printf 'DB_HOST=%s\nDB_PASS=%s\n' "$DB_HOST" "$DB_PASS" > /etc/ari-net/worker.env)
systemctl restart ari-worker
sleep 2
systemctl is-active --quiet ari-worker
