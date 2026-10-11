#!/usr/bin/env bash
# Shared MyFiat deploy helpers (sourced by app.sh and app-rewire.sh).

# Fresh copy of the uploaded code, keeping node_modules; reinstall deps only
# when the lockfile changed.
deploy_code() {
  mkdir -p /opt/myfiat
  local oldlock=""
  [ -f /opt/myfiat/package-lock.json ] && oldlock=$(sha256sum /opt/myfiat/package-lock.json | cut -d' ' -f1)
  find /opt/myfiat -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -a /opt/ari-net/bundle/target-app/. /opt/myfiat/
  local newlock
  newlock=$(sha256sum /opt/myfiat/package-lock.json | cut -d' ' -f1)
  if [ ! -d /opt/myfiat/node_modules ] || [ "$oldlock" != "$newlock" ]; then
    (cd /opt/myfiat && npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error >/dev/null)
  fi
  chown -R myfiat:myfiat /opt/myfiat
}

# /etc/ari-net/app.env from /etc/ari-net/env. The cache is optional: with no
# REDIS_HOST, MyFiat runs without Redis.
write_app_env() {
  (umask 077; {
    echo "NODE_ENV=production"
    echo "PORT=3000"
    echo "DATABASE_URL=postgres://${DB_USER:-myfiat}:$DB_PASS@$DB_HOST:5432/${DB_NAME:-myfiat}"
    if [ -n "${REDIS_HOST:-}" ]; then echo "REDIS_URL=redis://:$REDIS_PASS@$REDIS_HOST:6379"; fi
  } > /etc/ari-net/app.env)
  chown myfiat /etc/ari-net/app.env
}

restart_and_check() {
  systemctl restart myfiat
  for i in $(seq 1 30); do curl -fsS localhost:3000/health >/dev/null 2>&1 && return 0; sleep 1; done
  curl -fsS localhost:3000/health >/dev/null
}
