# Call or text Claude

**Calls:** Twilio ConversationRelay turns the caller's speech into text and sends it over a WebSocket to `server.js`. The server streams Claude's reply back, and Twilio speaks it to the caller.

**Texts:** Twilio posts each incoming SMS to `/sms`. The server replies with Claude's answer and keeps a short per-number history in memory.

Both webhooks check Twilio's request signature, so `TWILIO_AUTH_TOKEN` must be set.

## Setup

1. `cd backend && npm install`
2. `cp .env.example .env` and set `ANTHROPIC_API_KEY` and `TWILIO_AUTH_TOKEN`.
3. `npm start`, which listens on port 8080.
4. Expose it publicly, for example with `brew install cloudflared && cloudflared tunnel --url http://localhost:8080`. Put the hostname it prints (without `https://`) in `.env` as `PUBLIC_HOST`, then restart.
5. In the Twilio Console, open Phone Numbers → your number → Voice Configuration. Set "A call comes in" to **Webhook**, `https://<PUBLIC_HOST>/voice`, **HTTP POST**. Set "A message comes in" to `https://<PUBLIC_HOST>/sms`, **HTTP POST**.
6. Call or text the number.

Notes:
- To send texts to US phones, the number must be in an A2P 10DLC-registered Messaging Service.
- ConversationRelay may require accepting the AI/ML features addendum in the Twilio Console (Voice → Settings).

## Ari: calls, texts, and instance control

Ari is an always-on AI security engineer you can call or text at the Twilio number. On a call, Ari can control Linode compute instances through tools (list, shut down, boot) and asks before shutting anything down. Delete is intentionally not callable from a live call.

Scripts (run from `backend/`):
- `npm run call -- +1NUMBER ["opening line"] ["instructions"]` — Ari calls someone and holds a conversation.
- `npm run text -- +1NUMBER "message"` — Ari sends an SMS (from the A2P-registered number).
- `npm run drill -- +1NUMBER [instance-label]` — DDoS drill: simulates a traffic surge, then Ari calls to report it and, with your spoken OK, shuts the instance down. No real attack traffic is generated.

Extra env vars (see `.env.example`): `LINODE_API_TOKEN`, `TWILIO_NUMBER` (calls), `TWILIO_SMS_NUMBER` (texts), `TTS_PROVIDER`/`TTS_VOICE`.
