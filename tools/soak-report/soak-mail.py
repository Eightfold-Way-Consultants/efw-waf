#!/usr/bin/env python3
"""Weekly Turnstile soak report mail, run on figaro (replaces the Windows soak-mail.ps1).

  1. node soak-report.js --env prod --hours 168, writing the rich report and the email-safe render
  2. screenshot the combined stage-flow card to PNG (Playwright venv); Gmail cannot show the SVG
  3. publish the PNG with figaro-public (public, random-suffix name) so the mail can inline it by
     URL, and the rich report with figaro-share (tailnet only) for the "full report" link
  4. send the HTML body to Jack's work inbox through figaro_mail (gog-safe)

A failed PNG step drops the diagram block and still sends; any other failure mails the failing
step instead. Scheduled by ~/machine/gen-backup-agents.sh (job soak-report, Mondays 07:37).

  soak-mail.py              run and send
  soak-mail.py --no-send    run everything except the send; print the body path
  soak-mail.py --dry-run    check the tools are present, run nothing (used at registration)
"""
import datetime
import glob
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.expanduser("~/machine"))
import figaro_mail as fm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TO = "jeastman@eightfoldway.com"
HOURS = "168"
PW_PYTHON = os.path.expanduser("~/.local/venv/playwright/bin/python")
PUBLIC_DIR = os.path.expanduser("~/public-site")
KEEP_DAYS = 90  # old flow PNGs are removed from the public site after this
LOG = os.path.expanduser("~/Library/Logs/claude-rc/soak-report.log")
TOOLS = ["node", "aws", "curl", "figaro-public", "figaro-share", PW_PYTHON]

# Element screenshot of the first (combined) flow card, light theme, 2x for a crisp phone render.
SHOT = """
import os, sys
# figaro keeps browsers in ~/.cache, not the macOS default ~/Library/Caches (same as fetch-page.py)
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", os.path.expanduser("~/.cache/ms-playwright"))
from playwright.sync_api import sync_playwright
src, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1040, "height": 900}, device_scale_factor=2, color_scheme="light")
    pg.goto("file://" + src)
    pg.locator(".flow-card").first.screenshot(path=out)
    b.close()
"""


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(f"{datetime.datetime.now().astimezone():%Y-%m-%d %H:%M:%S %Z}  {msg}\n")


def run(cmd, timeout):
    """Run without a terminal; return stdout. Raise with the last stderr line on failure."""
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    for ln in (r.stdout + r.stderr).splitlines():
        log(f"  {os.path.basename(cmd[0])}: {ln}")
    if r.returncode != 0:
        last = [ln for ln in (r.stderr or r.stdout).splitlines() if ln.strip()]
        raise RuntimeError(last[-1] if last else f"{cmd[0]} exited {r.returncode}")
    return r.stdout


def url_of(out):
    urls = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("https://")]
    if not urls:
        raise RuntimeError("no URL in output")
    return urls[-1]


def prune_public():
    cutoff = time.time() - KEEP_DAYS * 86400
    old = [os.path.basename(p) for p in glob.glob(os.path.join(PUBLIC_DIR, "soak-flow-*.png"))
           if os.path.getmtime(p) < cutoff]
    if old:
        run(["figaro-public", "--rm", *old], 300)


def main():
    args = sys.argv[1:]
    if "--dry-run" in args:
        missing = [t for t in TOOLS if not (shutil.which(t) or os.access(t, os.X_OK))]
        if missing:
            print("missing: " + ", ".join(missing))
            return 1
        print("soak-mail: tools present")
        return 0

    date = datetime.date.today().isoformat()
    rich = os.path.join(HERE, f"soak-report-prod-{date}.html")
    email = os.path.join(HERE, "soak-email-prod.html")
    png = os.path.join(HERE, f"soak-flow-{date}.png")
    step = "generate report"
    try:
        log(f"start: node soak-report.js --env prod --hours {HOURS}")
        out = run(["node", os.path.join(HERE, "soak-report.js"), "--env", "prod", "--hours", HOURS,
                   "--out", rich, "--email-out", email], 1800)
        m = re.search(r"verdict=(\w+)", out)
        verdict = {"good": "GREEN", "warning": "YELLOW", "critical": "RED"}.get(m.group(1) if m else "", "UNKNOWN")
        body = open(email, encoding="utf-8").read()

        step = "flow diagram"
        try:
            run([PW_PYTHON, "-c", SHOT, rich, png], 300)
            img = url_of(run(["figaro-public", png], 300))
            body = body.replace("{{FLOW_IMG}}", img)
            prune_public()
        except Exception as e:  # noqa: BLE001  -- the mail is still worth sending without the picture
            log(f"flow diagram skipped: {e}")
            body = re.sub(r"<!--FLOW-->.*?<!--/FLOW-->", "", body, flags=re.S)

        step = "publish full report"
        full = url_of(run(["figaro-share", rich], 300))
        body = body.replace("{{FULL_URL}}", full).replace("<!--SIGNATURE-->", fm.signature())

        subject = f"Turnstile weekly: {verdict}, week ending {date}"
        if "--no-send" in args:
            with open(email, "w", encoding="utf-8") as f:
                f.write(body)
            print(f"{subject}\nbody: {email}")
            return 0
        step = "send"
        if not fm.send(subject, body, to=TO):
            raise RuntimeError("gog-safe send failed (see stderr)")
        log(f"sent: {subject}")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"FAILED at {step}: {e}")
        fm.send("FAILED: Turnstile soak report", fm.failure(f"Weekly soak report ({step})", str(e), LOG), to=TO)
        return 1


if __name__ == "__main__":
    sys.exit(main())
