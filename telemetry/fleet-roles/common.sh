#!/usr/bin/env bash
# Shared setup for every ari-net node. Sourced by each <role>.sh.
# The controller uploads this bundle to /opt/ari-net/bundle and writes
# /etc/ari-net/env (ROLE, LABEL, PRIV_IP, plus role-specific values) first.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
umask 022
mkdir -p /etc/ari-net
set -a; . /etc/ari-net/env; set +a
BUNDLE=/opt/ari-net/bundle
PRIVATE_NET=192.168.128.0/17   # Linode private network range

log() { echo "[ari-net:$ROLE] $*"; }

# Let first-boot cloud-init / unattended-upgrades finish with apt.
if command -v cloud-init >/dev/null 2>&1; then timeout 300 cloud-init status --wait >/dev/null 2>&1 || true; fi
APT="apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold"
apt_install() {
  $APT update >/dev/null
  $APT install --no-install-recommends "$@" >/dev/null
}

$APT update >/dev/null || true   # fresh package lists (also used by the security-updates check)
hostnamectl set-hostname "$LABEL" || true
# Services bind to the private IP; allow that even if eth0 comes up late.
echo 'net.ipv4.ip_nonlocal_bind = 1' > /etc/sysctl.d/60-ari-net.conf
sysctl -q -p /etc/sysctl.d/60-ari-net.conf || true

# Firewall: SSH from anywhere, everything else only from the private network.
# Roles may open more (lb opens 80).
setup_firewall() {
  command -v ufw >/dev/null || apt_install ufw
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow from "$PRIVATE_NET" >/dev/null
  for p in "$@"; do ufw allow "$p" >/dev/null; done
  ufw --force enable >/dev/null
}

install_node20() {
  local v=v20.18.1
  if ! /usr/local/bin/node -v 2>/dev/null | grep -q '^v20\.'; then
    log "installing node $v"
    curl -fsSL "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  fi
}

mark_ready() { echo "$ROLE" > /etc/ari-net/ready; log "ready"; }
