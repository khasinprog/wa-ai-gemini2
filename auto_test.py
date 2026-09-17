#!/usr/bin/env python3
"""Auto test flow — kirim satu per satu, tunggu Gemini reply sebelum lanjut"""

import time, json, sys, re, urllib.request

BASE = "https://app.trustiomart.com"

with open("/Users/a1/Project/wa-ai-gemini2/.env") as f:
    env = dict(line.strip().split("=", 1) for line in f if "=" in line and not line.startswith("#"))
PASS = env.get("ADMIN_PASSWORD", "")

def api(path, method="GET", body=None, token=None):
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

print("🔑 Login..."); tok = api("/api/login","POST",{"password":PASS})["token"]; print(f"   OK {tok[:10]}...")
print("🗑  Reset..."); api("/api/test/internal/reset","POST",token=tok); print("   OK\n")

FLOW = [
    "Halo kak ada pasta dempul instan?",
    "Harganya berapa kak",
    "1 botol isinya berapa gram",
    "order dong kak",
    "Khasin Khafabi",
    "Desa Tamantirto Kasihan Bantul",
    "Perum Dalem C3 RT 03 RW 05",
    "deket masjid Al-Amin",
    "iya nomor ini aja",
    "iya benar semua",
    "kapan kira kira sampainya kak",
]

SEP="━"*65
for idx, msg in enumerate(FLOW, 1):
    print(f"\n{SEP}\n TURN {idx:02d}/{len(FLOW)}\n{SEP}")
    print(f" 📤 {msg}")
    api("/api/test/internal/send","POST",{"message":msg},token=tok)
    sys.stdout.write(" ⏳"); sys.stdout.flush()
    turn=None
    for _ in range(30):
        time.sleep(3); sys.stdout.write("."); sys.stdout.flush()
        try:
            turns = api("/api/test/internal/turns",token=tok).get("turns",[])
            if len(turns)>=idx and turns[0].get("aiOutput"): turn=turns[0]; break
        except: pass
    print()
    if not turn: print(" ❌ TIMEOUT"); continue
    ai=turn.get("aiOutput",""); step=turn.get("step","-")
    val=turn.get("validation",[]); passed=sum(1 for v in val if v.get("pass"))
    print(f" 🤖 {ai[:300]}{'…' if len(ai)>300 else ''}")
    print(f" 📊 Step:{step} | Valid:{passed}/{len(val)}", end="")
    fails=[v for v in val if not v.get("pass")]
    if fails: print(f" ⚠️  {','.join(v['id'] for v in fails)}")
    else: print(" ✅")
    raw=(turn.get("geminiResponse") or {}).get("rawText","")
    if "[ORDER_DATA]" in raw:
        m=re.search(r'\[ORDER_DATA\]([\s\S]*?)\[/ORDER_DATA\]',raw)
        if m:
            try:
                od=json.loads(m.group(1).strip())
                print(f" 📦 nama={od.get('nama')} hp={od.get('hp')} bayar={od.get('pembayaran')}")
                print(f"    alamat={od.get('alamat','')[:90]}")
            except: print(" 📦 ORDER_DATA (parse error)")
    if "[ESCALATE:" in raw: print(" 📣 ESCALATE ✅")

print(f"\n{SEP}\n 🏁 SELESAI\n{SEP}")
