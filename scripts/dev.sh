#!/usr/bin/env bash
# Launch the whole Ari stack locally in a tmux session.
#
# Windows (session "ari"):
#   telemetry  telemetry/        :8090   fleet/dashboard API
#   bank       target-app/       :8071   MyFiat demo bank API
#   customer   customer-ari/     :8072   customer-side Ari (MyFiat Assistant)
#   frontend   frontend/         :5173   Vite dashboard + landing
#   tunnel     cloudflared quick tunnel -> :8080 (Twilio /voice + /sms)
#   backend    backend/          :8080   Ari (starts last, after PUBLIC_HOST is set)
#
# The tunnel's public hostname is written to the repo-root .env as PUBLIC_HOST
# (no scheme) before the backend starts, so Twilio webhooks resolve.
#
# Usage:
#   scripts/dev.sh              start everything and attach
#   scripts/dev.sh --no-tunnel  skip cloudflared; backend uses the existing PUBLIC_HOST
#   scripts/dev.sh kill         kill the tmux session (and the quick tunnel)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION=ari
ENV_FILE="$ROOT/.env"
LOG_DIR="$ROOT/.dev-logs"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
TUNNEL_TARGET="http://localhost:8080"

die() { echo "error: $*" >&2; exit 1; }

if [ "${1:-}" = kill ]; then
  pkill -f "cloudflared tunnel --url $TUNNEL_TARGET" 2>/dev/null || true
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed session '$SESSION'" || echo "no session '$SESSION'"
  exit 0
fi

WITH_TUNNEL=1
[ "${1:-}" = --no-tunnel ] && WITH_TUNNEL=0

command -v tmux >/dev/null || die "tmux not found"
command -v node >/dev/null || die "node not found"
[ "$WITH_TUNNEL" = 1 ] && { command -v cloudflared >/dev/null || die "cloudflared not found (install it or pass --no-tunnel)"; }

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session '$SESSION' already running — attaching (use 'scripts/dev.sh kill' to restart)"
  [ -t 1 ] && exec tmux attach -t "$SESSION"
  echo "(no terminal; attach with: tmux attach -t $SESSION)"; exit 0
fi

# Install node deps for any service missing them (customer-ari ships without node_modules).
for d in telemetry target-app customer-ari frontend backend; do
  if [ -f "$ROOT/$d/package.json" ] && [ ! -d "$ROOT/$d/node_modules" ]; then
    echo ">>> installing deps in $d ..."
    (cd "$ROOT/$d" && npm install --no-audit --no-fund) || die "npm install failed in $d"
  fi
done

mkdir -p "$LOG_DIR"
: > "$TUNNEL_LOG"

# Each pane runs its service, then drops to a shell so a crash stays readable.
win() { # win <name> <workdir> <command>
  tmux new-window -t "$SESSION" -n "$1" -c "$ROOT/$2" \
    "echo '>>> $1: $3'; $3; echo; echo '[$1 exited — shell left open]'; exec \$SHELL"
}

# telemetry comes up first: backend and the bank lean on it.
tmux new-session -d -s "$SESSION" -n telemetry -c "$ROOT/telemetry" \
  "echo '>>> telemetry :8090'; npm start; echo; echo '[telemetry exited]'; exec \$SHELL"

win bank      target-app   "PORT=8071 npm start"
# customer-ari's npm start only loads ../backend/.env + ./.env; layer the repo-root
# .env for shared secrets (OPENAI_API_KEY etc) and pin PORT so it doesn't inherit 8080.
win customer  customer-ari "PORT=8072 node --env-file-if-exists=../.env --env-file-if-exists=../backend/.env --env-file-if-exists=.env server.js"
win frontend  frontend     "npm run dev"

if [ "$WITH_TUNNEL" = 1 ]; then
  tmux new-window -t "$SESSION" -n tunnel -c "$ROOT" \
    "echo '>>> cloudflared quick tunnel -> $TUNNEL_TARGET'; cloudflared tunnel --url $TUNNEL_TARGET 2>&1 | tee '$TUNNEL_LOG'; exec \$SHELL"

  echo "waiting for the tunnel hostname..."
  HOST=""
  for _ in $(seq 1 60); do
    # `|| true`: under `set -e`+pipefail an empty grep (host not printed yet) would otherwise kill the script.
    HOST="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 | sed 's#https://##' || true)"
    [ -n "$HOST" ] && break
    sleep 1
  done
  if [ -n "$HOST" ]; then
    if grep -q '^PUBLIC_HOST=' "$ENV_FILE" 2>/dev/null; then
      sed -i "s#^PUBLIC_HOST=.*#PUBLIC_HOST=$HOST#" "$ENV_FILE"
    else
      printf '\nPUBLIC_HOST=%s\n' "$HOST" >> "$ENV_FILE"
    fi
    echo "PUBLIC_HOST=$HOST  (point Twilio voice+SMS webhooks at https://$HOST/voice and /sms)"
  else
    echo "WARNING: no tunnel hostname yet; starting backend with the existing PUBLIC_HOST."
    echo "         check the 'tunnel' window, then edit .env and restart the backend window."
  fi
fi

# backend last, so it reads the fresh PUBLIC_HOST.
win backend backend "npm start"

tmux select-window -t "$SESSION:telemetry"
echo
echo "stack up in tmux session '$SESSION'. attach: tmux attach -t $SESSION"
[ -t 1 ] && exec tmux attach -t "$SESSION"
echo "(no terminal attached; run 'tmux attach -t $SESSION' to see the panes)"
