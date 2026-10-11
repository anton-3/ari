# Kokoro TTS on Akamai Cloud / Linode: complete setup and operations

Verified against the deployed server on October 10, 2026. This file contains
the installation commands, complete API source, systemd unit, HTTPS configuration,
client examples, benchmarks, and recovery instructions. You can recreate the
service without the original workshop repository. Commands install software only
when you run them; this document does not create another node.

## 1. Existing deployment

- Linode label: `hackmidwest-cpu-voice-g8`
- Linode ID: `107864618`
- Region: Chicago, `us-ord`
- Plan ID: `g8-dedicated-16-4`; 4 dedicated vCPUs, 16 GB RAM
- Guest CPU observed: AMD EPYC 9845, AVX-512 available
- OS: Ubuntu 24.04.4 LTS, x86-64; Python 3.12
- IPv4: `172.232.11.148`
- Cloud firewall ID: `201430715`
- Public base URL: `https://kokoro-172-232-11-148.sslip.io`
- Model: Kokoro-82M v1.0, FP32 ONNX, CPU execution
- Observed plan price: $0.21/hour, or $5.04 per 24 hours, before extras;
  check current account pricing before recreating it.

Traffic flows from HTTPS port 443 through Caddy to Uvicorn on
`127.0.0.1:8000`, then to a persistent Kokoro model. HTTP port 80 redirects
to HTTPS. The API and Caddy are enabled to start at boot.

On the current workstation, the private SSH key is
`.venv/linode-voice-access/id_ed25519`, and the pinned SSH host record is
`.venv/linode-voice-access/known_hosts`. From the original project directory:

```bash
ssh -i .venv/linode-voice-access/id_ed25519 \
  -o UserKnownHostsFile=.venv/linode-voice-access/known_hosts \
  -o StrictHostKeyChecking=yes root@172.232.11.148
```

The generated client credential is in the local project `.env` under
`KOKORO_TTS_API_KEY`; the URL is under `KOKORO_TTS_BASE_URL`. This document
deliberately contains no API keys, management tokens, SSH private keys, or passwords.

## 2. Credentials and prerequisites

You need a Linode account allowed to create the selected plan, an SSH keypair,
and a client machine with SSH. The management API token (`LINODE_API_TOKEN` in
the original project) is only needed if you provision or manage resources via
API/CLI. It is separate from the generated TTS key. Cloud Manager provisioning
uses your account login instead.

The server does not need the Linode management token, Akamai hosted inference
credentials, object storage keys, a team ID, PostgreSQL, or Valkey. Model weights
live on the VM's local disk and synthesis runs locally. Do not copy the full
workshop `.env` to the VM; install only the generated TTS key.

For a new SSH keypair, run on your workstation:

```bash
mkdir -p "$HOME/.ssh"
ssh-keygen -t ed25519 -f "$HOME/.ssh/kokoro_linode" -C kokoro-linode
```

Upload only `kokoro_linode.pub` to the account / instance. Keep the private key
on the workstation. For a new machine, verify the SSH host fingerprint through
Linode's console before accepting the first SSH connection. The existing pinned
host record applies only to the existing machine.

## 3. Provision the VM and firewall

