# hackmid2026

- [frontend/](frontend/): React app (Vite)
- [backend/](backend/): Call or text Claude through Twilio. Setup is in [backend/README.md](backend/README.md).

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
