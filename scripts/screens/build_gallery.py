"""Builds docs/screens/index.html (self-contained gallery) and a print version for screens.pdf.

Reads docs/screens/manifest.json written by capture.cjs. Images are embedded as JPEG copies of the
PNGs (the PNGs stay alongside as the record). The print version crops very tall pages to a readable
top section and says so; the full image is in index.html and the PNG.
Usage: python3 scripts/screens/build_gallery.py docs/screens
"""

import base64
import html
import io
import json
import sys
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops

OUT = Path(sys.argv[1])
manifest = json.loads((OUT / "manifest.json").read_text())

AREAS = OrderedDict(
    [
        ("dashboard", "Dashboard (seeded synthetic data, kill switch ON)"),
        ("dashboard-empty", "Dashboard empty states (empty database)"),
        ("public", "Public pages"),
        ("x402", "x402 payment challenge"),
        ("letter", "Letter (print batch PDF)"),
    ]
)


def area_of(m):
    if m["area"] == "dashboard" and (m["page"].endswith("-empty") or m["page"] == "company-not-found"):
        return "dashboard-empty"
    return m["area"]


def jpeg_b64(path, max_w, crop_ratio=None, quality=78, trim=False):
    im = Image.open(path).convert("RGB")
    if trim:
        # Print only: trim empty side margins so desktop text stays legible on a small page.
        bg = Image.new("RGB", im.size, im.getpixel((im.width - 1, im.height - 1)))
        box = ImageChops.difference(im, bg).getbbox()
        if box:
            im = im.crop((max(0, box[0] - 16), 0, min(im.width, box[2] + 16), im.height))
    cropped = False
    if crop_ratio and im.height > im.width * crop_ratio:
        im = im.crop((0, 0, im.width, int(im.width * crop_ratio)))
        cropped = True
    if im.width > max_w:
        im = im.resize((max_w, int(im.height * max_w / im.width)))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode(), cropped


pages = OrderedDict()
for m in manifest:
    key = (area_of(m), m["page"])
    pages.setdefault(key, {"meta": m, "shots": []})["shots"].append(m)

CSS = """
:root { --bg:#ffffff; --ink:#1b1f24; --muted:#5b6470; --line:#e3e7ec; --card:#f6f8fa; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#111418; --ink:#e8ebef; --muted:#9aa4b0; --line:#2a3038; --card:#181c21; --warn:#e0b252; } }
:root[data-theme="dark"] { --bg:#111418; --ink:#e8ebef; --muted:#9aa4b0; --line:#2a3038; --card:#181c21; --warn:#e0b252; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 40px 0 8px; padding-top: 12px; border-top: 2px solid var(--line); }
h3 { font-size: 16px; margin: 0 0 2px; }
.lede, .meta { color: var(--muted); }
.page { margin: 20px 0 28px; }
.route { font-family: ui-monospace, Menlo, monospace; font-size: 13px; color: var(--muted); word-break: break-all; }
.note { color: var(--warn); font-size: 14px; }
.shots { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; margin-top: 10px; }
figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px; max-width: 100%; }
figure.w1440 { flex: 1 1 640px; }
figure.w390 { flex: 0 1 300px; }
.frame { max-height: 1100px; overflow: auto; border: 1px solid var(--line); background: #fff; }
.frame img { display: block; width: 100%; height: auto; }
figcaption { font-size: 12.5px; color: var(--muted); margin-top: 6px; word-break: break-all; }
nav.toc a { color: inherit; margin-right: 12px; }
@media print {
  @page { size: 148mm 210mm; margin: 8mm; }
  body { font-size: 10.5px; }
  main { padding: 0; }
  h2 { break-before: page; margin-top: 0; border-top: 0; }
  h2:first-of-type { break-before: auto; }
  .page { break-inside: auto; }
  figure { break-inside: avoid; width: 100%; flex: none !important; }
  .frame { max-height: none; overflow: visible; border: 0; }
  .frame img { max-height: 172mm; width: auto; max-width: 100%; margin: 0 auto; }
  nav.toc { display: none; }
}
"""


def build(print_version):
    when = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    total = len(manifest)
    parts = [
        "<!doctype html><html lang='en-GB'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        "<title>Site screenshots</title>",
        f"<style>{CSS}</style></head><body><main>",
        "<h1>Agent Engine: how every page looks</h1>",
        f"<p class='lede'>{total} screenshots captured {when} with headless Chromium at 1440px (desktop) and 390px (phone). ",
        "Data: a synthetic database seeded by running the Phase 2–5 gates (each builds the Phase 1 synthetic world first), "
        "with the global kill switch ON and no network calls. Light theme only: the dashboard and demo pages have no dark styles "
        "(the two dark-mode shots show this). Seeding note: in one shared database the Phase 2 gate's \"12 drafts generated\" check "
        "and Phase 3's drift check read as failed: in one shared database the Phase 2 gate counts other gates' tasks (and the contact "
        "cooldown rightly skips companies Phase 5 already contacted), and the drift source already has 3+ complete runs from earlier gates, "
        "so its \"not judged yet\" step can't be shown. Both pass in the separate gate runs (docs/gates/). Every other criterion passed. Issues noticed while capturing: <code>ui-issues.md</code>.</p>",
    ]
    if not print_version:
        parts.append(
            "<nav class='toc'>"
            + "".join(f"<a href='#{a}'>{html.escape(t)}</a>" for a, t in AREAS.items())
            + "</nav>"
        )
    for area, title in AREAS.items():
        items = [(k, v) for k, v in pages.items() if k[0] == area]
        if not items:
            continue
        parts.append(f"<h2 id='{area}'>{html.escape(title)}</h2>")
        for (_, page), v in items:
            m = v["meta"]
            parts.append("<section class='page'>")
            parts.append(f"<h3>{html.escape(page.replace('-', ' ').capitalize())}</h3>")
            parts.append(f"<div class='route'>{html.escape(m['route'])}</div>")
            parts.append(f"<div>{html.escape(m['about'])}</div>")
            if m.get("note"):
                parts.append(f"<div class='note'>{html.escape(m['note'])}</div>")
            parts.append("<div class='shots'>")
            for s in v["shots"]:
                if print_version:
                    data, cropped = jpeg_b64(OUT / s["file"], 900, crop_ratio=1.5 if s["width"] == 1440 else 2.6, quality=72, trim=True)
                else:
                    data, cropped = jpeg_b64(OUT / s["file"], 1440 if s["width"] == 1440 else 390)
                cap = f"{s['width']}px · {s['theme']} · {s['file']}"
                if s.get("overflow_px"):
                    cap += f" · scrolls sideways by {s['overflow_px']}px"
                if cropped:
                    cap += " · top section only (full page in index.html / PNG)"
                parts.append(
                    f"<figure class='w{s['width']}'><div class='frame'><img alt='{html.escape(s['file'])}' "
                    f"src='data:image/jpeg;base64,{data}'></div><figcaption>{html.escape(cap)}</figcaption></figure>"
                )
            parts.append("</div></section>")
    parts.append("</main></body></html>")
    return "".join(parts)


(OUT / "index.html").write_text(build(False))
(OUT / "_print.html").write_text(build(True))
print("index.html", round((OUT / "index.html").stat().st_size / 1e6, 1), "MB")
