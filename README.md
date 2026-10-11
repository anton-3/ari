# Ari: an always-on AI security engineer you can talk to

Ari watches a team's code, cloud and live traffic. It checks what it finds and **phones the on-call engineer** when an attack needs a human decision.
On the call, the engineer can say "yes, ban them" or "add capacity" and Ari does it on real Akamai Cloud infrastructure.
Afterwards Ari opens a pull request with the fix and emails a postmortem.

To show this end to end, we built **MyFiat**, a fictional bank whose security Ari watches.
It runs on a real fleet of Linode servers with real traffic, a large Postgres dataset and some deliberately planted vulnerabilities.
MyFiat also has its own customer-facing assistant, which calls customers about suspicious charges.

---

## How we use Akamai Cloud

| Akamai resource | What runs on it |
| --- | --- |
| **Akamai-hosted AI inference** (OpenAI-compatible endpoint, `hackathon-chat` / Qwen) | Every reply from Ari and the MyFiat Assistant, all tool calling during live phone calls, SMS replies, and generated postmortems. We benchmarked it (110 requests, about 968k tokens) to tune prompt sizes for voice latency. See [benchmarks/akamai/](benchmarks/akamai/). |
| **Dedicated CPU Linode** (`g8-dedicated-16-4`, Chicago `us-ord`) | Our "voice server". It runs self-hosted **Kokoro-82M text-to-speech** and **NVIDIA Parakeet-TDT speech-to-text** on CPU with no GPU, plus Ari's backend, the MyFiat bank and the customer assistant, all behind Caddy with automatic HTTPS. A Cloud Firewall protects it (default DROP; only 22, 80 and 443 open). |
| **`ari-net` fleet of Linodes** (Nanodes, plus a larger plan for the database) | MyFiat's production-style topology: nginx load balancer → N app nodes → PostgreSQL + Redis, a background worker, and traffic/community generators. They talk over **private IPs**, and ufw allows database and cache ports only from the private network. |
| **Linode API v4** | Ari provisions, boots, shuts down, reboots and resizes instances, both from the dashboard and **by voice during a call**. The fleet controller reconciles nodes by tag (`ari-net`, `role:<role>`). Linode account event emails also feed the demo. |

Without Akamai, nothing in the demo would run: the model that reasons, the servers that speak and listen, and the infrastructure under attack all live on Akamai Cloud.

## Akamai Cloud Challenge Description

### 1. Impact & usefulness
- **The problem is large and getting worse.** The FBI IC3 reports internet crime losses rising from $4.2B (2020) to **$20.9B (2025)**. The landing page charts this from the [2025 IC3 Annual Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf).
- **Security alerts are easy to miss, and slow responses are expensive.** Alerts land in dashboards nobody watches at 3 a.m. Ari gets in touch with you directly by phone or text and has the evidence ready. It does the work once you say yes, so a person stays in control of every disruptive action.
- **Two audiences:** engineering teams (incident response, finding vulnerabilities, rate-limit fixes, postmortems) and the bank's own customers (the MyFiat Assistant checks balances and subscriptions, freezes cards, disputes charges, and **calls you about a suspicious charge**).

### 2. Powered by Akamai
- All language-model inference goes through **Akamai's hosted inference endpoint** ([backend/server.js](backend/server.js), [customer-ari/server.js](customer-ari/server.js)).
- Speech-to-text and text-to-speech are **self-hosted on an Akamai Dedicated CPU Linode** instead of paid third-party voice APIs ([voice-stt/](voice-stt/), [docs/KOKORO_LINODE_SETUP.md](docs/KOKORO_LINODE_SETUP.md)). Measured median first audio is about 0.64 s for streamed speech.
- The infrastructure Ari defends is **real Linode compute** that Ari manages through the Linode API ([telemetry/src/fleet/](telemetry/src/fleet/), [backend/linode.js](backend/linode.js)).