In [Cloud Manager](https://cloud.linode.com), create a Linode using:

1. Ubuntu 24.04 LTS x86-64 image (API image ID `linode/ubuntu24.04`).
2. Chicago / `us-ord`.
3. Dedicated G8 plan `g8-dedicated-16-4`, 4 vCPUs and 16 GB RAM.
4. Your SSH public key and a strong root password, stored privately.
5. A unique label, such as `kokoro-tts-cpu`.
6. Boot the instance; record its instance ID and public IPv4.

This exact plan was successfully created on the hackathon account. Larger G8
plans and a higher-CPU resize were rejected by account limits requiring support.
Plan catalog visibility alone does not prove your account can provision it.
This setup uses no GPU Linode and needs no GPU activation/deposit.

Create and attach a **Cloud Firewall to the new instance** with inbound default
policy DROP and outbound default policy ACCEPT:

- TCP 22: your administrator IP/CIDR if possible. The current demo permits
  public SSH with key-based access; narrow it when the admin IP is stable.
- TCP 80 and 443: public IPv4 `0.0.0.0/0` and IPv6 `::/0`.
- Do not expose TCP 8000; the API binds only to loopback.

Outbound access is needed for Ubuntu packages, PyPI, GitHub model downloads,
DNS, and certificate issuance/renewal. If you also enable a host firewall,
allow SSH, 80, and 443 there as well before enabling it.

For a new node, create a hostname using its IP, for example
`kokoro-203-0-113-10.sslip.io` for IP `203.0.113.10` (example address only).
Alternatively point a domain you control to the node. Do not reuse the existing
hostname for a different IP. This guide's Caddyfile uses the existing hostname;
replace it for a new VM. Confirm DNS resolves to the new node.

SSH into the new node with your new key. All following installation commands
through section 8 run **on the VM as root**.

## 4. Install the runtime

```bash
apt-get update
apt-get install -y python3-venv python3-pip espeak-ng libsndfile1 curl caddy
install -d -m 755 /opt/voice-bench /opt/kokoro-api
python3 -m venv /opt/voice-bench/.venv
/opt/voice-bench/.venv/bin/pip install \
  kokoro-onnx==0.6.1 onnxruntime==1.31.0 soundfile==0.14.0 \
  fastapi==0.143.0 uvicorn==0.54.0 numpy==2.5.4 \
  pydantic==2.14.0 starlette==1.7.0
```

The deployed Caddy version is 2.6.2 from Ubuntu packages. The direct Python
dependencies above pin the tested stack; a full environment snapshot is included
in the appendix for closer reproduction. Run `pip check` after installation:

```bash
/opt/voice-bench/.venv/bin/pip check
```

## 5. Download and verify model files

The filenames retain `v1.0`; they are hosted under the wrapper's
`model-files-v1.1` release. These are the exact files used by the deployed node.
The [kokoro-onnx upstream setup](https://github.com/thewh1teagle/kokoro-onnx)
documents the ONNX model and voice-file pairing.

```bash
cd /opt/voice-bench
curl -fL --retry 3 -o kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
curl -fL --retry 3 -o voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
sha256sum -c <<'SHA256'
beb0d1848dee9a49da392cc3df26958d46cfa35d321edf434f52949153f0df3a  kokoro-v1.0.onnx
bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d  voices-v1.0.bin
SHA256
chmod 644 kokoro-v1.0.onnx voices-v1.0.bin
```

Both checks must print `OK`. The CPU runtime is `onnxruntime`, not
`onnxruntime-gpu`. No CUDA, model-host account, or external inference key is needed.

## 6. Create the service account and API key

```bash
id kokoro >/dev/null 2>&1 || \
  useradd --system --user-group --home-dir /nonexistent \
    --shell /usr/sbin/nologin kokoro
```

Generate a new credential on a **new deployment**:

```bash
python3 - <<'PY'
import os
import secrets
from pathlib import Path
path = Path('/etc/kokoro-api.env')
if path.exists():
    raise SystemExit('Credential already exists; preserve it or rotate deliberately.')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write('KOKORO_TTS_API_KEY=kt_' + secrets.token_urlsafe(32) + '\n')
PY
chown root:root /etc/kokoro-api.env
chmod 600 /etc/kokoro-api.env
```

Systemd reads this root-owned file before starting the process as `kokoro`.
Do not regenerate it on the existing node unless you intend to rotate the key
and update all clients. Keep the same key across restarts.

After setup, securely copy this one file to your workstation and merge its
`KOKORO_TTS_API_KEY` into your application's private `.env`, adding
`KOKORO_TTS_BASE_URL=https://YOUR_HOSTNAME`. For example, **on the workstation**:

```bash
umask 077
scp -i "$HOME/.ssh/kokoro_linode" \
  root@YOUR_NODE_IP:/etc/kokoro-api.env ./kokoro-client.env
```

Add the URL locally, protect this file, and exclude it from version control.
The existing project's `.env` already has the deployed key and base URL.
Client apps send only this TTS key in `Authorization: Bearer <key>`. Keep it
on your application backend rather than shipping it in public browser JavaScript.

## 7. Install the API source and systemd unit

The appendix includes complete commands to write `/opt/kokoro-api/server.py`
and `/etc/systemd/system/kokoro-api.service`. Run those two appendix blocks now,
then return here:

```bash
chown root:root /opt/kokoro-api/server.py /etc/systemd/system/kokoro-api.service
chmod 644 /opt/kokoro-api/server.py /etc/systemd/system/kokoro-api.service
systemctl daemon-reload
systemctl enable --now kokoro-api
systemctl status kokoro-api --no-pager
journalctl -u kokoro-api -n 50 --no-pager
```

Startup loads and warms the model before accepting requests. Allow startup to
finish. The service uses one Uvicorn worker and one synthesis executor; ONNX
uses two intra-operation threads and one inter-operation thread. More Uvicorn
workers would create more model copies and are not part of this tested setup.

## 8. Configure public HTTPS

Run the Caddyfile appendix block, replacing its hostname for a new VM. Then:

```bash
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
systemctl is-active kokoro-api caddy
systemctl is-enabled kokoro-api caddy
```

Caddy obtains and renews a trusted certificate automatically when DNS points
to the node and ports 80/443 are reachable. It redirects HTTP to HTTPS. See
[Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https) for
certificate and network requirements. A domain you control avoids depending
on the third-party `sslip.io` DNS service.

The proxy uses `flush_interval -1` to forward streamed segments immediately;
request bodies are limited to 16 KB. The app allows 1–2,000 input characters.

## 9. API contract

All endpoints require the same Bearer credential, including health and voices.
Missing or incorrect keys return HTTP `401`. Unknown voices and invalid input
return `422`. Up to eight requests, including active synthesis, are admitted;
excess requests return `429` with `Retry-After: 2`. Uvicorn also has a concurrency
limit of 32; server overload at that layer can return `503`.

- `GET /health`: readiness, model, CPU device, pending request count.
- `GET /v1/voices`: supported English voice IDs; default `af_heart`.
- `POST /v1/audio/speech`: complete WAV, buffered until generation finishes.
- `POST /v1/audio/speech/stream`: incremental headerless PCM audio.

POST request fields:

- `input`: required, 1–2,000 characters, nonblank after stripping whitespace.
- `model`: `kokoro` (default) or `kokoro-82m`.
- `voice`: default `af_heart`; examples `am_michael`, `bf_emma`.
- `speed`: default 1.0, inclusive range 0.5–2.0.
- `response_format`: `wav` on the buffered route; `pcm` on the streaming route.
  Each route defaults to its own format if omitted.

Voices beginning with `a` use American English pronunciation; `b` uses British
English. This deployment exposes only those two voice groups.

### Buffered output

24-kHz mono PCM16 WAV, `Content-Type: audio/wav`. Headers
`X-Generation-Seconds`, `X-Audio-Seconds`, and `X-Queue-Seconds` report generation,
audio duration, and time waiting for the synthesis worker.

### Streaming output

`Content-Type: application/octet-stream`, signed 16-bit little-endian PCM,
24,000 samples/second, one channel, no WAV header or known content length.
Format headers are `X-Audio-Format: pcm_s16le`, `X-Sample-Rate: 24000`, and
`X-Channels: 1`; there are no final timing headers on this route.

The server splits input on sentence punctuation and word boundaries into roughly
160-character segments (an individual long word can exceed this target). Each
segment is synthesized and delivered before the next is generated. First audio
therefore arrives before the whole response is ready. Short segmentation can
change pauses and intonation. This is incremental sentence/segment synthesis,
not audio emitted frame-by-frame from a single continuous model invocation.

Concurrent streams share the worker at segment boundaries. A disconnect stops
future segments after the active CPU job finishes. First-segment failures occur
before success headers; later failures interrupt the stream. Clients should
treat interrupted transfers as incomplete. Network chunks are arbitrary byte
boundaries, so a player must preserve partial two-byte samples between reads.

There is no browser CORS configuration, per-client quota, key database, audio
retention, GPU, or multi-worker deployment. Put browser access behind your own
backend and feed PCM into a suitable player/AudioWorklet. All clients sharing
the key share the same queue.

## 10. Client verification, WAV download, and streaming benchmark

On your workstation, install `requests` and `python-dotenv` in a virtualenv.
Run the following from a directory containing a private `.env` with the two
TTS variables. It validates authentication, checks the voices endpoint,
downloads a WAV, measures three streaming requests, wraps their PCM as WAV,
and saves a report. No credential is printed.

```bash
python3 -m venv .tts-client-venv
.tts-client-venv/bin/pip install requests python-dotenv
```

Save this as `verify_kokoro.py`, then run `.tts-client-venv/bin/python verify_kokoro.py`:

```python
import json
import statistics
import time
import wave
from pathlib import Path
import requests
from dotenv import dotenv_values

env = dotenv_values('.env')
base = env['KOKORO_TTS_BASE_URL'].rstrip('/')
headers = {'Authorization': 'Bearer ' + env['KOKORO_TTS_API_KEY']}
output = Path('/tmp/kokoro-api-review')
output.mkdir(parents=True, exist_ok=True)
session = requests.Session()
response = session.get(base + '/health', headers=headers, timeout=90)
response.raise_for_status()
assert response.json()['status'] == 'ready'
assert session.get(base + '/health', timeout=30).status_code == 401
assert session.get(base + '/health', headers={
    'Authorization': 'Bearer intentionally-invalid'}, timeout=30).status_code == 401
voices = session.get(base + '/v1/voices', headers=headers, timeout=30)
voices.raise_for_status()
assert 'af_heart' in voices.json()['voices']

response = session.post(base + '/v1/audio/speech', headers=headers,
    json={'input': 'Hello! Your payment was successful.', 'response_format': 'wav'},
    timeout=90)
response.raise_for_status()
assert response.content[:4] == b'RIFF'
(output / 'buffered.wav').write_bytes(response.content)

text = ('Welcome to our Hack Midwest demo. Your payment has been received, '
        'and your reservation is confirmed. We are generating speech on an '
        'Akamai CPU server. Audio arrives as each short segment finishes, '
        'so your application can start playing before the entire response is ready.')
results = []
for index in range(3):
    start = time.perf_counter()
    arrivals, parts = [], []
    with session.post(base + '/v1/audio/speech/stream', headers=headers,
            json={'input': text, 'voice': 'af_heart', 'response_format': 'pcm'},
            stream=True, timeout=90) as response:
        response.raise_for_status()
        assert response.headers['X-Audio-Format'] == 'pcm_s16le'
        for chunk in response.iter_content(chunk_size=None):
            if chunk:
                arrivals.append(time.perf_counter() - start)
                parts.append(chunk)
    total = time.perf_counter() - start
    pcm = b''.join(parts)
    assert arrivals and len(pcm) % 2 == 0
    path = output / f'stream-{index + 1}.wav'
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(pcm)
    results.append({'first_audio_seconds': arrivals[0], 'total_seconds': total,
        'audio_seconds': len(pcm) / 48000, 'network_chunks': len(parts),
        'arrivals_seconds': arrivals, 'file': str(path)})
(output / 'stream-benchmark.json').write_text(json.dumps(results, indent=2))
print('Median first audio:', statistics.median(r['first_audio_seconds'] for r in results))
print('Median full transfer:', statistics.median(r['total_seconds'] for r in results))
print('Audio and metrics saved to', output)
```

This example buffers received PCM to save review files. For live playback,
feed each arriving chunk into a PCM-capable audio player immediately instead.
Do not call `response.content` first or wait for the full stream. The original
repo also includes `scripts/benchmark_kokoro_api.py` for buffered-route tests.

## 11. Measured performance on this node

Warm requests from the development workstation, with connection reuse. Numbers
include network transfer and are observations, not latency guarantees.

- Buffered: 2.3 seconds of audio in median 0.61 seconds end-to-end.
- Buffered: 6.1 seconds of audio in median 1.88 seconds end-to-end.
- Buffered: 16.9 seconds of audio in median 5.04 seconds end-to-end.
- Streaming, three requests: 16.9 seconds of audio; first audio median
  0.637 seconds (range 0.568–0.739); full transfer median 4.057 seconds.
- Two simultaneous warmed buffered requests producing 6.1 seconds each completed
  in 1.69 and 3.51 seconds; the second spent about 1.34 seconds in the queue.
- Model-only generation for a 6.1-second buffered clip was about 1.35 seconds,
  approximately 4.5 times faster than playback. Two ONNX threads performed
  similarly to four in the initial test, so this service uses two.

Fresh DNS/TLS connections can add noticeable latency. Short and long text have
different first-segment costs; queued work also delays first audio. The buffered
and streaming tests used different paragraphs, so these measurements do not
establish a controlled total-runtime speedup between endpoints.

Existing workstation artifacts are in `/tmp/kokoro-api-review/`, including
`benchmark.json`, `stream-benchmark.json`, and WAV samples. `/tmp` is temporary;
copy audio elsewhere if you need to keep it. The API itself does not retain
generated audio on the server.

## 12. Operations, updates, and recovery

Run these on the node:

```bash
systemctl status kokoro-api caddy --no-pager
journalctl -u kokoro-api -n 100 --no-pager
journalctl -u caddy -n 100 --no-pager
ss -ltnp
systemctl restart kokoro-api
```

Expected listeners: public 80/443 for Caddy; loopback-only 8000 for Uvicorn.
Do not put credentials in logs or enable request-header logging. Model warmup
runs after each API restart; Caddy may return 502 until readiness is complete.

For code updates, replace `/opt/kokoro-api/server.py`, keep it root-owned and
readable by the service, then restart `kokoro-api`. For service-unit changes,
run `systemctl daemon-reload` before restarting. For Caddy changes, validate
the config then reload Caddy. Back up the credential file privately before
key rotation; update its value and all clients, then restart the API. This
implementation accepts one key at a time, so rotation needs coordination.

If HTTPS fails, check DNS, attached Cloud Firewall rules, any host firewall,
ports 80/443, and Caddy's journal. Do not bypass certificate validation in
clients. If startup fails, check the model checksums, package installation,
permissions, `/etc/kokoro-api.env`, and the API journal. If synthesis stalls,
inspect `/health` and CPU use, wait for active jobs, and restart the service
if necessary; a restart interrupts in-flight requests.

Use Cloud Manager to shut down or boot the existing node. Booting automatically
starts both services; availability also depends on OS boot and model warmup.
Shutting down a provisioned Linode does not stop its charges: services present
on the account continue accruing fees even while powered off. See
[Akamai billing](https://techdocs.akamai.com/cloud-computing/docs/understanding-how-billing-works).
To retire the deployment, save any
needed credentials/configuration, delete the intended Linode through Cloud
Manager, and remove its unused firewall/DNS records as appropriate. Confirm
the label and ID before deletion; the payments demo is a separate node.

## Appendix A. Complete API source

Run the following on the node to create the source file. This is the deployed
implementation, including both buffered and streaming endpoints.

```bash
cat > /opt/kokoro-api/server.py <<'PYTHON'
"""Authenticated, CPU-only Kokoro speech API; model stays loaded in memory."""
import asyncio
import io
import os
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Literal

import onnxruntime as ort
import soundfile as sf
from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import StreamingResponse
from kokoro_onnx import Kokoro
from pydantic import BaseModel, Field, field_validator

API_KEY = os.environ["KOKORO_TTS_API_KEY"].encode()
MODEL_DIR = os.environ.get("KOKORO_MODEL_DIR", "/opt/voice-bench")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro")
security = HTTPBearer(auto_error=False)
pending = 0
MAX_PENDING = 8


def initialize():
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        f"{MODEL_DIR}/kokoro-v1.0.onnx",
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    engine = Kokoro.from_session(session, f"{MODEL_DIR}/voices-v1.0.bin")
    engine.create("Hello, the voice service is ready.", voice="af_heart", lang="en-us")
    return engine


@asynccontextmanager
async def lifespan(app):
    app.state.engine = await asyncio.get_running_loop().run_in_executor(executor, initialize)
    app.state.voices = sorted(v for v in app.state.engine.get_voices() if v.startswith(("a", "b")))
    yield
    executor.shutdown(wait=True)


app = FastAPI(title="Kokoro CPU TTS", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def authenticate(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    if credentials is None or not secrets.compare_digest(credentials.credentials.encode(), API_KEY):
        raise HTTPException(401, "Invalid or missing API key", headers={"WWW-Authenticate": "Bearer"})


class SpeechRequest(BaseModel):
    model: Literal["kokoro", "kokoro-82m"] = "kokoro"
    input: str = Field(min_length=1, max_length=2000)
    voice: str = "af_heart"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    response_format: Literal["wav"] = "wav"

    @field_validator("input")
    @classmethod
    def strip_input(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Input must contain speech text")
        return value


@app.get("/health", dependencies=[Depends(authenticate)])
async def health():
    return {"status": "ready", "model": "kokoro-82m", "device": "cpu", "pending_requests": pending}


@app.get("/v1/voices", dependencies=[Depends(authenticate)])
async def voices():
    return {"voices": app.state.voices, "default": "af_heart"}


def synthesize(request, submitted):
    started = time.perf_counter()
    audio, sample_rate = app.state.engine.create(
        request.input,
        voice=request.voice,
        speed=request.speed,
        lang="en-gb" if request.voice.startswith("b") else "en-us",
    )
    generation_seconds = time.perf_counter() - started
    output = io.BytesIO()
    sf.write(output, audio, sample_rate, format="WAV", subtype="PCM_16")
    return output.getvalue(), generation_seconds, len(audio) / sample_rate, started - submitted


@app.post("/v1/audio/speech", dependencies=[Depends(authenticate)])
async def speech(request: SpeechRequest):
    global pending
    if request.voice not in app.state.voices:
        raise HTTPException(422, "Unknown or unsupported English voice; see /v1/voices")
    if pending >= MAX_PENDING:
        raise HTTPException(429, "Inference queue is full", headers={"Retry-After": "2"})
    pending += 1
    submitted = time.perf_counter()
    # A disconnected client must not free a queue slot while inference still runs.
    future = asyncio.get_running_loop().run_in_executor(executor, synthesize, request, submitted)
    future.add_done_callback(release_slot)
    wav, generation, duration, queue = await asyncio.shield(future)
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="speech.wav"',
            "X-Generation-Seconds": f"{generation:.6f}",
            "X-Audio-Seconds": f"{duration:.6f}",
            "X-Queue-Seconds": f"{queue:.6f}",
        },
    )


def release_slot(_):
    global pending
    pending -= 1


class StreamRequest(SpeechRequest):
    response_format: Literal["pcm"] = "pcm"


def text_chunks(text):
    """Bound first-audio latency while retaining sentence/word boundaries."""
    for sentence in re.split(r"(?<=[.!?;:])\s+", text):
        words = sentence.split()
        chunk = []
        length = 0
        for word in words:
            if chunk and length + len(word) + 1 > 160:
                yield " ".join(chunk)
                chunk, length = [], 0
            chunk.append(word)
            length += len(word) + 1
        if chunk:
            yield " ".join(chunk)


def synthesize_pcm(text, request):
    audio, _ = app.state.engine.create(
        text, voice=request.voice, speed=request.speed,
        lang="en-gb" if request.voice.startswith("b") else "en-us",
    )
    output = io.BytesIO()
    sf.write(output, audio, 24000, format="RAW", subtype="PCM_16", endian="LITTLE")
    return output.getvalue()


@app.post("/v1/audio/speech/stream", dependencies=[Depends(authenticate)])
async def stream_speech(request: StreamRequest):
    global pending
    if request.voice not in app.state.voices:
        raise HTTPException(422, "Unknown or unsupported English voice; see /v1/voices")
    if pending >= MAX_PENDING:
        raise HTTPException(429, "Inference queue is full", headers={"Retry-After": "2"})
    pending += 1
    chunks = iter(text_chunks(request.input))
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(executor, synthesize_pcm, next(chunks), request)
    try:
        first = await asyncio.shield(future)
    except BaseException:
        future.add_done_callback(release_slot)
        raise

    async def audio_stream():
        nonlocal future
        try:
            yield first
            for text in chunks:
                future = loop.run_in_executor(executor, synthesize_pcm, text, request)
                yield await asyncio.shield(future)
        finally:
            # Disconnects stop subsequent chunks, but the active CPU job retains
            # its admission slot until it finishes.
            future.add_done_callback(release_slot)

    return StreamingResponse(audio_stream(), media_type="application/octet-stream", headers={
        "Cache-Control": "no-store",
        "X-Audio-Format": "pcm_s16le",
        "X-Sample-Rate": "24000",
        "X-Channels": "1",
        "X-Accel-Buffering": "no",
    })
PYTHON
```

## Appendix B. Complete systemd unit

```bash
cat > /etc/systemd/system/kokoro-api.service <<'SYSTEMD'
[Unit]
Description=Authenticated Kokoro CPU speech API
After=network-online.target
Wants=network-online.target

[Service]
User=kokoro
Group=kokoro
WorkingDirectory=/opt/kokoro-api
EnvironmentFile=/etc/kokoro-api.env
Environment=KOKORO_MODEL_DIR=/opt/voice-bench
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=XDG_CACHE_HOME=/var/cache/kokoro
Environment=OMP_NUM_THREADS=2
CacheDirectory=kokoro
ExecStart=/opt/voice-bench/.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log --limit-concurrency 32
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
SYSTEMD
```

## Appendix C. Complete Caddy configuration

Replace the hostname below when recreating this on a different node.

```bash
cat > /etc/caddy/Caddyfile <<'CADDY'
kokoro-172-232-11-148.sslip.io {
    request_body {
        max_size 16KB
    }
    header {
        -Server
        X-Content-Type-Options nosniff
    }
    reverse_proxy 127.0.0.1:8000 {
        flush_interval -1
    }
}
CADDY
```

## Appendix D. Full tested Python environment

This is the deployed environment's `pip freeze` snapshot. To pin transitive
dependencies as well, save this block as `/opt/voice-bench/requirements.lock`
and install with `/opt/voice-bench/.venv/bin/pip install -r /opt/voice-bench/requirements.lock`
in section 4. It captures Python packages, not Ubuntu packages.

```text
annotated-doc==0.0.5
annotated-types==0.8.0
anyio==4.15.1
attrs==26.1.0
cffi==2.1.1
click==8.5.0
cloudpickle==3.1.2
dlinfo==2.0.0
espeakng-loader==0.2.4
fastapi==0.143.0
flatbuffers==25.12.19
h11==0.16.0
idna==3.20
joblib==1.6.0
kokoro-onnx==0.6.1
numpy==2.5.4
onnxruntime==1.31.0
opentelemetry-api==1.45.1
packaging==26.3
phonemizer==3.4.0
protobuf==7.36.2
pycparser==3.11
pydantic==2.14.0
pydantic_core==2.50.0
soundfile==0.14.0
starlette==1.7.0
typing-inspection==0.4.4
typing_extensions==4.16.0
uvicorn==0.54.0
```
