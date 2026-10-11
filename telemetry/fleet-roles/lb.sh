#!/usr/bin/env bash
# lb: nginx on :80 proxying to every app node's private IP:3000.
# The controller rewrites /etc/nginx/ari-net-upstream.conf as apps come and go.
. "$(dirname "$0")/common.sh"
log "installing nginx"
apt_install nginx
UP=/etc/nginx/ari-net-upstream.conf
# Placeholder until the controller syncs real app nodes (returns 502).
[ -s "$UP" ] || echo 'server 127.0.0.1:65535 max_fails=0;' > "$UP"
cat > /etc/nginx/conf.d/ari-net-log.conf <<'NG'
# epoch status client "request" bytes upstream request_time  (read by the ari-net collector)
log_format arinet '$msec $status $remote_addr "$request" $body_bytes_sent $upstream_addr $request_time';

# Rate-limit zone insertion point (http context). A security PR adds a
# `limit_req_zone ... zone=ari_rl:10m rate=10r/s;` directive on the line below.
    # ari:rate-limit-zone
NG

# Incident-response placeholders: real client IP + IP blocklist. The controller
# rewrites this file (and ari-net-blocklist.conf) via the block-ips endpoint.
[ -s /etc/nginx/ari-net-blocklist.conf ] || echo '# ari-net incident blocklist' > /etc/nginx/ari-net-blocklist.conf
[ -s /etc/nginx/conf.d/ari-net-incident.conf ] || cat > /etc/nginx/conf.d/ari-net-incident.conf <<'NG'
# ari-net incident response — managed by the fleet controller. Do not edit by hand.
include /etc/nginx/ari-net-blocklist.conf;
NG
cat > /etc/nginx/sites-available/acmepay <<'NG'
upstream acmepay {
  include /etc/nginx/ari-net-upstream.conf;
  keepalive 32;
}
server {
  listen 80 default_server;
  server_name _;
  access_log /var/log/nginx/ari-access.log arinet;
  keepalive_requests 10000;
  location = /nginx-health { return 200 "ok\n"; }
  location / {
        # ari:rate-limit-apply
    proxy_pass http://acmepay;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;   # real/spoofed client IP (via real_ip) to the app
    proxy_next_upstream error timeout http_502;
    proxy_connect_timeout 2s;
  }
}
NG
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/acmepay /etc/nginx/sites-enabled/acmepay
# (Ubuntu's stock logrotate rule for /var/log/nginx/*.log rotates ari-access.log daily.)
nginx -t
systemctl enable --now nginx >/dev/null 2>&1
systemctl reload nginx
setup_firewall 80/tcp
mark_ready
