#!/usr/bin/env bash
# Re-point a running app node at the db/cache in /etc/ari-net/env (updated by
# the controller), sync the code, restart MyFiat only, and verify /health.
set -euo pipefail
set -a; . /etc/ari-net/env; set +a
. "$(dirname "$0")/app-lib.sh"
echo "[ari-net:app] rewire: db=$DB_HOST cache=${REDIS_HOST:-none}"
deploy_code
write_app_env
restart_and_check
echo "[ari-net:app] rewire ok"
