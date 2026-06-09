#!/usr/bin/env python3
"""
generate-iis-rate-report.py — v3
Reads IIS log files for a given date, generates an HTML rate analysis report.
Features:
  - Full-range histogram (one bin per rate, no suppression)
  - Classification table with ranges and interpretations
  - Per-IP evidence table (peak, total, sites, URLs, status, class)
  - Usage patterns for high-rate users (human walking vs probing)
  - Sustained high-rate IP detection
"""
import argparse, os, sys, re
from collections import defaultdict, Counter
from pathlib import Path

ALERT_THRESHOLD = 20

# Site name mapping — discovered from known DB101 IIS config
SITE_MAP = {
    '4': 'ak.db101.org', '10': 'az.db101.org', '12': 'az-es.db101.org',
    '14': 'ca.db101.org', '16': 'ca-es.db101.org', '18': 'co.db101.org',
    '20': 'co-es.db101.org', '22': 'ga.db101.org', '26': 'mi.db101.org',
    '28': 'mn.db101.org', '30': 'il.db101.org', '32': 'il-es.db101.org',
    '36': 'ky.db101.org', '38': 'nc.db101.org', '40': 'nc-es.db101.org',
    '45': 'nj.db101.org', '54': 'nj-es.db101.org', '6': 'www.db101.org',
    '8': 'oh.db101.org', '56': 'ia.db101.org',
}

def get_field_indices(header_line):
    fields = header_line.replace('#Fields:', '').split()
    return {f: i for i, f in enumerate(fields)}

def classify_pattern(ip_data):
    """Classify an IP's usage pattern based on URL sequence."""
    urls = ip_data['urls']
    total = ip_data['total']
    unique = len(urls)
    
    if unique == 1 and total > 10:
        return 'SINGLE-URL FLOOD', '#e74c3c'
    
    flow = ['index', 'start', 'query', 'confirm', 'results', 'saved']
    seq = ip_data['timeline']  # list of (minute, url)
    found = []
    for _, u in seq:
        u_lower = u.lower()
        for f in flow:
            if f in u_lower and (not found or found[-1] != f):
                found.append(f)
    
    if any(x in ''.join(found).lower() for x in ['startqueryconfirm', 'startqueryresult', 'startquery']):
        return 'WALKING', '#27ae60'
    
    if unique / total < 0.15:
        return 'REPETITIVE', '#e67e22'
    
    # Check for probing / random paths
    sensitive = ['root', 'admin', 'test', 'backup', 'wp-', '.env', 'phpmyadmin']
    if any(s in ' '.join(urls).lower() for s in sensitive):
        return 'PROBING', '#e74c3c'
    
    if 'query' in ' '.join(urls).lower() or 'confirm' in ' '.join(urls).lower():
        return 'WALKING', '#27ae60'
    
    return 'SCANNING', '#e67e22'

