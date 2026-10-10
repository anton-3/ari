#!/usr/bin/env bash
# cache: Redis on localhost + the private IP, password protected.
. "$(dirname "$0")/common.sh"
log "installing redis"
apt_install redis-server openssl
if [ ! -s /etc/ari-net/redis.pass ]; then
  (umask 077; openssl rand -hex 24 > /etc/ari-net/redis.pass)
fi
RC=/etc/redis/redis.conf
sed -i -E "s/^bind .*/bind 127.0.0.1 $PRIV_IP/" "$RC"
sed -i -E '/^# ari-net$/,$d' "$RC"
{
  echo '# ari-net'
  echo "requirepass $(cat /etc/ari-net/redis.pass)"
  echo 'maxmemory 64mb'
  echo 'maxmemory-policy allkeys-lru'
  echo 'protected-mode yes'
} >> "$RC"
chown redis:redis "$RC"; chmod 640 "$RC"
systemctl enable redis-server >/dev/null 2>&1
systemctl restart redis-server
setup_firewall
mark_ready
