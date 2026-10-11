#!/usr/bin/env python3
"""ari-net load generator: a light, realistic AcmePay request mix sent to the lb.

Uses persistent keep-alive connections (one per worker thread) so the traffic
shows up as steady, long-lived TCP flows on the topology map.

Intensity + payment rate are read from /etc/ari-net/traffic.mode every 2s:
  normal -> 2 workers, ~3 req/s total, ~25% real user-to-user payments
  surge  -> 12 workers, ~45 req/s total, ~55% payments (floods money flow)

A steady share of requests are REAL payments between seeded demo users
(POST /api/payments), which drives real LB -> app -> db (+cache) traffic and
creates real transaction rows. A small share hits the crypto endpoints
(GET /api/crypto/prices, POST /api/trade) so app -> internet (crypto API) and
trade traffic also show on the map. Rates are bounded and mode-tied.
"""
import http.client, json, os, random, threading, time

LB = os.environ.get("LB_HOST", "127.0.0.1")
MODE_FILE = "/etc/ari-net/traffic.mode"

# Per mode: (active workers, think-time min, think-time max, payment share).
# Payment share is the fraction of requests that are POST /api/payments; tune
# via env without editing code.
PAY_NORMAL = float(os.environ.get("PAY_SHARE_NORMAL", "0.25"))
PAY_SURGE = float(os.environ.get("PAY_SHARE_SURGE", "0.55"))
PLAN = {
    "normal": (2, 0.5, 0.9, PAY_NORMAL),
    "surge": (12, 0.15, 0.30, PAY_SURGE),
}
# Crypto/trade share (of non-payment requests). Small but visible.
CRYPTO_SHARE = float(os.environ.get("CRYPTO_SHARE", "0.08"))

# Seeded MyFiat/AcmePay demo users (ids 1..20 from seed.js) — these always
# exist and have logins; safe payer/payee ids independent of the bulk dataset.
# User 1 is the Dana demo login; keep synthetic orders off her statement.
DEMO_USER_IDS = list(range(2, 21))
SEED_MERCHANTS = list(range(1, 8))  # seed.js creates 7 merchants
NAMES = ["James", "Maria", "Wei", "Aisha", "Carlos", "Priya", "Tom", "Sofia", "Liam", "Noor"]
STATUSES = ["succeeded", "pending", "failed", "refunded"]
COINS = ["BTC", "ETH", "SOL", "USDC", "DOGE"]
mode = "normal"

# --- synthetic "many users" source-IP pool (for a real distinct-user count) ---
# Each request carries X-Forwarded-For from a LARGE pool so the lb logs many
# distinct clients. Drawn from reserved, non-routable benchmarking/doc ranges
# (RFC 2544 198.18.0.0/15 and RFC 5737 198.51.100.0/24) so they are clearly
# synthetic. This is DISTINCT from the DDoS drill (which uses a FEW IPs at HIGH
# rate from 203.0.113.0/24). Here it is MANY IPs each at LOW rate, so no single
# IP approaches the detector's per-IP floor and it never trips ddos detection.
POOL_SIZE = int(os.environ.get("USER_IP_POOL", "2000"))   # recurring "returning users"
CHURN_PROB = float(os.environ.get("USER_IP_CHURN", "0.1")) # chance of a brand-new IP
_rnd = random.Random(1)

def _mk_ip():
    if _rnd.random() < 0.85:  # 198.18.0.0/15
        return "198.%d.%d.%d" % (_rnd.randint(18, 19), _rnd.randint(0, 255), _rnd.randint(1, 254))
    return "198.51.100.%d" % _rnd.randint(1, 254)

USER_IPS = [_mk_ip() for _ in range(POOL_SIZE)]

def client_ip():
    # Mostly returning users (recur from the pool), with steady churn of new ones.
    if random.random() < CHURN_PROB:
        return "198.%d.%d.%d" % (random.randint(18, 19), random.randint(0, 255), random.randint(1, 254))
    return random.choice(USER_IPS)


class BaselineCadence:
    """Random drift, bursts and jitter around 1 req/s, without compounding.

    Leave headroom for integer counts in five-second dashboard buckets:
    intervals of 1/1.35..1/0.65 seconds yield 3..7 requests (36..84/min).
    """
    def __init__(self, rng=None):
        self.rng = rng or random.Random()
        self.long = 0.0
        self.long_target = 0.0
        self.short = 0.0
        self.long_at = 0.0
        self.short_at = 0.0
        self.last_at = None

    def rate(self, now):
        if now >= self.long_at:
            self.long_target = self.rng.uniform(-0.25, 0.25)
            self.long_at = now + self.rng.uniform(30, 90)
        if now >= self.short_at:
            self.short = self.rng.uniform(-0.18, 0.18)
            self.short_at = now + self.rng.uniform(3, 9)
        dt = 1.0 if self.last_at is None else max(0, now - self.last_at)
        self.last_at = now
        self.long += (self.long_target - self.long) * (1 - pow(2.718281828, -dt / 15))
        noise = self.rng.uniform(-0.12, 0.12)
        return max(0.65, min(1.35, 1 + self.long + self.short + noise))