def main():
    args = parse_args()
    whitelist = set(args.whitelist.split())
    date_str = args.date
    log_dir = Path(args.log_dir)
    log_files = sorted(log_dir.glob('W3SVC*/u_ex*.log'))
    if not log_files:
        print(f"ERROR: No log files found in {log_dir}", file=sys.stderr)
        sys.exit(1)

    all_buckets = []
    ip_data = defaultdict(lambda: {
        'total': 0, 'urls': set(), 'sites': set(), 'status': Counter(), 'timeline': []
    })
    site_req = Counter()
    total_req = 0

    for log_file in log_files:
        site_id = log_file.parent.name.replace('W3SVC', '')
        site_name = SITE_MAP.get(site_id, f'W3SVC{site_id}')
        fields = None
        time_idx = cip_idx = uri_idx = status_idx = None

        with open(log_file, errors='replace') as fh:
            for line in fh:
                if line.startswith('#Fields:'):
                    idx_map = get_field_indices(line)
                    time_idx = idx_map.get('time')
                    cip_idx = idx_map.get('c-ip')
                    uri_idx = idx_map.get('cs-uri-stem')
                    status_idx = idx_map.get('sc-status')
                    break

        if time_idx is None or cip_idx is None or uri_idx is None:
            continue

        max_idx = max(time_idx, cip_idx, uri_idx, status_idx or 0)
        site_count = 0

        with open(log_file, errors='replace') as fh:
            for line in fh:
                if line.startswith('#'):
                    continue
                parts = line.split()
                if len(parts) <= max_idx:
                    continue

                uri = parts[uri_idx]
                if '/planning/' not in uri:
                    continue
                ip = parts[cip_idx]
                if ip in whitelist:
                    continue
                status = parts[status_idx] if status_idx is not None else '200'
                if not status.startswith('2') and not status.startswith('3'):
                    continue

                time_val = parts[time_idx]
                minute = time_val[:5]
                all_buckets.append((ip, minute, site_name))
                site_count += 1
                d = ip_data[ip]
                d['total'] += 1
                d['urls'].add(uri)
                d['sites'].add(site_name)
                d['status'][status] += 1
                d['timeline'].append((minute, uri))

        site_req[site_name] = site_count
        total_req += site_count

    # Histogram — one bin per rate (1 to max), no suppression
    ip_minute_counts = Counter((ip, minute) for ip, minute, site in all_buckets)
    rate_histogram = Counter(ip_minute_counts.values())
    max_rate = max(rate_histogram.keys(), default=0)

    # Per-IP peak rates
    ip_peaks = Counter()
    for (ip, minute), count in ip_minute_counts.items():
        ip_peaks[ip] = max(ip_peaks[ip], count)

    # Sustained high-rate IPs
    sustained = {}
    for ip, counts in ip_minute_counts.items():
        ip, minute = ip
        if counts > ALERT_THRESHOLD:
            sustained.setdefault(ip, []).append((minute, counts))
    sustained_ips = {ip: slots for ip, slots in sustained.items() if len(slots) >= 2}

    # Sorted IPs by peak
    sorted_ip_peaks = ip_peaks.most_common(30)

    # Generate HTML
    date_fmt = f"20{date_str[:2]}-{date_str[2:4]}-{date_str[4:6]}"
    active_sites = sum(1 for c in site_req.values() if c > 0)
    total_sites = len(site_req)
    alert_class = 'alert' if sustained_ips else 'clean'
    alert_text = (f"⚠️ ALERT — {len(sustained_ips)} IP(s) exceeded {ALERT_THRESHOLD} req/min in 2+ minutes"
                  if sustained_ips else "✅ ALL CLEAR — no sustained threshold violations")

    # Vertical bar histogram
    vcols = []
    max_bucket = max(rate_histogram.values(), default=1)
    for r in range(1, max_rate + 1):
        c = rate_histogram.get(r, 0)
        h = round((c / max_bucket) * 200) if c > 0 else 2
        bg = '#4285f4' if c > 0 else '#dce8f7'
        vcols.append(f'<div style="display:inline-flex;flex-direction:column;align-items:center;min-width:42px">'
                     f'<span style="font-size:12px;font-weight:700;margin-bottom:3px;color:#111">{c if c>0 else "0"}</span>'
                     f'<div style="width:32px;height:200px;background:#f5f5f5;position:relative;border:1px solid #eee">'
                     f'<div style="position:absolute;bottom:0;width:100%;height:{h}px;background:{bg}"></div></div>'
                     f'<span style="font-size:11px;color:#888;margin-top:4px;font-weight:600">{r}</span></div>')

    # Classification table
    ranges = [('1 req/min', 1, 1), ('2-5 req/min', 2, 5), ('6-11 req/min', 6, 11),
              ('12-19 req/min', 12, 19), ('20+ req/min', 20, None)]
    total_buckets = sum(rate_histogram.values())
    cl_rows = ''
    for label, lo, hi in ranges:
        cnt = sum(v for r, v in rate_histogram.items() if r >= lo and (hi is None or r <= hi))
        pct = round(cnt / total_buckets * 100, 1) if total_buckets else 0
        interp = 'Human' if hi is not None and hi <= 11 else ('Dead zone' if hi is not None and hi <= 19 else 'Bot threshold')
        cl_rows += f'<tr><td>{label}</td><td>{cnt}</td><td>{pct}%</td><td>{interp}</td></tr>\n'

    # Top offenders
    offenders = {ip: d['peak'] for ip, d in sorted([(ip, {'peak': cnt}) for ip, cnt in ip_peaks.items()], key=lambda x: -x[1]['peak']) if cnt > ALERT_THRESHOLD}

    # Site rows
    all_sites = sorted(site_req.keys(), key=lambda s: -site_req[s])
    site_html = ''
    for s in all_sites:
        r = site_req[s]
        cls = 'zero' if r == 0 else 'low' if r < 50 else 'med' if r < 500 else 'high'
        site_html += f'<tr><td><code>{s}</code></td><td class="{cls}">{r}</td></tr>\n'

    # IP evidence rows
    ip_rows = ''
    for ip, peak in sorted_ip_peaks:
        d = ip_data[ip]
        urls_sample = sorted(d['urls'])[:8]
        urls_extra = f'<br>+{len(d["urls"])-8} more' if len(d['urls']) > 8 else ''
        sites_str = ', '.join(sorted(d['sites'])[:3])
        status_str = ', '.join(f'{k}={v}' for k, v in sorted(d['status'].items()))
        pattern, pcolor = classify_pattern(d)
        peak_color = '#e74c3c' if peak > ALERT_THRESHOLD else '#27ae60'
        ip_rows += (
            f'<tr><td style="font-family:monospace;font-weight:600;font-size:12px">{ip}</td>'
            f'<td style="font-weight:700;text-align:center;color:{peak_color}">{peak}</td>'
            f'<td style="text-align:center">{d["total"]}</td>'
            f'<td style="font-size:11px;color:#555">{sites_str}</td>'
            f'<td style="font-size:10px;color:#444;word-break:break-word;max-width:260px">'
            f'{"<br>".join(urls_sample)}{urls_extra}</td>'
            f'<td style="text-align:center;font-size:10px">{status_str}</td>'
            f'<td style="text-align:center"><span style="color:{pcolor};font-weight:600;font-size:11px">{pattern}</span></td></tr>\n'
        )
    remaining = len(ip_peaks) - len(sorted_ip_peaks)
    if remaining > 0:
        ip_rows += f'<tr><td colspan="7" style="text-align:center;color:#888;padding:10px;font-size:11px">+ {remaining} additional IPs at lower rates.</td></tr>\n'

    bars = '\n    '.join(vcols)

    dead_count = sum(v for r, v in rate_histogram.items() if 12 <= r <= 19)

    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>IIS Rate Analysis - {date_fmt}</title>