### 3. Technical execution
- **Real detection, real mitigation.** Every 2 s the controller reads the load balancer's nginx access log over SSH and flags a DDoS when multiple outside IPs push traffic well above baseline. Ari's `block_ips` writes `deny` rules on the load balancer and reloads nginx. `scale_web_app` brings a standby app node into rotation. `open_rate_limit_pr` makes a branch, adds nginx `limit_req`, opens a GitHub PR and texts the caller.
- **Live observability.** One multiplexed SSH round trip per node every ~2 s collects CPU, memory, disk, listening ports and per-socket TCP byte counters. Ari computes the links between nodes, and per-route RPS, error rates and p95 latency, from real traffic.
- **A voice stack that keeps working when parts fail.** Twilio Media Streams → Parakeet STT → Akamai inference → Kokoro TTS, with barge-in (talking over Ari stops it). If STT or TTS fails mid-call, the call moves to Twilio ConversationRelay and keeps its session context and tool results.
- **Safety rails.** Delete can't be called from a phone call. Fleet deletes require the `ari-net` tag, an `ari-net-` label and the exact label echoed back, and protected instances are denylisted. Fleet APIs accept only localhost connections. The attack drill can target only our own load balancer and has hard caps (≤ 60 s, ≤ 6000 requests, ≤ 16 concurrent). Twilio webhooks check request signatures.
- **Tests and operations.** There are Node test suites for the backend and telemetry, pytest for the fleet scripts, a Playwright API + UI suite for MyFiat ([e2e/](e2e/)), and a `voice:smoke` end-to-end check of the voice pipeline. `./fleet` deploys, monitors and tails logs for every service from any teammate's machine.

### 4. Creativity & innovation
- **A phone call is the interface.** Instead of another dashboard, the security engineer calls *you*. It speaks naturally, lets you interrupt it, and acts on a spoken "yes".
- **A complete incident loop** from start to finish: detect → call → approve → block + scale → PR + SMS → emailed postmortem built only from what actually happened.
- **A live, explorable map of the infrastructure.** An isometric view of the real fleet animates real traffic. You can click into a server to see its deployed files, then routes and functions with their live request rates. For the database you see tables and columns, and for nginx its config blocks. Security findings are pinned to the exact code symbol.
- **Ari's helper agents.** Ari sends scanner, log-watcher, verifier and remediator agents onto real nodes and narrates what they're doing.
- **The bank has an Ari too.** The same voice and tool engine, in a consumer persona, protects the bank's customers.

---

## Architecture

```
                     ┌──────────────── Phone (Twilio voice + SMS) ────────────────┐
                     │                                                            │
                     ▼                                                            ▼
 ┌─────────── Voice server: Akamai Dedicated CPU Linode (us-ord, Caddy HTTPS) ───────────┐
 │  Ari backend :8080 ──── Parakeet STT :8001     Kokoro TTS :8000                       │
 │      │  ▲                                                                             │
 │      │  └──── MyFiat Assistant (customer-ari) :8072 ──▶ MyFiat bank API + UI          │
 └──────┼────────────────────────────────────────────────────────────────────────────────┘
        │ OpenAI-compatible API                     │ HTTP / SSH tunnel
        ▼                                           ▼
 Akamai hosted inference                 Telemetry + fleet controller :8090 ◀── React frontend
 (Qwen, "hackathon-chat")                    │  Linode API v4      │ SSH (collector, bootstrap,
                                             ▼                     ▼  blocklists, rewiring)
                                 ┌──────────── ari-net fleet (Linode, private network) ──────────┐
                                 │ traffic ─▶ lb (nginx) ─▶ app-1..N (MyFiat) ─▶ db (Postgres)   │
                                 │ community ─▶ lb           │                └─▶ cache (Redis)  │
                                 │                     worker ─▶ db                              │
                                 └───────────────────────────────────────────────────────────────┘
```

### Frontend ([frontend/](frontend/)), React 19 + TypeScript + Vite
The Vite build has several entry points:
- **Landing page** (`index.html`): hero, an animated "how it works" topology that plays an incident step by step, the IC3 cybercrime-losses chart, and a "simulate" section that sets off a demo call.
- **Dashboard** (`dashboard.html`): the live infrastructure map, active-users chart, findings panel (vulnerabilities by severity and status), Ari's activity feed (its narration plus agent events), Ari's contact details (QR code) and a demo reset control. It reads the telemetry REST API and WebSocket. If telemetry is unreachable it shows clearly labeled demo data and recovers automatically when telemetry comes back.
- **Fleet graph** (`graph.html`): the full-screen isometric fleet map (servers → files → symbols, with live link throughput). `looks.html` shows the same data in alternative visual styles.
- **MyFiat web app** ([target-app/public/](target-app/public/)): the bank's own HTML/JS UI (dashboard, cards, subscriptions, investments, insights), with the customer assistant built in.