def read_mode():
    global mode
    while True:
        try:
            m = open(MODE_FILE).read().strip()
            mode = m if m in PLAN else "normal"
        except OSError:
            mode = "normal"
        time.sleep(2)


def a_payment():
    # Real user-to-user payment between two distinct seeded users. The schema's
    # POST /api/payments takes user_id (payer) + merchant_id; we record the payee
    # in the description so the money flow is a real transaction row.
    payer, payee = random.sample(DEMO_USER_IDS, 2)
    return "POST", "/api/payments", {
        "user_id": payer,
        "merchant_id": random.choice(SEED_MERCHANTS),
        "amount_cents": random.randint(99, 9900),
        "description": "Transfer to user #%d" % payee,
    }


def next_request(cur_mode):
    pay_share = PLAN[cur_mode][3]
    r = random.random()
    # Real payments first (mode-tied share).
    if r < pay_share:
        return a_payment()
    # Occasional crypto price check + trade (app -> internet / trade traffic).
    if random.random() < CRYPTO_SHARE:
        if random.random() < 0.6:
            return "GET", "/api/crypto/prices", None
        return "POST", "/api/trade", {
            "user_id": random.choice(DEMO_USER_IDS),
            "symbol": random.choice(COINS),
            "side": random.choice(["buy", "sell"]),
            "amount_cents": random.randint(500, 50000),
        }
    # Otherwise the usual read-heavy mix.
    r = random.random()
    if r < 0.34:
        return "GET", "/api/merchants", None
    if r < 0.60:
        q = random.choice(NAMES)
        if random.random() < 0.4:
            q += "&status=" + random.choice(STATUSES)
        return "GET", "/api/transactions?user=" + q, None
    if r < 0.80:
        ok = random.random() < 0.8
        return "POST", "/api/login", {"email": "admin@acmepay.io", "password": "admin123" if ok else "wrong-password"}
    if r < 0.92:
        return "GET", "/api/users/%d" % random.choice(DEMO_USER_IDS), None
    if r < 0.97:
        return "GET", "/health", None
    return "GET", random.choice(["/admin", "/api/v2/charges", "/favicon.ico", "/.env"]), None


def worker(idx):
    conn = None
    while True:
        active, lo, hi, _ = PLAN[mode]
        if idx >= active:
            if conn:
                conn.close()
                conn = None
            time.sleep(1)
            continue
        method, path, body = next_request(mode)
        try:
            if conn is None:
                conn = http.client.HTTPConnection(LB, 80, timeout=10)
            headers = {"User-Agent": "ari-net-traffic/1.0", "Connection": "keep-alive",
                       "X-Forwarded-For": client_ip()}
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


# --- community activity: real customers doing real banking ---------------------------------------
# The seed's 18 community users log in and, every few seconds, one of them sends another money
# (POST /api/transfers, credits the recipient) or buys/sells stocks or crypto (POST /api/trade).
# Each user keeps one stable source IP so the map shows them as recurring visitors.
# COMMUNITY=0 disables it; ACTIVITY_SECONDS sets the average gap between actions.
FIRST = ['James', 'Maria', 'Wei', 'Aisha', 'Carlos', 'Priya', 'Tom', 'Sofia', 'Liam', 'Noor',
         'Hiro', 'Elena', 'David', 'Fatima', 'Kenji', 'Grace', 'Omar', 'Lena', 'Victor', 'Chloe']
LAST = ['Walker', 'Santos', 'Chen', 'Khan', 'Reyes', 'Patel', 'Nguyen', 'Rossi', 'Murphy', 'Haddad',
        'Tanaka', 'Petrov', 'Cohen', 'Ali', 'Yamamoto', 'Okafor', 'Farah', 'Novak', 'Silva', 'Dubois']
PASSWORDS = ['password1', 'qwerty', 'letmein', 'hunter2', 'sunshine']
COMMUNITY = [{"email": "%s.%s%d@example.com" % (FIRST[i % 20].lower(), LAST[(i * 3) % 20].lower(), i),
              "password": PASSWORDS[i % 5], "ip": "198.51.100.%d" % (100 + i)} for i in range(18)]
