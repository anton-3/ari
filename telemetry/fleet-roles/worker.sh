#!/usr/bin/env bash
# worker: small settlement/reporting job that polls Postgres every few seconds.
# Needs DB_HOST and DB_PASS in /etc/ari-net/env.
. "$(dirname "$0")/common.sh"
apt_install python3 python3-psycopg2
install -m 0755 "$BUNDLE/fleet-roles/worker.py" /opt/ari-net/worker.py
(umask 077; printf 'DB_HOST=%s\nDB_PASS=%s\n' "$DB_HOST" "$DB_PASS" > /etc/ari-net/worker.env)
cat > /etc/systemd/system/ari-worker.service <<'UNIT'
[Unit]
Description=ari-net AcmePay settlement worker
After=network-online.target
[Service]
EnvironmentFile=/etc/ari-net/worker.env
ExecStart=/usr/bin/python3 -u /opt/ari-net/worker.py
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ari-worker >/dev/null 2>&1
systemctl restart ari-worker
setup_firewall
mark_ready
