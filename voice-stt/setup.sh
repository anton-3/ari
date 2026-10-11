#!/bin/bash
# Install the self-hosted STT (Parakeet-TDT 0.6B v2 int8 + Silero VAD, CPU) on the voice-model node.
# Run as root on the node:  STT_API_KEY=... bash setup.sh
# Serves ws://127.0.0.1:8001/v1/listen. A backend on the same node uses that URL directly (STT_URL).
# For remote clients, route /v1/listen on the Kokoro site in /etc/caddy/Caddyfile, ahead of its proxy:
#   handle /v1/listen { reverse_proxy 127.0.0.1:8001 }
set -euo pipefail
: "${STT_API_KEY:?set STT_API_KEY}"
DIR=/opt/ari-stt
REL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models
MODEL=sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8

command -v bzip2 >/dev/null || { apt-get update -qq && apt-get install -y -qq bzip2; }  # model archive is .tar.bz2
id ari-stt >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin ari-stt
mkdir -p "$DIR/models"
cp "$(dirname "$0")/server.py" "$DIR/server.py"
[ -d "$DIR/venv" ] || python3 -m venv "$DIR/venv"
"$DIR/venv/bin/pip" -q install --upgrade sherpa-onnx==1.13.8 numpy websockets==17.2
cd "$DIR/models"
[ -f silero_vad.onnx ] || curl -fsSL -o silero_vad.onnx "$REL/silero_vad.onnx"
[ -d "$MODEL" ] || curl -fsSL "$REL/$MODEL.tar.bz2" | tar xj
rm -rf "$MODEL/test_wavs"
chown -R ari-stt:ari-stt "$DIR"

install -m 600 /dev/null /etc/ari-stt.env
printf 'STT_API_KEY=%s\nSTT_THREADS=4\n' "$STT_API_KEY" > /etc/ari-stt.env

cat > /etc/systemd/system/ari-stt.service <<'UNIT'
[Unit]
Description=Ari self-hosted STT (Deepgram-compatible /v1/listen)
After=network-online.target
Wants=network-online.target
[Service]
User=ari-stt
WorkingDirectory=/opt/ari-stt
EnvironmentFile=/etc/ari-stt.env
ExecStart=/opt/ari-stt/venv/bin/python server.py
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ari-stt
systemctl restart ari-stt
for i in $(seq 1 60); do ss -ltn | grep -q '127.0.0.1:8001 ' && break; sleep 1; done
journalctl -u ari-stt --no-pager -n 3 | grep -v resampler || true
ss -ltn | grep -q '127.0.0.1:8001 ' || { echo "ari-stt did not start" >&2; exit 1; }