STOCKS = ["AAPL", "NVDA", "MSFT", "TSLA", "AMZN", "VTI"]
CRYPTO = ["BTC", "ETH", "SOL", "DOGE", "ADA", "XRP"]
NOTES = ["dinner", "rent split", "concert tickets", "coffee", "groceries", "gas money", "birthday gift", "brunch", "Uber"]
ACTIVITY_SECONDS = float(os.environ.get("ACTIVITY_SECONDS", "3"))


def api(conn, method, path, user=None, body=None):
    headers = {"User-Agent": "myfiat-ios/4.2", "Content-Type": "application/json",
               "X-Forwarded-For": user["ip"] if user else client_ip()}
    if user and user.get("token"):
        headers["Authorization"] = "Bearer " + user["token"]
    conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    try:
        return resp.status, json.loads(raw or b"null")
    except ValueError:
        return resp.status, None


def one_action(conn, user, prices):
    if not user.get("token"):
        status, body = api(conn, "POST", "/api/login", user, {"email": user["email"], "password": user["password"]})
        if status != 200:
            return "login failed %s" % status
        user["token"] = body["token"]
    r = random.random()
    if r < 0.5:  # send a friend money
        friend = random.choice([u for u in COMMUNITY if u is not user])
        status, body = api(conn, "POST", "/api/transfers", user, {
            "to_email": friend["email"], "amount_cents": random.randint(500, 15000), "note": random.choice(NOTES)})
    else:  # trade: mostly buys, sells only what they hold
        crypto = random.random() < 0.55
        symbol = random.choice(CRYPTO if crypto else STOCKS)
        side = "buy"
        status, held = api(conn, "GET", "/api/holdings", user)
        owned = {h["symbol"]: float(h["quantity"]) for h in (held or {}).get("crypto" if crypto else "stocks", [])}
        if owned and random.random() < 0.35:
            symbol, side = random.choice(list(owned.items()))[0], "sell"
        if side == "sell":
            qty = round(owned[symbol] * random.uniform(0.2, 0.6), 6)
        elif crypto:
            price = prices.get(symbol) or 0
            qty = round(random.uniform(20, 400) * 100 / price, 6) if price else 0
        else:
            qty = random.randint(1, 3)
        if qty <= 0:
            return "skip"
        status, body = api(conn, "POST", "/api/trade", user, {
            "asset_class": "crypto" if crypto else "stock", "symbol": symbol, "side": side, "quantity": qty})
    if status == 401:
        user["token"] = None
    return status


def community_loop():
    conn, prices, priced_at = None, {}, 0
    while True:
        try:
            if conn is None:
                conn = http.client.HTTPConnection(LB, 80, timeout=10)
            user = random.choice(COMMUNITY)
            if time.time() - priced_at > 30 and user.get("token"):
                status, body = api(conn, "GET", "/api/crypto/prices", user)
                if status == 200:
                    prices = {p["symbol"]: p["price_cents"] for p in body.get("prices", [])}
                    priced_at = time.time()
            one_action(conn, user, prices)
        except (OSError, http.client.HTTPException, KeyError, TypeError):
            if conn:
                conn.close()
            conn = None
        time.sleep(random.uniform(0.5, 1.5) * ACTIVITY_SECONDS)


if __name__ == "__main__":
    if os.environ.get("COMMUNITY", "1") != "0":
        threading.Thread(target=community_loop, daemon=True).start()
    if os.environ.get('DEMO_PROFILE') == '1':
        # Variable real traffic around one request per second, five recurring clients.
        index = 0
        cadence = BaselineCadence()
        while True:
            started = time.monotonic()
            interval = 1 / cadence.rate(started)
            conn = http.client.HTTPConnection(LB, 80, timeout=2)
            try:
                path = ['/api/users/1', '/api/users/2', '/health', '/api/merchants', '/api/users/3'][index % 5]
                conn.request('GET', path, headers={'X-Forwarded-For': '198.51.100.' + str(20 + index % 5), 'User-Agent': 'ari-demo-baseline/2.0'})
                conn.getresponse().read()
            except (OSError, http.client.HTTPException):
                pass
            finally:
                conn.close()
            index += 1
            time.sleep(max(0, interval - (time.monotonic() - started)))
    threading.Thread(target=read_mode, daemon=True).start()
    for i in range(PLAN["surge"][0]):
        threading.Thread(target=worker, args=(i,), daemon=True).start()
    print("ari-net traffic -> http://%s:80 (payments normal=%.0f%% surge=%.0f%%)"
          % (LB, PAY_NORMAL * 100, PAY_SURGE * 100), flush=True)
    while True:
        time.sleep(60)
