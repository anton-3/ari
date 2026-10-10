# Call or text Claude

**Calls:** Twilio ConversationRelay turns the caller's speech into text and sends it over a WebSocket to `server.js`. The server streams Claude's reply back, and Twilio speaks it to the caller.

**Texts:** Twilio posts each incoming SMS to `/sms`. The server replies with Claude's answer and keeps a short per-number history in memory.

Both webhooks check Twilio's request signature, so `TWILIO_AUTH_TOKEN` must be set.

## Setup

1. `npm install`
2. `cp .env.example .env` and set `ANTHROPIC_API_KEY` and `TWILIO_AUTH_TOKEN`.
3. `npm start`, which listens on port 8080.
4. Expose it publicly, for example with `brew install cloudflared && cloudflared tunnel --url http://localhost:8080`. Put the hostname it prints (without `https://`) in `.env` as `PUBLIC_HOST`, then restart.
5. In the Twilio Console, open Phone Numbers → your number → Voice Configuration. Set "A call comes in" to **Webhook**, `https://<PUBLIC_HOST>/voice`, **HTTP POST**. Set "A message comes in" to `https://<PUBLIC_HOST>/sms`, **HTTP POST**.
6. Call or text the number.

Notes:
- To send texts to US phones, the number must be in an A2P 10DLC-registered Messaging Service.
- ConversationRelay may require accepting the AI/ML features addendum in the Twilio Console (Voice → Settings).
