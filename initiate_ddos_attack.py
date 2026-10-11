#!/usr/bin/env python3
"""Launch the owned-fleet drill: python3 initiate_ddos_attack.py."""
import ipaddress
import json
import os
import subprocess
import urllib.request

API = os.environ.get('FLEET_API', 'http://localhost:8090').rstrip('/')

def get(path):
    with urllib.request.urlopen(API + path, timeout=5) as response:
        return json.load(response)

def main():
    status = get('/api/demo/status')
    metrics = status['metrics']
    total = metrics.get('requestsLast180s')
    if metrics.get('stale') or total is None or not 90 <= total <= 600:
        raise SystemExit('Baseline is not ready (need 90–600 actual requests in 3 min). Run demo preflight.')
    if status['incident']['active']:
        raise SystemExit('An incident is already active. Run demo reset before another take.')
    if not status.get('standby') or status['standby'].get('servingState') != 'standby':
        raise SystemExit('web-03 is not on standby. Run demo prepare/reset.')
    if status['incident'].get('blockedIps'):
        raise SystemExit('Incident blocklist is not reset.')
    nodes = get('/api/fleet')['nodes']
    lb = next(n for n in nodes if n['role'] == 'lb' and n['status'] == 'running')
    traffic = next(n for n in nodes if n['role'] == 'traffic' and n['status'] == 'running')
    public = str(ipaddress.IPv4Address(traffic['publicIp']))
    private = str(ipaddress.IPv4Address(lb['privateIp']))
    if not private.startswith('192.168.'):
        raise SystemExit('Expected private fleet load balancer')
    ceiling = min(6000, total * 8)
    print(f'Initiating MyFiat request drill against {lb["label"]}.', flush=True)
    print(f'5 attacker identities · baseline {total} requests/3 min · cap {ceiling} requests/60 sec', flush=True)
    command = f'systemd-run --unit=ari-demo-attack --collect --wait --pipe --property=RuntimeMaxSec=65 /usr/bin/python3 -u /opt/ari-net/demo-ddos.py {private} {ceiling}'
    try:
        return subprocess.call(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', f'root@{public}', command])
    except KeyboardInterrupt:
        subprocess.run(['ssh', '-o', 'BatchMode=yes', f'root@{public}', 'systemctl stop ari-demo-attack'], timeout=8, check=False)
        return 130

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, StopIteration) as error:
        raise SystemExit(f'Drill could not start: {error}')
