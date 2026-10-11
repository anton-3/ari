#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
file="$dir/fleet-roles/lb.sh"
grep -Fq 'limit_req_zone $binary_remote_addr zone=ari_rl:10m rate=10r/s;' "$file"
grep -Fq 'limit_req zone=ari_rl burst=20 nodelay;' "$file"
grep -Fq 'limit_req_status 429;' "$file"
bash -n "$file"
# Run on a machine with nginx installed (for example the owned load balancer).
nginx -t -c "$dir/rate-limit-validation.conf"
