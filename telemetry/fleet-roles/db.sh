#!/usr/bin/env bash
# db: PostgreSQL listening on localhost + the private IP only.
. "$(dirname "$0")/common.sh"
log "installing postgresql"
apt_install postgresql openssl
PGV=$(ls /etc/postgresql | sort -V | tail -1)
CONF=/etc/postgresql/$PGV/main
if [ ! -s /etc/ari-net/db.pass ]; then
  (umask 077; openssl rand -hex 24 > /etc/ari-net/db.pass)
fi
DBPASS=$(cat /etc/ari-net/db.pass)
mkdir -p "$CONF/conf.d"
cat > "$CONF/conf.d/ari-net.conf" <<PG
listen_addresses = 'localhost,$PRIV_IP'
max_connections = 60
PG
grep -q 'ari-net' "$CONF/pg_hba.conf" || \
  echo "host myfiat myfiat $PRIVATE_NET scram-sha-256 # ari-net" >> "$CONF/pg_hba.conf"
systemctl restart postgresql
for i in $(seq 1 30); do sudo -u postgres psql -qtAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'myfiat') THEN
    CREATE ROLE myfiat LOGIN;
  END IF;
END \$\$;
ALTER ROLE myfiat PASSWORD '$DBPASS';
SQL
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='myfiat'" | grep -q 1 || \
  sudo -u postgres createdb -O myfiat myfiat
setup_firewall
mark_ready
