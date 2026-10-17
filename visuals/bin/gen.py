#!/usr/bin/env python3
# usage: gen.py name try size prompt_file [ref_url]
# Pattern copied from ~/tsp-improve-work/art/gen.py. Enforces a hard budget of 16 calls via logs/calls.txt.
import json, subprocess, sys, os, time
V = "/Users/mike/hackathon-intel-2026-10-17/run6h/builds/paid-tonight/visuals"
BUDGET = 16
name, tr, size, pf = sys.argv[1:5]
ref = sys.argv[5] if len(sys.argv) > 5 else None
ledger = f"{V}/logs/calls.txt"
used = len(open(ledger).read().splitlines()) if os.path.exists(ledger) else 0
if used >= BUDGET:
    print(f"BUDGET EXHAUSTED ({used}/{BUDGET})"); sys.exit(2)
prompt = open(pf).read().strip()
data = {"model": "gemini-3-pro-image-preview", "prompt": prompt, "size": size, "resolution": "2K"}
if ref: data["image_urls"] = [ref]
cmd = ["/Users/mike/.local/bin/treg", "call", "reapi.image-gen.gemini-3-pro-image", "--method", "POST",
       "--data", json.dumps(data), "--await", "--timeout", "900"]
with open(ledger, "a") as f:
    f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {name}-t{tr} {size} {os.path.basename(pf)}\n")
t0 = time.time()
p = subprocess.run(cmd, capture_output=True, text=True)
open(f"{V}/logs/{name}-t{tr}.json", "w").write(json.dumps({"prompt": prompt, "ref": ref, "stdout": p.stdout, "stderr": p.stderr, "secs": time.time()-t0}, indent=1))
out = p.stdout
try:
    j = json.loads(out[out.index("{"):])
except Exception:
    print("PARSE FAIL", out[:800], p.stderr[:800]); sys.exit(1)
def find(o):
    if isinstance(o, dict):
        if "image_urls" in o: return o["image_urls"]
        for v in o.values():
            r = find(v)
            if r: return r
    if isinstance(o, list):
        for v in o:
            r = find(v)
            if r: return r
urls = find(j)
if not urls: print("NO URLS", out[:1500]); sys.exit(1)
for i, u in enumerate(urls):
    ext = ".png" if ".png" in u.lower() else (".jpg" if ".jp" in u.lower() else ".png")
    fn = f"{V}/raw/{name}-t{tr}" + (f"-{i}" if i else "") + ext
    subprocess.run(["curl", "-sSL", "-o", fn, u], check=True)
    print("SAVED", fn, os.path.getsize(fn), "url", u)
print(f"calls used {used+1}/{BUDGET}, secs {time.time()-t0:.0f}")
