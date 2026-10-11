"""Self-hosted, CPU-only speech-to-text that speaks Deepgram's streaming /v1/listen protocol.

Twilio mu-law 8 kHz audio -> Silero VAD (endpointing + barge-in) -> NVIDIA Parakeet-TDT 0.6B v2
(int8 ONNX via sherpa-onnx). Emits the Deepgram messages Ari's backend consumes:
SpeechStarted, Results (is_final + speech_final per utterance), UtteranceEnd, Metadata.

Env: STT_API_KEY (required), STT_MODEL_DIR, STT_VAD_MODEL, STT_HOST, STT_PORT, STT_THREADS.
"""
import asyncio
import json
import os
import secrets
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, urlparse

import numpy as np
import sherpa_onnx
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

API_KEY = os.environ["STT_API_KEY"]
MODEL_DIR = os.environ.get("STT_MODEL_DIR", "/opt/ari-stt/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8")
VAD_MODEL = os.environ.get("STT_VAD_MODEL", "/opt/ari-stt/models/silero_vad.onnx")
THREADS = int(os.environ.get("STT_THREADS", "4"))
RATE = 16000  # Twilio sends 8 kHz; Silero VAD and Parakeet both run at 16 kHz
MODEL_NAME = "parakeet-tdt-0.6b-v2"

# G.711 mu-law -> float32 lookup table.
def _mulaw_table():
    u = ~np.arange(256, dtype=np.uint8)
    sign, exp, mant = u & 0x80, (u >> 4) & 0x07, u & 0x0F
    mag = (((mant.astype(np.int32) << 3) + 0x84) << exp) - 0x84
    return (np.where(sign, -mag, mag) / 32768.0).astype(np.float32)

MULAW = _mulaw_table()


def upsample(x, prev):
    """8 kHz -> 16 kHz linear interpolation, continuous across frames via the previous sample."""
    y = np.empty(len(x) * 2, dtype=np.float32)
    y[1::2] = x
    y[0::2] = (np.concatenate(([prev], x[:-1])) + x) / 2
    return y

recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f"{MODEL_DIR}/encoder.int8.onnx",
    decoder=f"{MODEL_DIR}/decoder.int8.onnx",
    joiner=f"{MODEL_DIR}/joiner.int8.onnx",
    tokens=f"{MODEL_DIR}/tokens.txt",
    model_type="nemo_transducer",
    num_threads=THREADS,
    decoding_method="greedy_search",
)
# One decode at a time keeps latency predictable next to Kokoro on a 4-vCPU box.
decoder_pool = ThreadPoolExecutor(max_workers=1)


def transcribe(samples):
    stream = recognizer.create_stream()
    stream.accept_waveform(RATE, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


def make_vad(endpointing_ms):
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = VAD_MODEL
    cfg.silero_vad.threshold = 0.5
    cfg.silero_vad.min_silence_duration = endpointing_ms / 1000
    cfg.silero_vad.min_speech_duration = 0.15
    cfg.silero_vad.max_speech_duration = 15
    cfg.silero_vad.window_size = 512  # 32 ms at 16 kHz
    cfg.sample_rate = RATE
    cfg.num_threads = 1
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=30)


def authorized(request):
    header = request.headers.get("Authorization", "")
    token = header.split(" ", 1)[1] if " " in header else ""
    return secrets.compare_digest(token.encode(), API_KEY.encode())


def check(connection, request):
    if urlparse(request.path).path != "/v1/listen":
        return connection.respond(404, "Not found\n")
    if not authorized(request):
        return connection.respond(401, "Unauthorized\n")
    return None


PREROLL = int(0.3 * RATE)   # Silero flags speech late; decode from 300 ms before so first words aren't clipped
POSTROLL = int(0.1 * RATE)
# A turn ends after VAD silence (endpointing, 300 ms) + HOLD. The whole turn is decoded speculatively the
# moment VAD sees silence, so HOLD hides the decode; if the caller resumes, that result is discarded and the
# turn is re-decoded as one piece (no mid-sentence splits, full context for the model).
HOLD_S = int(os.environ.get("STT_HOLD_MS", "200")) / 1000
UNFINISHED_HOLD_S = 0.6     # "..., and" / "the" / trailing comma: give the caller longer to continue
# Silero needs ~150 ms of speech to report a resumption; raw energy reacts in one 20 ms frame. Energy during
# the hold only postpones the close (bounded), it never ends a turn, so line noise can't cause a split.
ENERGY_POSTPONE_S = 0.2
MAX_POSTPONE_S = 0.8
MAX_TURN = 30 * RATE
TRAILING = {"and", "but", "or", "so", "then", "to", "the", "a", "an", "of", "with", "because", "if", "um", "uh", "like"}


def unfinished(text):
    last = text.rstrip().rsplit(" ", 1)[-1].lower()
    return text.rstrip().endswith(",") or last.strip(".,?!") in TRAILING


