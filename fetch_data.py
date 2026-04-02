#!/usr/bin/env python3
"""Fetch Artemis II trajectory data from JPL Horizons and save as local JSON."""

import json
import urllib.request
import urllib.parse
import os

API_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api'
DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

MISSION_START = '2026-04-02 02:00'
MISSION_END = '2026-04-10 23:00'
STEP = '10 min'

TARGETS = {
    'orion': '-1024',
    'moon': '301',
}

def fetch(command, center='500@399'):
    params = urllib.parse.urlencode({
        'format': 'json',
        'COMMAND': f"'{command}'",
        'EPHEM_TYPE': "'VECTORS'",
        'START_TIME': f"'{MISSION_START}'",
        'STOP_TIME': f"'{MISSION_END}'",
        'CENTER': f"'{center}'",
        'STEP_SIZE': f"'{STEP}'",
        'VEC_TABLE': "'2'",
        'VEC_LABELS': "'NO'",
        'CSV_FORMAT': "'YES'",
    })
    url = f'{API_BASE}?{params}'
    print(f'  Fetching {url[:100]}...')
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode())

def parse_vectors(result_text):
    soe = result_text.index('$$SOE')
    eoe = result_text.index('$$EOE')
    block = result_text[soe+5:eoe].strip()
    lines = [l.strip() for l in block.split('\n') if l.strip()]

    points = []
    for line in lines:
        # Each line: JDTDB, CalDate, X, Y, Z, VX, VY, VZ,
        parts = [p.strip() for p in line.split(',') if p.strip()]
        jd = float(parts[0])
        cal = parts[1].replace('A.D. ', '')
        points.append({
            'jd': jd,
            'cal': cal,
            'x': float(parts[2]),
            'y': float(parts[3]),
            'z': float(parts[4]),
            'vx': float(parts[5]),
            'vy': float(parts[6]),
            'vz': float(parts[7]),
        })
    return points

for name, cmd in TARGETS.items():
    print(f'Fetching {name} ({cmd})...')
    resp = fetch(cmd)
    points = parse_vectors(resp['result'])
    out_path = os.path.join(DATA_DIR, f'{name}.json')
    with open(out_path, 'w') as f:
        json.dump(points, f)
    print(f'  Wrote {len(points)} points to {out_path}')

print('Done.')
