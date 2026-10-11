#!/usr/bin/env python3
"""Read complete nginx records by inode/byte offset; stdout is one JSON batch.

No log contents or cursor are changed. A renamed .1 log is drained before the
new file, so rotation does not duplicate or lose requests. Initial reads backfill
185 seconds, including the uncompressed rotated file.
"""
import base64
import json
import os
import sys
import time

def read_batch(log_path, cursor=None, now=None):
    now = time.time() if now is None else now
    files = []
    for name in (log_path + '.1', log_path):
        try:
            stat = os.stat(name)
            files.append((name, stat.st_ino, stat.st_size))
        except FileNotFoundError:
            pass
    if not files or files[-1][0] != log_path:
        raise RuntimeError('nginx access log is unavailable')
    entries = []
    found = not cursor
    for name, inode, size in files:
        offset = 0
        if cursor and not found:
            if inode != cursor['inode']:
                continue
            found = True
            if size < cursor['offset']:
                return {'now': now, 'entries': [], 'cursor': None, 'gap': True}
            offset = cursor['offset']
        with open(name, 'rb') as stream:
            stream.seek(offset)
            while True:
                start = stream.tell()
                line = stream.readline()
                if not line or not line.endswith(b'\n'):
                    offset = start
                    break
                offset = stream.tell()
                text = line.decode('utf-8', errors='replace').rstrip('\n')
                try:
                    timestamp = float(text.split(' ', 1)[0])
                except ValueError:
                    continue
                if timestamp >= now - 185:
                    entries.append({'id': f'{inode}:{start}', 'line': text})
    if cursor and not found:
        # More than one rotation while disconnected: explicit incomplete feed.
        return {'now': now, 'entries': [], 'cursor': None, 'gap': True}
    return {'now': now, 'entries': entries,
            'cursor': {'inode': files[-1][1], 'offset': offset}, 'gap': False}

if __name__ == '__main__':
    cursor = json.loads(base64.urlsafe_b64decode(sys.argv[1] + '=' * (-len(sys.argv[1]) % 4))) if len(sys.argv) > 1 else None
    print(json.dumps(read_batch('/var/log/nginx/ari-access.log', cursor)))
