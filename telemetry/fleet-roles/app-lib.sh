#!/usr/bin/env bash
# Shared AcmePay deploy helpers (sourced by app.sh and app-rewire.sh).

# Fresh copy of the uploaded code, keeping node_modules; reinstall deps only
# when the lockfile changed.
deploy_code() {
  mkdir -p /opt/acmepay
  local oldlock=""
  [ -f /opt/acmepay/package-lock.json ] && oldlock=$(sha256sum /opt/acmepay/package-lock.json | cut -d' ' -f1)
  find /opt/acmepay -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -a /opt/ari-net/bundle/target-app/. /opt/acmepay/
  local newlock
  newlock=$(sha256sum /opt/acmepay/package-lock.json | cut -d' ' -f1)
  if [ ! -d /opt/acmepay/node_modules ] || [ "$oldlock" != "$newlock" ]; then
    (cd /opt/acmepay && npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error >/dev/null)
  fi
  chown -R acmepay:acmepay /opt/acmepay
}

# /etc/ari-net/app.env from /etc/ari-net/env. The cache is optional: with no
# REDIS_HOST, AcmePay runs without Redis.
write_app_env() {
  (umask 077; {
    echo "NODE_ENV=production"
    echo "PORT=3000"
    echo "DATABASE_URL=postgres://acmepay:$DB_PASS@$DB_HOST:5432/acmepay"
    if [ -n "${REDIS_HOST:-}" ]; then echo "REDIS_URL=redis://:$REDIS_PASS@$REDIS_HOST:6379"; fi
  } > /etc/ari-net/app.env)
  chown acmepay /etc/ari-net/app.env
}

restart_and_check() {
  systemctl restart acmepay
  for i in $(seq 1 30); do curl -fsS localhost:3000/health >/dev/null 2>&1 && return 0; sleep 1; done
  curl -fsS localhost:3000/health >/dev/null
}
