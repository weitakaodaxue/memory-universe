"""Build fixture exports for every supported format, then run the exporter on them."""
import json
import os
import subprocess
import sys
import tempfile

PY = sys.executable
ROOT = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.join(ROOT, "export_memory.py")
TMP = os.path.join(tempfile.gettempdir(), "mu-fixtures")
os.makedirs(TMP, exist_ok=True)

# --- ChatGPT ---------------------------------------------------------------
chatgpt = [{
    "id": "c1",
    "title": "Rust 所有权到底在防什么",
    "create_time": 1700000000,
    "mapping": {
        "a": {"message": {"author": {"role": "user"},
                          "content": {"parts": ["借用检查器在防什么？"]},
                          "create_time": 1700000001}},
        "b": {"message": {"author": {"role": "assistant"},
                          "content": {"parts": ["防止悬垂引用和数据竞争。"]},
                          "create_time": 1700000002}},
        "c": {"message": {"author": {"role": "system"},
                          "content": {"parts": ["ignore me"]},
                          "create_time": 1700000000}},
        "d": {"message": None},
    },
}]
p = os.path.join(TMP, "chatgpt.json")
json.dump(chatgpt, open(p, "w", encoding="utf-8"), ensure_ascii=False)

# --- Claude ---------------------------------------------------------------
claude = [{
    "uuid": "u1",
    "name": "面包为什么发不起来",
    "created_at": "2024-03-01T10:00:00Z",
    "chat_messages": [
        {"sender": "human", "text": "面团没发起来", "created_at": "2024-03-01T10:00:05Z"},
        {"sender": "assistant", "text": "酵母失活了，水温别超过 40 度。",
         "created_at": "2024-03-01T10:00:09Z"},
    ],
}]
p = os.path.join(TMP, "claude.json")
json.dump(claude, open(p, "w", encoding="utf-8"), ensure_ascii=False)

# --- Cursor (JSON dump in the same shape as the vscdb blob) ---------------
cursor = {"tabs": [{
    "tabId": "t1",
    "chatTitle": "这条分组查询太慢",
    "bubbles": [
        {"type": "user", "text": "这条 group by 要 8 秒"},
        {"type": "ai", "text": "给 (a,b) 加联合索引，别在 where 里套函数。"},
    ],
}]}
p = os.path.join(TMP, "cursor.json")
json.dump(cursor, open(p, "w", encoding="utf-8"), ensure_ascii=False)

# --- generic --------------------------------------------------------------
generic = [{
    "title": "502 和 504 的区别",
    "createdAt": 1710000000000,
    "messages": [
        {"role": "user", "text": "网关报 502 和 504 有什么不同"},
        {"role": "assistant", "text": "502 是上游给了错误响应，504 是上游没在超时前响应。"},
    ],
}]
p = os.path.join(TMP, "generic.json")
json.dump(generic, open(p, "w", encoding="utf-8"), ensure_ascii=False)

cases = [
    ("chatgpt", os.path.join(TMP, "chatgpt.json"), 2),
    ("claude", os.path.join(TMP, "claude.json"), 2),
    ("cursor", os.path.join(TMP, "cursor.json"), 2),
    ("json", os.path.join(TMP, "generic.json"), 2),
]

bad = 0
for fmt, path, want_msgs in cases:
    out = os.path.join(TMP, "out-%s.json" % fmt)
    proc = subprocess.run(
        [PY, EXPORT, "--format", fmt, "--from", path, "--out", out],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        print("FAIL %-8s exit=%d\n%s" % (fmt, proc.returncode, proc.stderr.strip()))
        bad += 1
        continue
    data = json.load(open(out, encoding="utf-8"))
    s = data["sessions"][0]
    ok = s["msgCount"] == want_msgs and s["title"] and s["messages"][0]["role"] == "user"
    print("%s %-8s title=%r msgs=%d first=%r at=%s" % (
        "PASS" if ok else "FAIL", fmt, s["title"], s["msgCount"],
        s["messages"][0]["text"][:18], s["messages"][0]["at"]))
    if not ok:
        bad += 1

# DSH regression: real data must still load
proc = subprocess.run([PY, EXPORT, "--stats"], capture_output=True, text=True,
                      encoding="utf-8", errors="replace")
line = [l for l in proc.stdout.splitlines() if l.startswith("sessions:")]
print("PASS dsh      %s" % (line[0] if line else "no output"))
if proc.returncode != 0 or not line:
    bad += 1

print("\nFAILURES: %d" % bad)
sys.exit(1 if bad else 0)