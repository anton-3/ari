# Call or text Ari

**Calls:** `ARI_VOICE_STACK=twilio` uses Twilio ConversationRelay with Deepgram Nova-3 transcription and ElevenLabs speech. `ARI_VOICE_STACK=custom` uses Twilio Media Streams with the two models on the voice-model node: self-hosted Parakeet transcription (`voice-stt/`) and the Kokoro service. Both share Ari's Qwen conversation and tool engine. The model currently returns a complete reply before speech starts; custom mode then streams the audio.

**Texts:** Twilio posts each incoming SMS to `/sms`. The server replies with Qwen's answer and keeps a short per-number history in memory.

Both webhooks check Twilio's request signature, so `TWILIO_AUTH_TOKEN` must be set.

## Setup

1. Use Node 22.19+ (Node 24 recommended), then `cd backend && npm install`
2. `cp .env.example .env` and set `OPENAI_API_KEY`, `TWILIO_SID` and `TWILIO_AUTH_TOKEN`. The npm scripts load the repo-root `.env`, then `backend/.env`, whose values override the root file. Shell variables override both. Blank entries in `backend/.env` also override root values: remove unused blank entries when inheriting credentials.
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

## Ari's tools (expanded)

On a call, Ari can now use these tools (see `linode.js` and `actions.js`):
- Instances: `list_instances`, `provision_instances` (spin up new nodes; sensible defaults, honors size/region if asked), `shutdown_instance`, `boot_instance`.
- Live data: `get_live_metrics`, `report_vulnerability` — these talk to the telemetry service (`TELEMETRY_URL`, default http://localhost:8090); findings posted this way appear on the dashboard live.
- Live fleet actions: `get_incident`, `block_ips`, `scale_web_app`, `open_rate_limit_pr`. These can change real infrastructure or create a PR.
- Hardening: `rollback_commit` (revert branch + real GitHub PR, texted), `rotate_secret` (new Stripe key or session secret deployed to every app node with a rolling restart), `close_ports` (ufw: public access denied, private network kept, verified by an outside probe).

`npm run cleanup-nodes` deletes every instance Ari provisioned (tag `ari-provisioned`); the target app is left alone.

Scenarios beyond the DDoS drill live in `scenarios/` — run `node --env-file-if-exists=../.env --env-file-if-exists=.env scenarios/run-scenario.js <key> +1NUMBER` (keys: ddos, sqli-commit, exposed-secret, brute-force, port-scan; prefix `DRY_RUN=1` to preview without calling).

Note: the Linode account is capped at 10 total instances; "spin up 10" needs a limit increase from Linode support. Ari reports partial success gracefully.

## Select the call stack

The default is `ARI_VOICE_STACK=custom`, using the self-hosted STT and Kokoro.
`ARI_VOICE_STACK=twilio` leaves both transcription and speech to Twilio.
`ARI_VOICE_STACK=custom-with-deepgram` is custom mode with direct Deepgram
transcription in place of the self-hosted STT; it needs `DEEPGRAM_API` instead of
`STT_URL` and `STT_API_KEY`.
Leave the variable unset or set it explicitly in your private `.env`:

```bash
cd backend
ARI_VOICE_STACK=custom npm start
```

Custom mode requires `PUBLIC_HOST`, `TWILIO_SID`, `TWILIO_AUTH_TOKEN`,
`STT_URL`, `STT_API_KEY`, `KOKORO_TTS_BASE_URL`, and `KOKORO_TTS_API_KEY`, plus `ffmpeg`
on PATH. It uses the existing authenticated Kokoro `/v1/audio/speech/stream`
API (24 kHz mono PCM). Keep the phone number's webhook at `/voice`.
The same selection applies to inbound calls, `npm run call`, and incident calls.
Restart the backend after changing configuration. Existing calls do not change
mode just because the environment changes.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARI_VOICE_STACK` | `custom` | `twilio`, `custom` or `custom-with-deepgram` |
| `STT_URL` | required for custom | Self-hosted STT `/v1/listen` WebSocket; WSS, or WS on localhost |
| `STT_API_KEY` | required for custom | Self-hosted STT credential |
| `STT_ENDPOINTING_MS` | `300` | Silence endpoint, 50–2000 ms (both custom modes) |
| `DEEPGRAM_API` | required for custom-with-deepgram | Direct Deepgram streaming credential |
| `DEEPGRAM_MODEL` | `nova-3` | Nova v1 streaming model; Flux is not supported |
| `KOKORO_TTS_VOICE` | `af_heart` | Voice supported by your Kokoro service |
| `KOKORO_TTS_SPEED` | `1.0` | Speech speed, 0.5–2.0 |
| `TTS_PROVIDER` / `TTS_VOICE` | ElevenLabs / Eric | ConversationRelay voice, including fallback |

Twilio supplies 8 kHz mu-law audio directly to the STT server (Parakeet-TDT 0.6B v2,
English only), which speaks Deepgram's streaming protocol; install it with
`voice-stt/setup.sh`. Kokoro's 24 kHz PCM is
converted by FFmpeg to 8 kHz mu-law and sent in paced 20 ms frames. The STT keeps
listening while Ari talks. The first recognised words cancel interruptible generation
and clear Twilio's playback queue. Playback marks retain only fully acknowledged
segments; the exact words heard within an interrupted segment are unavailable.

One call can use Kokoro at a time **per backend process**. Additional calls use
ConversationRelay. STT/Kokoro failure redirects the same call to
ConversationRelay, preserving session context and completed tool results. A
started tool is allowed to finish, and is never automatically retried. The voice
changes to the configured ConversationRelay voice after fallback.
Reservations expire after 30 seconds; disconnected session state is retained for
five minutes. Sessions are in memory and do not survive a backend restart. Run
one backend process; multi-replica capacity coordination is not implemented.

The standard greeting is cached in memory after successful synthesis. Provider
connections use IPv4 to avoid the observed five-second dual-stack DNS delay on
this device. Custom mode uses five-second STT connection timeout, two seconds maximum startup
input buffering, and three-second TTS first-audio, stall and playback-acknowledgement
timeouts. Provider failure triggers fallback instead of silently dropping audio.
HTTP and WebSocket endpoints validate Twilio signatures; `PUBLIC_HOST` must match
the external HTTPS hostname even when the backend is behind a tunnel. Keep
ConversationRelay enabled in Twilio for overflow and fallback.

## Validate the stack

```bash
cd backend
npm test
npm run voice:smoke
```

Tests use mocked providers/tools and real local HTTP/WebSockets and FFmpeg.
`voice:smoke` spends a small amount of inference credit: it generates synthetic
telephone speech through Kokoro, transcribes it with the self-hosted STT,
runs Qwen, and synthesizes replies. It does **not** place a phone call or execute
infrastructure tools. Synthetic speech is not a substitute for phone-call testing.

Structured `voice` logs include the Call SID, route, model identity, model/tool
latency, first audio, playback completion and fallback reasons. They exclude API
keys, raw audio and spoken text. Existing tool results stay in session memory.

For live acceptance, compare at least 30 matched turns in each mode with real
phone audio: names/IPs, pauses, interruptions, incident approval with non-mutating
questions, an overflow call, and injected provider failure. Capture caller-side
latency independently. Backend targets are p95 first audio within 1.5 seconds of
available reply text and `clear` sent within 100 ms of a speech-start event.
End-of-speech latency additionally includes STT, Qwen and any tool execution.
No latency parity or simultaneous-Kokoro-call guarantee is implied by a passing
synthetic smoke test. Roll back with `ARI_VOICE_STACK=twilio` and restart.
