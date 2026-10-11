# Run Ari locally

The local app has four processes: the React dashboard (5173), telemetry (8090),
Ari's voice/backend server (8080), and the MyFiat target app (8070).
The full incident demo also uses a real Linode fleet; the local MyFiat instance
does not populate the dashboard's nginx request counters or infrastructure map.

## 1. Install dependencies

Use Node.js **22.19+** (Node 24 works), npm, Git, and Python 3. Have `ssh`,
`tar`, and a C++ build toolchain available for fleet access and SQLite installation.
For phone calls, install `cloudflared`; for PR creation, install the GitHub CLI
(`gh`) and authenticate with push access to the repository.

```bash
git clone https://github.com/anton-3/hackmid2026.git
cd hackmid2026
for dir in frontend backend telemetry target-app; do
  (cd "$dir" && npm ci) || exit 1
done
(cd target-app && npm run seed)
```

Run the seed command once for a fresh local database. PostgreSQL and Redis are
optional locally; MyFiat uses SQLite by default.

## 2. Configure the backend

From the repo root:

```bash
cp backend/.env.example .env
```

Edit this private root `.env`:

```dotenv
ARI_VOICE_STACK=twilio
OPENAI_BASE_URL=https://ws.akamai-workshops.com/v1
OPENAI_API_KEY=<your workshop inference key>
CHAT_MODEL=hackathon-chat
TWILIO_SID=<your account SID>
TWILIO_AUTH_TOKEN=<your account token>
TWILIO_NUMBER=<your voice-capable number in +E.164 format>
TWILIO_SMS_NUMBER=<your SMS-capable number in +E.164 format>
DEMO_PHONE=<the phone that should receive incident calls and PR texts>
PUBLIC_HOST=<public tunnel hostname, set in step 4>
LINODE_API_TOKEN=<token for the owned ari-net fleet, if using the full demo>
```

The inference URL/model above are the repository's workshop defaults. If using
another OpenAI-compatible provider, change both to its endpoint and model.
An inference key is required to start the backend; Twilio credentials are needed
for actual calls/texts. Twilio mode needs no local STT/TTS server or FFmpeg.

Backend npm scripts load root `.env`, then `backend/.env`; the latter overrides
root values, including blank entries. Shell variables override both. Prefer one
root file and leave `backend/.env` absent. Keep secrets out of frontend variables.

Optional postmortem email uses `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and
`POSTMORTEM_TO` (comma-separated recipients). Set recipients explicitly before
enabling email; otherwise the code uses its built-in team list.

## 3. Start the four services

Run each command in its own terminal or tmux window, **from the repo root**:

```bash
# MyFiat — http://localhost:8070
cd target-app && npm start
```

```bash
# Ari — http://localhost:8080
cd backend && npm start
```

```bash
# Telemetry — http://localhost:8090
cd telemetry && npm start
```

```bash
# Dashboard — http://localhost:5173/dashboard.html
cd frontend && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open **http://localhost:5173/dashboard.html**. `/` is the landing page.
The frontend defaults to telemetry at `http://localhost:8090`; override with
`VITE_TELEMETRY_URL` in `frontend/.env.local` if needed, then restart Vite.
`VITE_ARI_PHONE` controls the dashboard's displayed public contact number.

## 4. Enable phone calls

Keep a fifth terminal running:

```bash
cloudflared tunnel --url http://127.0.0.1:8080 --protocol http2 --edge-ip-version 4
```

Copy the printed `*.trycloudflare.com` hostname into root `.env` as `PUBLIC_HOST`
**without `https://`**, then restart the backend. Quick-tunnel hostnames change
when the tunnel restarts; update `PUBLIC_HOST` and any configured Twilio webhooks.

For inbound calls/texts, configure the Twilio number's POST webhooks as
`https://<PUBLIC_HOST>/voice` and `https://<PUBLIC_HOST>/sms`. Enable
ConversationRelay/accept its AI/ML addendum in Twilio. Use an SMS sender approved
for your destination (US messaging may require A2P registration).

## 5. Prepare the full incident demo

Use a Linode account containing the owned fleet, with root SSH access using
`~/.ssh/id_ed25519` and its `.pub` file. The fleet discovers instances tagged
`ari-net` with `role:db`, `role:cache`, `role:lb`, `role:app`, `role:traffic`,
and `role:worker`. It needs two serving app nodes; preparation adds/reuses
`web-03` as a warm standby. See [fleet provisioning](../telemetry/README.md#how-provisioning-works)
if starting with an empty cloud account. Provisioning creates real billable nodes.

Authenticate `gh auth login` and ensure Git's `origin` permits pushing. The PR
tool defaults to `anton-3/hackmid2026`, `origin/main`, and a validated nginx patch.
Leave `TELEMETRY_SIM` unset for real request metrics. Start telemetry with
`DEMO_CALLS_ENABLED=0 npm start` if automatic incident calls should be disabled.

```bash
cd backend
npm run demo -- prepare
# Allow about three minutes for a clean real-traffic baseline.
npm run demo -- preflight
```

After preflight passes, run `python3 initiate_ddos_attack.py` **from the repo root**.
To prepare another take, click the dashboard's top-right **live** status and
confirm the reset. The popup reports cleanup, PR/branch removal, traffic cooldown,
and readiness. Leave web-03 powered on: hidden warm standby is required for fast
activation. Reset closes the latest demo PR; its GitHub history remains.

## Verify and restart

```bash
curl -fsS http://localhost:8070/health
curl -fsS http://localhost:8090/health
curl -fsS http://localhost:8080/health/voice
```

Voice health should report `stack: "twilio"` and `incidentGreetingReady: true`.
For the full demo, also run `npm run demo -- preflight` from `backend/`.
An empty fleet or unavailable request feed shows missing metrics; it does not
silently substitute fake traffic. Check Linode credentials, SSH access, and demo
preparation if the map/counters are empty.

Keep one instance of each service. Stop with Ctrl+C and rerun its start command
after code or configuration changes. The existing workspace uses tmux session
`hackmid2026`: windows 0–4 are frontend, telemetry, backend, MyFiat, and tunnel.
Use `tmux attach -t hackmid2026` to manage them. On a fresh machine, create a
session with `tmux new -s hackmid2026` and open a window for each command.
