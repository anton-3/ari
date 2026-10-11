# MyFiat Assistant

The **customer-side** AI companion for the MyFiat demo bank — a warm, proactive
banking assistant that lives in the MyFiat app. It tells customers their
balances, where their money went, their subscriptions (flagging wasteful ones),
how their stocks and crypto are doing, upcoming bills, and it takes actions on
request (renew/freeze a card, cancel a subscription, dispute a charge). It can
also **proactively call** a customer about a suspicious charge.

> Fictional demo, synthetic data only. This is a **separate service** from the
> enterprise security assistant ("Ari") in `../backend/`. It has a consumer
> persona and **none** of the infra/security tools (no Linode, no agent swarm,
> no incident IP blocking).

## How it works

```
MyFiat web UI ──POST /assistant/chat──▶ MyFiat Assistant (:8072) ──Bearer token──▶ MyFiat API (:8071)
Twilio call  ──POST /voice, WS /relay─▶        (chat model + tools)
```

The assistant uses the hackathon chat model with a MyFiat-customer persona and a
set of **tools** that call the MyFiat API *as the signed-in user* (the caller's
Bearer token is threaded through every tool call). It never invents data; if the
API is down it says so and offers to retry.

## Run it

```bash
cd customer-ari
npm install
npm start           # listens on :8072
```

### Env

Shared secrets (inference key, Twilio creds, ElevenLabs voice) are read from
**`../backend/.env`** automatically by the npm scripts, then **`./.env`** is
layered on top for anything specific to this service. Copy `.env.example` to
`.env` and set at least:

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `8072` | chat + voice server port |
| `MYFIAT_API_URL` | `http://localhost:8071` | the MyFiat app's API (sibling service) |
| `PUBLIC_HOST` | — | this service's **own** tunnel hostname for the voice flow |
| `DEMO_PHONE` | `+19132658472` | who the suspicious-charge call dials |
| `MYFIAT_TOKEN` | — | a user's Bearer token so the voice call can read alerts + act |
| `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`CHAT_MODEL` | from backend/.env | inference |
| `TWILIO_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_NUMBER` | from backend/.env | voice |

## 1. Text chat

```
POST /assistant/chat
{ "message": "what are my subscriptions?", "token": "<user bearer>", "history": [ {role,content}, ... ] }
->
{ "reply": "You've got 4 subscriptions, about $48/month ...",
  "actions": [ { "tool": "cancel_subscription", "args": {...}, "result": "Cancelled ..." } ] }
```

- `history` is optional (prior `{role:"user"|"assistant", content}` turns).
- `actions` lists any **state-changing** tool that ran this turn, so the web UI
  can render action chips. Read-only tools aren't listed.
- Always returns 200 with a graceful `reply` even if the model/API hiccups.

Try it from the terminal (server must be running):

```bash
MYFIAT_TOKEN=<token> npm run chat
```

### Tools

Read: `get_overview`, `get_net_worth`, `get_recent_transactions`,
`get_spending_breakdown` (category breakdown + "how much on coffee this month"),
`get_insights`, `list_subscriptions` (flags wasteful/price-hiked subs),
`get_upcoming_bills`, `get_portfolio` (stocks + crypto, best/worst),
`list_cards` (flags expiring/frozen), `list_alerts`.

Actions (persona confirms first; surfaced as chips): `renew_card`,
`freeze_card`, `unfreeze_card`, `cancel_subscription`, `dispute_charge`,
`resolve_alert`.

## 2. Voice — the suspicious-charge call

The assistant calls the customer, references a real `suspicious_charge` alert
from `GET /api/alerts`, asks if they recognize the charge, and if not offers to
**freeze the card** and **dispute the charge**, doing both via the tools and
confirming out loud.

```bash
# needs this service's own cloudflared tunnel to :8072, with PUBLIC_HOST set to it
MYFIAT_TOKEN=<token> npm run alert-call -- +1XXXXXXXXXX   # defaults to DEMO_PHONE
```

`/voice` (Twilio webhook) + `/relay` (WebSocket) mirror the backend's
ConversationRelay pattern. The greeting/steering prompt/token are passed as
ConversationRelay `<Parameter>`s so the call can read the alert and act as the
user.

**Tunnel:** this service needs its **own** public tunnel, separate from the
enterprise backend's. At demo time:

```bash
cloudflared tunnel --url http://localhost:8072
# put the printed hostname in ./.env as PUBLIC_HOST=...
```

### Simulate the call locally (no phone)

```bash
npm start                                   # terminal 1
MYFIAT_TOKEN=<token> npm run sim -- --suspicious   # terminal 2: talk to the relay over a WS
```

## Notes on the MyFiat API contract

Tools read defensively: lists may be bare arrays or wrapped (`{subscriptions:[…]}`),
and money may be in cents (`*_cents`) or dollars — see `myfiat.js`. If the sibling
service finalizes exact field names, the helpers in `myfiat.js`/`tools.js` are the
only place to adjust.
