#!/usr/bin/env python3
"""Bounded request drill. Installed on the owned traffic node by demo prepare."""
import concurrent.futures
import http.client
import json
import signal
import sys
import threading
import time

IPS = ['203.0.113.' + str(i) for i in range(10, 15)]
PATHS = ['/api/users/1', '/api/users/2', '/health', '/api/merchants']

def run(host, ceiling, seconds=60, concurrency=16):
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    blocked = set()
    lock = threading.Lock()
    counts = {'sent': 0, 'completed': 0, 'blocked': 0, 'failed': 0}
    started = time.monotonic()
    slots = threading.Semaphore(concurrency)

    def request(index):
        ip = IPS[index % len(IPS)]
        conn = None
        try:
            with lock:
                if ip in blocked:
                    return
                counts['sent'] += 1
            conn = http.client.HTTPConnection(host, 80, timeout=2)
            conn.request('GET', PATHS[index % len(PATHS)], headers={
                'X-Forwarded-For': ip, 'User-Agent': 'ari-demo-drill/2.0'})
            response = conn.getresponse()
            response.read()
            with lock:
                counts['completed'] += 1
                if response.status == 403:
                    blocked.add(ip)
                    counts['blocked'] += 1
                    if len(blocked) == len(IPS):
                        stop.set()
        except (OSError, http.client.HTTPException):
            with lock:
                counts['failed'] += 1
        finally:
            if conn:
                conn.close()
            slots.release()

    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        for index in range(ceiling):
            elapsed = time.monotonic() - started
            if stop.is_set() or elapsed >= seconds:
                break
            slots.acquire()
            if stop.is_set():
                slots.release()
                break
            pool.submit(request, index)
            # Fast opening burst, then a sustainable rate above detection floor.
            stop.wait(1 / (100 if elapsed < 8 else 20))
            if index % 100 == 0:
                print(json.dumps({**counts, 'elapsed': round(elapsed, 1)}), flush=True)
    print(json.dumps({**counts, 'elapsed': round(time.monotonic() - started, 1),
                      'blocked_ips': sorted(blocked)}), flush=True)

if __name__ == '__main__':
    host, ceiling = sys.argv[1:3]
    # Deployment resolves the fleet; this executable also refuses public targets.
    if not host.startswith('192.168.'):
        raise SystemExit('drill requires the owned fleet private load-balancer IP')
    run(host, min(6000, max(100, int(ceiling))))
