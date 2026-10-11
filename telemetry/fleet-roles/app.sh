#!/usr/bin/env bash
# app: MyFiat (Node 20) on :3000, Postgres + Redis over private IPs.
# Needs DB_HOST, DB_PASS in /etc/ari-net/env; REDIS_HOST/REDIS_PASS optional (no cache = no Redis).
. "$(dirname "$0")/common.sh"
apt_install ca-certificates curl xz-utils
install_node20
id myfiat >/dev/null 2>&1 || useradd --system --home /opt/myfiat --shell /usr/sbin/nologin myfiat
log "deploying MyFiat"
. "$(dirname "$0")/app-lib.sh"
deploy_code
write_app_env
# Schema + seed (idempotent; the controller serializes app bootstraps).
cd /opt/myfiat
sudo -u myfiat bash -c 'set -a; . /etc/ari-net/app.env; exec /usr/local/bin/node seed.js'
cat > /etc/systemd/system/myfiat.service <<'UNIT'
[Unit]
Description=MyFiat API (ari-net app node)
After=network-online.target
Wants=network-online.target
[Service]
User=myfiat
WorkingDirectory=/opt/myfiat
EnvironmentFile=/etc/ari-net/app.env
ExecStart=/usr/local/bin/node src/server.js
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable myfiat >/dev/null 2>&1
restart_and_check
setup_firewall
mark_ready
