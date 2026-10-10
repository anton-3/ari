#!/usr/bin/env python3
"""ari-net load generator: a light, realistic AcmePay request mix sent to the lb.

Uses persistent keep-alive connections (one per worker thread) so the traffic
shows up as steady, long-lived TCP flows on the topology map.
Intensity is read from /etc/ari-net/traffic.mode every 2s:
  normal -> 2 workers, ~3 req/s total
  surge  -> 12 workers, ~40 req/s total
"""
import http.client, json, os, random, threading, time

LB = os.environ.get("LB_HOST", "127.0.0.1")
MODE_FILE = "/etc/ari-net/traffic.mode"
PLAN = {"normal": (2, 0.5, 0.9), "surge": (12, 0.15, 0.35)}  # workers, min/max think time
NAMES = ["James", "Maria", "Wei", "Aisha", "Carlos", "Priya", "Tom", "Sofia", "Liam", "Noor"]
STATUSES = ["succeeded", "pending", "failed", "refunded"]
mode = "normal"


def read_mode():
    global mode
    while True:
        try:
            m = open(MODE_FILE).read().strip()
            mode = m if m in PLAN else "normal"
        except OSError:
            mode = "normal"
        time.sleep(2)


def next_request():
    r = random.random()
    if r < 0.28:
        return "GET", "/api/merchants", None
    if r < 0.50:
        q = random.choice(NAMES)
        if random.random() < 0.4:
            q += "&status=" + random.choice(STATUSES)
        return "GET", "/api/transactions?user=" + q, None
    if r < 0.65:
        ok = random.random() < 0.8
        body = {"email": "admin@acmepay.io", "password": "admin123" if ok else "wrong-password"}
        return "POST", "/api/login", body
    if r < 0.80:
        body = {"user_id": random.randint(2, 20), "merchant_id": random.randint(1, 7),
                "amount_cents": random.randint(199, 25000), "description": "Order #%d" % random.randint(20000, 99999)}
        return "POST", "/api/payments", body
    if r < 0.90:
        return "GET", "/api/users/%d" % random.randint(1, 20), None
    if r < 0.96:
        return "GET", "/health", None
    return "GET", random.choice(["/admin", "/api/v2/charges", "/favicon.ico", "/.env"]), None


def worker(idx):
    conn = None
    while True:
        active, lo, hi = PLAN[mode]
        if idx >= active:
            if conn:
                conn.close()
                conn = None
            time.sleep(1)
            continue
        method, path, body = next_request()
        try:
            if conn is None:
                conn = http.client.HTTPConnection(LB, 80, timeout=10)
            headers = {"User-Agent": "ari-net-traffic/1.0", "Connection": "keep-alive"}
            data = None
            if body is not None:
                data = json.dumps(body)
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            resp.read()
            if resp.getheader("Connection", "").lower() == "close":
                conn.close()
                conn = None
        except Exception:
            if conn:
                conn.close()
            conn = None
            time.sleep(1)
        time.sleep(random.uniform(lo, hi))


if __name__ == "__main__":
    threading.Thread(target=read_mode, daemon=True).start()
    for i in range(PLAN["surge"][0]):
        threading.Thread(target=worker, args=(i,), daemon=True).start()
    print("ari-net traffic -> http://%s:80" % LB, flush=True)
    while True:
        time.sleep(60)