### Backend services
| Service | Stack | Role |
| --- | --- | --- |
| **Ari** ([backend/](backend/)) | Node, Express, OpenAI SDK, Twilio | Voice (`/voice`, Media Streams WebSocket) and SMS (`/sms`) webhooks; the conversation and tool loop on Akamai inference. Tools cover Linode instances, live metrics, incidents, IP blocking, scaling, agents and the rate-limit PR. Also handles incident calls (`/incident`), postmortems emailed via nodemailer, and scripted scenarios. |
| **Telemetry + fleet controller** ([telemetry/](telemetry/)) | Node, `ws`, system `ssh` | Provisions and bootstraps the `ari-net` fleet over the Linode API and SSH, keeps the nginx upstream and db/cache wiring in sync, collects metrics, raises issues (exposure, brute force, 5xx, outdated packages, code vulnerabilities), detects DDoS, runs agent jobs, and serves `/api/*` + `/ws` to the dashboard and Ari. |
| **MyFiat** ([target-app/](target-app/)) | Node, Express, PostgreSQL / SQLite, Redis | The demo bank's REST API (accounts, cards, subscriptions, holdings, trades, alerts, disputes) with planted vulnerabilities ([SECURITY-NOTES.md](target-app/SECURITY-NOTES.md)). |
| **MyFiat Assistant** ([customer-ari/](customer-ari/)) | Node, Akamai inference, Twilio | The customer-facing chat and voice assistant. Its tools call the MyFiat API with the signed-in user's token. It also places suspicious-charge alert calls. |
| **Speech-to-text** ([voice-stt/](voice-stt/)) | Python, sherpa-onnx, Silero VAD | Parakeet-TDT 0.6B (int8 ONNX) on CPU. It uses Deepgram's streaming protocol, so the backend can switch providers by changing configuration. |
| **Text-to-speech** ([docs/KOKORO_LINODE_SETUP.md](docs/KOKORO_LINODE_SETUP.md)) | Python, FastAPI, ONNX Runtime | Kokoro-82M on CPU. Authenticated; returns a buffered WAV or streams PCM segment by segment. |
| **Fleet roles** ([telemetry/fleet-roles/](telemetry/fleet-roles/)) | bash + Python | Idempotent per-role setup scripts for each node, plus the traffic, worker and community-banking simulators. |

### What happens during an incident
1. The traffic generator and community simulator send normal requests through the load balancer, which sets the baseline.
2. A capped drill ([initiate_ddos_attack.py](initiate_ddos_attack.py)) floods **our own** load balancer from five synthetic attacker IPs.
3. The controller sees the spike in the nginx logs and raises a `ddos` issue. Ari calls the on-call engineer.
4. When the engineer approves, Ari bans the IPs at nginx and scales the web app. If the engineer asks, it opens a rate-limit PR and texts the link.
5. After the call, Ari writes a postmortem from the transcript, the tool actions and the incident data, and emails it to the team.

---

## Repository layout

- [frontend/](frontend/): landing page, dashboard and fleet graph (React + Vite)
- [backend/](backend/): Ari's voice/SMS server and tools. Setup is in [backend/README.md](backend/README.md)
- [telemetry/](telemetry/): telemetry API, fleet controller and fleet role scripts
- [target-app/](target-app/): MyFiat, the demo bank
- [customer-ari/](customer-ari/): MyFiat Assistant, the customer-side Ari
- [voice-stt/](voice-stt/): self-hosted speech-to-text
- [e2e/](e2e/): Playwright tests for MyFiat
- [benchmarks/akamai/](benchmarks/akamai/): Akamai inference latency benchmark
- [docs/](docs/): Kokoro-on-Linode setup and local development setup

## Running the stack: `./fleet`

Everything (Ari, the MyFiat bank, customer-side Ari, Kokoro) runs on the voice server over HTTPS.
`./fleet` controls all of it from any machine with SSH access; secrets stay on the server, so no `.env` is needed.

```bash
./fleet status            # health of every service and endpoint
./fleet deploy ari        # push local code (ari | bank | customer | stt | all) and restart
./fleet logs ari -f       # follow logs
./fleet call +15551234567 # Ari calls someone
./fleet help              # everything else
```

New teammate: send your public key (`cat ~/.ssh/id_ed25519.pub`) to someone with access, who runs `./fleet add-key "<key>"`.

To run everything locally instead, use `scripts/dev.sh`, which starts every service in a tmux session. See [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).