<style>
* {{ box-sizing:border-box;margin:0;padding:0; }}
body {{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f6f8;color:#111;line-height:1.6;font-size:13px;padding:20px; }}
.container {{ max-width:1100px;margin:0 auto; }}
h1 {{ font-size:20px;margin-bottom:4px; }}
h2 {{ font-size:15px;margin:24px 0 10px;border-bottom:2px solid #d0d0d0;padding-bottom:4px; }}
.meta {{ color:#555;font-size:11px;margin-bottom:16px; }}
.meta span {{ margin-right:16px; }}
.summary-grid {{ display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px; }}
.stat-card {{ background:#fff;border:1px solid #ccc;border-radius:6px;padding:12px; }}
.stat-card .label {{ font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#666;margin-bottom:4px; }}
.stat-card .value {{ font-size:22px;font-weight:700;color:#27ae60; }}
.stat-card .sub {{ font-size:10px;color:#666;margin-top:2px; }}
table {{ width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #ccc;font-size:12px;margin-bottom:16px; }}
th {{ background:#eef0f3;text-align:left;padding:8px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#555;border-bottom:2px solid #d0d0d0; }}
td {{ padding:6px;border-bottom:1px solid #eee;vertical-align:top; }}
tr:last-child td {{ border-bottom:none; }}
tr:nth-child(even) td {{ background:#fafbfc; }}
td.zero {{ color:#ccc; }} td.low {{ color:#155724; }}
td.med {{ color:#856404; }} td.high {{ color:#721c24;font-weight:bold; }}
.status-banner {{ padding:16px;border-radius:8px;margin-bottom:20px;font-size:16px;font-weight:bold; }}
.status-banner.clean {{ background:#d4edda;color:#155724; }}
.status-banner.alert {{ background:#f8d7da;color:#721c24; }}
.gap-zone {{ background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:6px 10px;margin:12px 0;font-size:12px;color:#856404; }}
</style>
</head><body><div class="container">
<h1>IIS /planning/ Rate Analysis - {date_fmt}</h1>
<div class="meta">
    <span>Date: {date_fmt}</span>
    <span>Filter: /planning/ URLs, HTTP 2xx/3xx</span>
    <span>Whitelist: {', '.join(sorted(whitelist))}</span>
</div>
<div class="status-banner {alert_class}">{alert_text}</div>

<div class="summary-grid">
    <div class="stat-card"><div class="label">Total Requests</div><div class="value">{total_req:,}</div><div class="sub">Planning-only</div></div>
    <div class="stat-card"><div class="label">Unique IPs</div><div class="value">{len(ip_peaks)}</div><div class="sub">After whitelist</div></div>
    <div class="stat-card"><div class="label">Max Peak Rate</div><div class="value">{max_rate} req/min</div><div class="sub">Threshold: {ALERT_THRESHOLD}</div></div>
</div>

<h2>Full-Range Histogram</h2>
<p style="font-size:11px;color:#666;margin-bottom:14px">Each column = one peak req/min rate. Number above bar = IP-minute pairs at that rate.</p>
<div style="background:#fff;border:1px solid #ccc;border-radius:6px;padding:20px 12px 16px;overflow-x:auto">
    <div style="display:flex;gap:3px;align-items:flex-end;justify-content:center">{bars}</div>
</div>
<div class="gap-zone"><strong>Dead zone (12–19 req/min):</strong> {dead_count} IP-minute buckets.</div>

<h2>Classification</h2>
<table style="max-width:500px">
    <thead><tr><th>Rate Range</th><th>Buckets</th><th>Pct</th><th>Interpretation</th></tr></thead>
    <tbody>{cl_rows}</tbody>
</table>

<h2>Sites by Volume</h2>
<table>
    <thead><tr><th>Site</th><th>Requests</th></tr></thead>
    <tbody>{site_html}</tbody>
</table>

<h2>Per-IP Evidence (Top {min(30, len(ip_peaks))})</h2>
<p style="font-size:11px;color:#666;margin-bottom:8px">Sorted by peak req/min descending.</p>
<table>
    <thead><tr><th>IP</th><th style="text-align:center;width:50px">Peak</th><th style="text-align:center;width:60px">Total</th>
    <th style="width:100px">Site(s)</th><th>URLs</th><th style="width:90px">Status</th><th style="text-align:center;width:90px">Pattern</th></tr></thead>
    <tbody>{ip_rows}</tbody>
</table>

<div style="text-align:center;color:#888;font-size:11px;margin-top:32px">IIS Rate Analysis - {date_fmt}</div>
</div></body></html>"""

    with open(args.output, 'w', encoding='utf-8') as fh:
        fh.write(html)
    print(f"Wrote {args.output}")

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--date', required=True)
    p.add_argument('--log-dir', required=True)
    p.add_argument('--whitelist', default='52.8.7.0 127.0.0.1 ::1')
    p.add_argument('--output', required=True)
    p.add_argument('--sustained-threshold', type=int, default=10)
    p.add_argument('--sustained-minutes', type=int, default=2)
    p.add_argument('--top-n', type=int, default=25)
    return p.parse_args()

if __name__ == '__main__':
    main()
