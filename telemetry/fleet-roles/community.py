#!/usr/bin/env python3
"""MyFiat community simulation: the seed's 18 customers doing real banking through the lb.

Every few seconds one of them sends another money (POST /api/transfers, credits the recipient)
or buys/sells stocks or crypto at live prices (POST /api/trade). Runs as its own service
(ari-community) so the fleet controller's traffic.py redeploys don't touch it.
Env: LB_HOST (default 127.0.0.1), ACTIVITY_SECONDS (default 3).
"""
import http.client, json, os, random, time

LB = os.environ.get("LB_HOST", "127.0.0.1")


def client_ip():
    return "198.51.100.%d" % random.randint(1, 99)


# --- community activity: real customers doing real banking ---------------------------------------
# The seed's 18 community users log in and, every few seconds, one of them sends another money
# (POST /api/transfers, credits the recipient) or buys/sells stocks or crypto (POST /api/trade).
# Each user keeps one stable source IP so the map shows them as recurring visitors.
# ACTIVITY_SECONDS sets the average gap between actions.
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
            print(user["email"].split("@")[0], one_action(conn, user, prices), flush=True)
        except (OSError, http.client.HTTPException, KeyError, TypeError):
            if conn:
                conn.close()
            conn = None
        time.sleep(random.uniform(0.5, 1.5) * ACTIVITY_SECONDS)



if __name__ == "__main__":
    print("myfiat community sim -> http://%s:80 every ~%.0fs" % (LB, ACTIVITY_SECONDS), flush=True)
    community_loop()