async def session(ws):
    query = parse_qs(urlparse(ws.request.path).query)
    endpointing = min(2000, max(50, int(query.get("endpointing", ["300"])[0])))
    request_id = str(uuid.uuid4())
    vad = make_vad(endpointing)
    loop = asyncio.get_running_loop()
    buf, buf_start = np.zeros(0, dtype=np.float32), 0  # rolling audio; buf[0] is absolute sample buf_start
    received = 0
    speaking = False
    prev = 0.0
    turn_start = turn_end = None
    emit = None  # pending speculative decode + hold for the current turn
    deadline = cap = 0.0
    floor = 0.003  # running background-noise RMS estimate

    async def send(msg):
        try:
            await ws.send(json.dumps(msg))
        except Exception:
            pass

    async def close_turn(start, end, audio, wait=True):
        nonlocal turn_start, turn_end, buf, buf_start, deadline
        began = time.perf_counter()
        opened = loop.time()
        text = await loop.run_in_executor(decoder_pool, transcribe, audio)
        decode_ms = (time.perf_counter() - began) * 1000
        if wait:
            if unfinished(text):
                deadline = max(deadline, opened + UNFINISHED_HOLD_S)
            while loop.time() < deadline:
                await asyncio.sleep(deadline - loop.time())
        # Past this point the turn is committed; a cancel can no longer split it.
        turn_start = turn_end = None
        keep = max(buf_start, end - PREROLL)
        buf, buf_start = buf[keep - buf_start:], keep
        print(json.dumps({"stt": request_id[:8], "audio_s": round(len(audio) / RATE, 2),
                          "decode_ms": round(decode_ms), "text": text}), flush=True)
        if not text:
            return
        await send({
            "type": "Results", "channel_index": [0, 1], "start": start / RATE, "duration": (end - start) / RATE,
            "is_final": True, "speech_final": True, "from_finalize": not wait,
            "channel": {"alternatives": [{"transcript": text, "confidence": 1.0, "words": []}]},
            "metadata": {"request_id": request_id, "model_info": {"name": MODEL_NAME}},
        })
        await send({"type": "UtteranceEnd", "channel": [0, 1], "last_word_end": end / RATE})

    def drain(closing=False):
        nonlocal turn_start, turn_end, emit, deadline, cap
        while not vad.empty():
            seg = vad.front
            if turn_start is None:
                turn_start = max(buf_start, seg.start - PREROLL)
            turn_end = min(buf_start + len(buf), seg.start + len(seg.samples) + POSTROLL)
            vad.pop()
        if turn_start is None:
            return
        if emit and not emit.done():
            emit.cancel()
        audio = buf[turn_start - buf_start:turn_end - buf_start].copy()
        long_turn = turn_end - turn_start >= MAX_TURN
        deadline = loop.time() + HOLD_S
        cap = loop.time() + MAX_POSTPONE_S
        emit = asyncio.create_task(close_turn(turn_start, turn_end, audio, wait=not (closing or long_turn)))

    try:
        async for message in ws:
            if isinstance(message, bytes):
                raw = MULAW[np.frombuffer(message, dtype=np.uint8)]
                if not len(raw):
                    continue
                samples, prev = upsample(raw, prev), raw[-1]
                received += len(samples)
                buf = np.concatenate((buf, samples))
                if turn_start is None and not speaking and len(buf) > 30 * RATE:  # long silence: cap memory
                    buf, buf_start = buf[-PREROLL:], received - PREROLL
                was = speaking
                rms = float(np.sqrt(np.mean(raw * raw)))
                if rms > max(4 * floor, 0.01):
                    if emit and not emit.done() and turn_start is not None:
                        deadline = max(deadline, min(loop.time() + ENERGY_POSTPONE_S, cap))
                elif not speaking:
                    floor = 0.95 * floor + 0.05 * rms
                vad.accept_waveform(samples)
                now = vad.is_speech_detected()
                if now and not speaking:
                    if emit and not emit.done() and turn_start is not None:
                        emit.cancel()  # caller kept talking: this turn continues
                    await send({"type": "SpeechStarted", "channel": [0], "timestamp": received / RATE})
                speaking = now
                # A segment finished, or speech stopped without one (noise burst): (re)close the turn.
                if not vad.empty() or (was and not now and turn_start is not None and (not emit or emit.done())):
                    drain()
            else:
                try:
                    kind = json.loads(message).get("type")
                except ValueError:
                    continue
                if kind in ("Finalize", "CloseStream"):
                    vad.flush()
                    drain(closing=True)
                    if kind == "CloseStream":
                        break
    finally:
        if emit and not emit.done():
            try:
                await emit
            except asyncio.CancelledError:
                pass
        await send({"type": "Metadata", "request_id": request_id, "duration": received / RATE,
                    "channels": 1, "model_info": {"name": MODEL_NAME, "arch": "parakeet-tdt"}})


async def main():
    # Warm the model so the first caller doesn't pay graph initialisation.
    transcribe(np.zeros(RATE // 2, dtype=np.float32))
    host, port = os.environ.get("STT_HOST", "127.0.0.1"), int(os.environ.get("STT_PORT", "8001"))
    async with serve(session, host, port, process_request=check, max_size=2**20, ping_interval=20):
        print(f"ari-stt ({MODEL_NAME}) listening on ws://{host}:{port}/v1/listen", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
