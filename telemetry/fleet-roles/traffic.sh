#!/usr/bin/env bash
# traffic: steady, modest request mix against the lb's private IP.
# Intensity comes from /etc/ari-net/traffic.mode ("normal" | "surge").
. "$(dirname "$0")/common.sh"
command -v python3 >/dev/null || apt_install python3
install -m 0755 "$BUNDLE/fleet-roles/traffic.py" /opt/ari-net/traffic.py
[ -s /etc/ari-net/traffic.mode ] || echo "${MODE:-normal}" > /etc/ari-net/traffic.mode
cat > /etc/systemd/system/ari-traffic.service <<UNIT
[Unit]
Description=ari-net load generator -> lb
After=network-online.target
[Service]
Environment=LB_HOST=$LB_HOST
ExecStart=/usr/bin/python3 -u /opt/ari-net/traffic.py
Restart=always
RestartSec=2
DynamicUser=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ari-traffic >/dev/null 2>&1
systemctl restart ari-traffic
setup_firewall
mark_ready
