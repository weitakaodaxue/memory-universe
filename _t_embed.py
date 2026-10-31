"""Verify --embed maths without downloading a model (fake encoder injected)."""
import sys
import types

import numpy as np

sys.path.insert(0, ".")

# --- fake sentence_transformers ------------------------------------------
fake = types.ModuleType("sentence_transformers")


class FakeModel:
    def __init__(self, name):
        self.name = name

    def encode(self, texts, show_progress_bar=False, normalize_embeddings=True):
        rng = np.random.default_rng(7)
        v = rng.normal(size=(len(texts), 12))
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        return v


fake.SentenceTransformer = FakeModel
sys.modules["sentence_transformers"] = fake

import export_memory as em

sessions = [
    {"title": "t%d" % i, "messages": [{"text": "hello %d" % i, "role": "user", "at": None}]}
    for i in range(6)
]
em.add_embeddings(sessions, "fake-model")

ok = True
for s in sessions:
    e = s.get("embed")
    if not e or len(e) != 3:
        ok = False
        print("FAIL shape", s["title"], e)
        break
    if any(abs(v) > 1.0001 for v in e):
        ok = False
        print("FAIL range", s["title"], e)
        break
    if not all(isinstance(v, float) for v in e):
        ok = False
        print("FAIL type", s["title"], e)
        break

print("PASS embed" if ok else "FAIL embed", [s.get("embed") for s in sessions[:2]])

# --- error path when the packages are missing ----------------------------
sys.modules["sentence_transformers"] = None   # makes "import ..." raise ImportError
try:
    em.add_embeddings(sessions, "fake-model")
    print("FAIL missing-dep path did not raise")
    ok = False
except SystemExit as e:
    msg = str(e)
    good = "sentence-transformers" in msg and "pip install" in msg
    print(("PASS" if good else "FAIL") + " missing-dep message: " + msg.splitlines()[0])
    ok = ok and good

sys.exit(0 if ok else 1)