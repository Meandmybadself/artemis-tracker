#!/usr/bin/env python3
"""Dev server that proxies live AROW telemetry from NASA's GCS bucket."""

import http.server
import json
import os
import threading
import time
import urllib.parse
import urllib.request

PORT = 8090
ROOT = os.path.dirname(os.path.abspath(__file__))

# NASA AROW telemetry source
GCS_BASE = 'https://storage.googleapis.com/storage/v1/b/p-2-cen1/o'
TELEMETRY_OBJECTS = {
    'orion': 'October/1/October_105_1.txt',
    'icps': 'Io/2/Io_108_2.txt',
}

# Shared state for latest telemetry
latest_telemetry = {}
telemetry_lock = threading.Lock()


def poll_telemetry():
    """Background thread: poll GCS for fresh telemetry every 2 seconds."""
    generations = {}
    while True:
        for name, obj_path in TELEMETRY_OBJECTS.items():
            try:
                encoded = urllib.parse.quote(obj_path, safe='')
                meta_url = f'{GCS_BASE}/{encoded}'
                with urllib.request.urlopen(meta_url, timeout=5) as resp:
                    meta = json.loads(resp.read().decode())
                gen = meta.get('generation', '')
                if gen != generations.get(name):
                    generations[name] = gen
                    media_url = f'{meta_url}?alt=media&generation={gen}'
                    with urllib.request.urlopen(media_url, timeout=5) as resp2:
                        data = json.loads(resp2.read().decode())
                    with telemetry_lock:
                        latest_telemetry[name] = data
            except Exception as e:
                print(f'[telemetry] Error fetching {name}: {e}')
        time.sleep(0.5)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path == '/api/telemetry':
            with telemetry_lock:
                payload = json.dumps(latest_telemetry)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(payload.encode())
            return
        return super().do_GET()

    def log_message(self, format, *args):
        # Suppress routine request logs
        if '/api/telemetry' not in str(args):
            super().log_message(format, *args)


if __name__ == '__main__':
    t = threading.Thread(target=poll_telemetry, daemon=True)
    t.start()
    print(f'Polling NASA AROW telemetry every 2s...')

    server = http.server.HTTPServer(('', PORT), Handler)
    print(f'Serving at http://localhost:{PORT}')
    server.serve_forever()
