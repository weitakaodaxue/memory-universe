"""
Export chat history into web/memory.json for the 3D star map.

Sources:
    dsh      DSH sessions           <dsh-home>/sessions/**/session.v4.jsonl[.zstd]
    chatgpt  ChatGPT export         conversations.json
    claude   Claude export          conversations.json
    cursor   Cursor / VS Code DB    state.vscdb (chatdata) or a JSON dump
    json     anything else          [{title, messages:[{role,text,at}]}, ...]

Usage:
    python export_memory.py                                    # DSH, every project
    python export_memory.py --format chatgpt --from conversations.json
    python export_memory.py --format claude  --from conversations.json
    python export_memory.py --format cursor  --from state.vscdb
    python export_memory.py --embed all-MiniLM-L6-v2           # semantic positions
    python export_memory.py --stats
    python export_memory.py --out x.json --max-text 300

Requires: zstandard for DSH transcripts (pip install zstandard).
          sentence-transformers + numpy only for --embed.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time

try:
    import zstandard
except ImportError:  # pragma: no cover
    zstandard = None

DEFAULT_DSH_HOME = os.environ.get("DSH_HOME", os.path.join("~", ".dsh"))
ROOT = os.path.dirname(os.path.abspath(__file__))

# user/message events are also used by DSH itself for injected pseudo-messages
# (title generation, memory recall, ...). Their source.kind is something other
# than "user"/None, so we keep only these two and drop the rest.
ALLOWED_SOURCES = ("user", None)

FORMATS = ("dsh", "chatgpt", "claude", "cursor", "json")


# --------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------
def iso_ms(value):
    """ISO-8601 or epoch seconds -> epoch milliseconds (or None)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # ChatGPT writes seconds, everything else we produce is milliseconds
        return int(value * 1000) if value < 1e11 else int(value)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def flatten_content(content):
    """ChatGPT/Claude content blobs -> plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, dict):
                if c.get("text"):
                    parts.append(c["text"])
                elif c.get("type") == "text" and c.get("content"):
                    parts.append(str(c["content"]))
        return "\n".join(p for p in parts if p).strip()
    if isinstance(content, dict):
        if content.get("text"):
            return str(content["text"]).strip()
        if content.get("parts"):
            return flatten_content(content["parts"])
    return ""


def mask_path(path, home):
    """Replace the real home directory with ~ so nothing personal leaks."""
    if not path or not home:
        return path
    try:
        home = os.path.abspath(os.path.expanduser(home))
    except Exception:
        return path

    # Windows paths are case-insensitive: compare on normcase() so a lowercase
    # drive letter from cwd still gets masked.
    target = os.path.normcase(path)
    variants = (home, home.replace("\\", "/"), home.replace("/", "\\"))
    for variant in variants:
        prefix = os.path.normcase(variant)
        if not prefix or not target.startswith(prefix):
            continue
        rest = path[len(variant):]
        # only mask a real boundary (~\foo, not ~\foobar) unless it is exact
        if rest and rest[0] not in ("\\", "/"):
            continue
        return "~" + rest
    return path


def make_session(sid, title, created, messages, project=None, tool_count=0):
    """Normalise any source into the shape the front-end understands."""
    msgs = [m for m in messages if m.get("text")]
    if not msgs:
        return None
    ats = [m["at"] for m in msgs if m.get("at")]
    return {
        "id": str(sid),
        "cwd": None,
        "project": project,
        "title": (title or "(untitled)").strip()[:200],
        "createdAt": created or (min(ats) if ats else None),
        "lastAt": max(ats) if ats else None,
        "msgCount": len(msgs),
        "toolCount": tool_count,
        "messages": msgs,
    }


# --------------------------------------------------------------------------
# DSH
# --------------------------------------------------------------------------
# DSH writes an escaped char as "~" + 4 hex digits of its code point.  For a
# readable label, typographic punctuation is folded back to ASCII.
_TYPO = {
    0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"',
    0x2013: "-", 0x2014: "-", 0x2026: "...", 0x00A0: " ",
}


def unescape_segment(part):
    """my~002dname -> my-name, it~2018s -> it's."""
    out = []
    i = 0
    n = len(part)
    while i < n:
        if part[i] == "~" and i + 5 <= n:
            hexpart = part[i + 1:i + 5]
            if all(c in "0123456789abcdefABCDEF" for c in hexpart):
                code = int(hexpart, 16)
                out.append(_TYPO.get(code, chr(code)))
                i += 5
                continue
        out.append(part[i])
        i += 1
    return "".join(out)


def decode_project(dirname):
    """--D-myproj-- (DSH's escaped cwd) -> a readable path.

    DSH escapes a cwd into a directory name: "-" separates path segments and a
    literal character is written as "~<hex codepoint>".  The result is only a
    readable *label* -- the real cwd is stored inside the session file, so
    callers prefer that when it is available.
    """
    s = dirname
    if s.startswith("--"):
        s = s[2:]
    if s.endswith("--"):
        s = s[:-2]

    sep = "\\" if os.name == "nt" else "/"
    parts = [unescape_segment(p) for p in s.split("-") if p]
    joined = sep.join(parts)
    if os.name == "nt" and joined and not joined.startswith("\\"):
        joined = "\\" + joined
    elif os.name != "nt" and joined and not joined.startswith("/"):
        joined = "/" + joined
    return joined


def text_of(content):
    """[{'type':'text','text':...}, ...] -> visible text only."""
    parts = []
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
            parts.append(c["text"])
    return "\n".join(parts).strip()


def open_session(path):
    """Yield decoded JSONL lines from a .zstd or plain .jsonl transcript."""
    if path.endswith(".zstd"):
        if zstandard is None:
            raise RuntimeError("zstandard is not installed: pip install zstandard")
        with open(path, "rb") as f:
            data = zstandard.ZstdDecompressor().stream_reader(f).read()
        text = data.decode("utf-8", "replace")
    else:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def read_dsh_session(path, max_text=4000, home=None):
    session = {"id": None, "createdAt": None, "cwd": None}
    title = None
    messages = []
    tool_calls = 0

    for o in open_session(path):
        t = o.get("type")
        ts = o.get("time")

        if t == "session":
            session["id"] = o.get("id")
            session["createdAt"] = o.get("createdAt")
            session["cwd"] = o.get("cwd")
        elif t == "session/title":
            d = o.get("data") or {}
            if d.get("title"):
                title = d["title"]
        elif t == "user/message":
            d = o.get("data") or {}
            src = (d.get("source") or {}).get("kind")
            # Skip injected pseudo-user messages (title generation, memory, ...)
            if src not in ALLOWED_SOURCES:
                continue
            txt = text_of(d.get("content"))
            if txt:
                messages.append({"role": "user", "text": txt[:max_text],
                                 "at": ts, "seq": o.get("seq")})
        elif t == "assistant/message":
            d = o.get("data") or {}
            msg = d.get("message") or {}
            txt = text_of(msg.get("content"))
            if txt:
                messages.append({"role": "assistant", "text": txt[:max_text],
                                 "at": ts, "seq": o.get("seq"),
                                 "turn": d.get("turn")})
            for c in msg.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool-call":
                    tool_calls += 1

    if not messages:
        return None

    ats = [m["at"] for m in messages if m.get("at")]
    return {
        "id": session["id"] or os.path.basename(os.path.dirname(path)),
        "cwd": mask_path(session["cwd"], home),
        "title": title or "(untitled)",
        "createdAt": session["createdAt"] or (min(ats) if ats else None),
        "lastAt": max(ats) if ats else None,
        "msgCount": len(messages),
        "toolCount": tool_calls,
        "messages": messages,
    }


def iter_dsh_files(sessions_dir):
    if not os.path.isdir(sessions_dir):
        return
    for project_dir in sorted(os.listdir(sessions_dir)):
        pdir = os.path.join(sessions_dir, project_dir)
        if not os.path.isdir(pdir):
            continue
        for sid in sorted(os.listdir(pdir)):
            sdir = os.path.join(pdir, sid)
            if not os.path.isdir(sdir):
                continue
            for name in ("session.v4.jsonl.zstd", "session.v4.jsonl"):
                f = os.path.join(sdir, name)
                if os.path.exists(f):
                    yield decode_project(project_dir), sid, f
                    break


def load_dsh(args):
    home = None if args.keep_paths else os.path.expanduser("~")
    sessions_dir = os.path.join(os.path.expanduser(args.dsh_home), "sessions")
    out = []
    for project, sid, path in iter_dsh_files(sessions_dir):
        try:
            s = read_dsh_session(path, args.max_text, home)
        except Exception as e:
            print("[skip] %s: %s" % (sid, e), file=sys.stderr)
            continue
        if not s:
            continue
        # Prefer the cwd recorded inside the session; the directory name is
        # only a lossy escape of it.
        s["project"] = s.get("cwd") or mask_path(project, home)
        out.append(s)
    return out


# --------------------------------------------------------------------------
# ChatGPT
# --------------------------------------------------------------------------
def load_chatgpt(path, args):
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("conversations") or [data]
    out = []
    for conv in data:
        if not isinstance(conv, dict):
            continue
        nodes = []
        for node in (conv.get("mapping") or {}).values():
            if not isinstance(node, dict):
                continue
            msg = node.get("message")
            if not isinstance(msg, dict):
                continue
            role = (msg.get("author") or {}).get("role")
            if role not in ("user", "assistant"):
                continue
            txt = flatten_content(msg.get("content"))
            if not txt:
                continue
            at = iso_ms(msg.get("create_time")) or iso_ms(node.get("create_time"))
            nodes.append((at or 0, {"role": role, "text": txt[:args.max_text], "at": at}))
        nodes.sort(key=lambda t: t[0])
        s = make_session(
            conv.get("id") or conv.get("conversation_id") or conv.get("title"),
            conv.get("title"),
            iso_ms(conv.get("create_time")),
            [m for _, m in nodes],
            project=args.project or "chatgpt",
        )
        if s:
            out.append(s)
    return out


# --------------------------------------------------------------------------
# Claude
# --------------------------------------------------------------------------
def load_claude(path, args):
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("conversations") or [data]
    out = []
    for conv in data:
        if not isinstance(conv, dict):
            continue
        msgs = []
        for m in conv.get("chat_messages") or []:
            if not isinstance(m, dict):
                continue
            sender = (m.get("sender") or m.get("role") or "").lower()
            role = "user" if sender in ("human", "user") else "assistant"
            txt = flatten_content(m.get("text") or m.get("content"))
            if not txt:
                continue
            msgs.append({
                "role": role,
                "text": txt[:args.max_text],
                "at": iso_ms(m.get("created_at") or m.get("updated_at")),
            })
        s = make_session(
            conv.get("uuid") or conv.get("id") or conv.get("name"),
            conv.get("name") or conv.get("title"),
            iso_ms(conv.get("created_at")),
            msgs,
            project=args.project or "claude",
        )
        if s:
            out.append(s)
    return out


# --------------------------------------------------------------------------
# Cursor / VS Code chat DB
# --------------------------------------------------------------------------
def _cursor_blobs(path):
    """Yield JSON blobs that may hold chat records."""
    if path.lower().endswith((".vscdb", ".db", ".sqlite")):
        import sqlite3

        con = sqlite3.connect(path)
        try:
            tables = [r[0] for r in con.execute(
                "select name from sqlite_master where type='table'")]
            for table in tables:
                try:
                    rows = con.execute(
                        "select value from %s" % table).fetchall()
                except Exception:
                    continue
                for (value,) in rows:
                    if not isinstance(value, str) or "chat" not in value[:400].lower():
                        continue
                    try:
                        yield json.loads(value)
                    except ValueError:
                        continue
        finally:
            con.close()
        return
    with open(path, "r", encoding="utf-8-sig") as f:
        yield json.load(f)


def _walks_tabs(blob):
    """Cursor stores {tabs:[{chatTitle, bubbles:[...]}]} inside a string blob."""
    if isinstance(blob, str):
        try:
            blob = json.loads(blob)
        except ValueError:
            return
    if isinstance(blob, list):
        for b in blob:
            for t in _walks_tabs(b):
                yield t
        return
    if not isinstance(blob, dict):
        return
    tabs = blob.get("tabs")
    if isinstance(tabs, list):
        for t in tabs:
            if isinstance(t, dict):
                yield t
    for key in ("allTabs", "conversations", "chats"):
        if isinstance(blob.get(key), list):
            for t in _walks_tabs(blob[key]):
                yield t


def load_cursor(path, args):
    out = []
    for blob in _cursor_blobs(path):
        for tab in _walks_tabs(blob):
            msgs = []
            for b in tab.get("bubbles") or tab.get("messages") or []:
                if not isinstance(b, dict):
                    continue
                kind = (b.get("type") or b.get("role") or "").lower()
                if kind in ("user", "human"):
                    role = "user"
                elif kind in ("ai", "assistant", "bot"):
                    role = "assistant"
                else:
                    continue
                txt = flatten_content(b.get("text") or b.get("content"))
                if not txt:
                    continue
                msgs.append({"role": role, "text": txt[:args.max_text],
                             "at": iso_ms(b.get("timestamp") or b.get("createdAt"))})
            s = make_session(
                tab.get("tabId") or tab.get("id") or tab.get("chatTitle"),
                tab.get("chatTitle") or tab.get("title"),
                min([m["at"] for m in msgs if m.get("at")], default=None),
                msgs,
                project=args.project or "cursor",
            )
            if s:
                out.append(s)
    return out


# --------------------------------------------------------------------------
# generic JSON
# --------------------------------------------------------------------------
def load_json(path, args):
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("sessions") or data.get("conversations") or [data]
    out = []
    for conv in data:
        if not isinstance(conv, dict):
            continue
        msgs = []
        for m in conv.get("messages") or conv.get("chat_messages") or []:
            if not isinstance(m, dict):
                continue
            role = "user" if (m.get("role") or "").lower() in ("user", "human") else "assistant"
            txt = flatten_content(m.get("text") or m.get("content"))
            if not txt:
                continue
            msgs.append({"role": role, "text": txt[:args.max_text],
                         "at": iso_ms(m.get("at") or m.get("createdAt") or m.get("created_at"))})
        s = make_session(
            conv.get("id") or conv.get("uuid") or conv.get("title"),
            conv.get("title") or conv.get("name"),
            iso_ms(conv.get("createdAt") or conv.get("created_at")),
            msgs,
            project=args.project or "imported",
        )
        if s:
            out.append(s)
    return out


LOADERS = {
    "chatgpt": load_chatgpt,
    "claude": load_claude,
    "cursor": load_cursor,
    "json": load_json,
}


# --------------------------------------------------------------------------
# optional semantic positions
# --------------------------------------------------------------------------
def add_embeddings(sessions, model_name, max_chars=1500):
    try:
        import numpy as np
        from sentence_transformers import SentenceTransformer
    except ImportError:
        raise SystemExit(
            "--embed needs two optional packages:\n"
            "    pip install sentence-transformers numpy\n"
            "(the rest of the exporter stays dependency-free)")

    print("embedding %d sessions with %s ..." % (len(sessions), model_name))
    texts = []
    for s in sessions:
        body = " ".join((m["text"] or "")[:300] for m in s["messages"][:10])
        texts.append((s["title"] + " " + body)[:max_chars])

    model = SentenceTransformer(model_name)
    vecs = np.asarray(model.encode(texts, show_progress_bar=len(texts) > 40,
                                   normalize_embeddings=True), dtype="float32")
    if vecs.size == 0:
        return

    # PCA via SVD: keep the 3 directions with the most variance.
    X = vecs - vecs.mean(axis=0, keepdims=True)
    U, S, _ = np.linalg.svd(X, full_matrices=False)
    coords = U[:, :3] * S[:3]
    scale = float(np.abs(coords).max()) or 1.0
    coords = coords / scale
    for s, c in zip(sessions, coords):
        s["embed"] = [round(float(v), 4) for v in c]
    print("  -> 3D positions written (PCA of %d dims)" % vecs.shape[1])


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def guess_from(fmt, explicit):
    if explicit:
        return explicit
    defaults = {
        "chatgpt": "conversations.json",
        "claude": "conversations.json",
        "cursor": "state.vscdb",
        "json": "memory.json",
    }
    return defaults.get(fmt)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Export chats to memory.json")
    ap.add_argument("--format", choices=FORMATS, default="dsh",
                    help="source format (default: dsh)")
    ap.add_argument("--from", dest="src", metavar="PATH",
                    help="input file (chatgpt/claude/cursor/json)")
    ap.add_argument("--dsh-home", default=os.path.expanduser(DEFAULT_DSH_HOME),
                    help="DSH data directory (default: $DSH_HOME or ~/.dsh)")
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "memory.json"),
                    help="output JSON path (default: web/memory.json)")
    ap.add_argument("--max-text", type=int, default=4000,
                    help="max characters kept per message (default: 4000)")
    ap.add_argument("--project", help="project label for imported formats")
    ap.add_argument("--embed", metavar="MODEL",
                    help="compute semantic positions, e.g. all-MiniLM-L6-v2")
    ap.add_argument("--stats", action="store_true", help="print stats only, write nothing")
    ap.add_argument("--keep-paths", action="store_true",
                    help="keep absolute paths in the output (off by default)")
    args = ap.parse_args(argv)

    # ---- load -----------------------------------------------------------
    if args.format == "dsh":
        sessions = load_dsh(args)
    else:
        src = guess_from(args.format, args.src)
        if not src:
            ap.error("--format %s needs --from PATH" % args.format)
        if not os.path.exists(src):
            ap.error("input not found: %s" % src)
        if os.path.isdir(src):
            # a folder of exports: parse every .json inside
            sessions = []
            for name in sorted(os.listdir(src)):
                if not name.lower().endswith(".json"):
                    continue
                sessions.extend(LOADERS[args.format](os.path.join(src, name), args))
        else:
            sessions = LOADERS[args.format](src, args)

    sessions = [s for s in sessions if s]
    sessions.sort(key=lambda s: s.get("createdAt") or 0)

    if args.embed:
        if not sessions:
            print("nothing to embed", file=sys.stderr)
        else:
            add_embeddings(sessions, args.embed)

    total_msg = sum(s["msgCount"] for s in sessions)
    total_user = sum(1 for s in sessions for m in s["messages"] if m["role"] == "user")
    total_tool = sum(s["toolCount"] for s in sessions)
    print("source: %s" % args.format)
    print("sessions: %d" % len(sessions))
    print("messages: %d  (user: %d)" % (total_msg, total_user))
    print("tool calls: %d" % total_tool)
    for s in sessions[:40]:
        print("  - %-34s %4d msg  %s" % (s["title"][:34], s["msgCount"], s.get("project") or ""))

    if args.stats:
        return 0

    if not sessions:
        print("no sessions found; nothing written", file=sys.stderr)
        return 1

    payload = {
        "generatedAt": int(time.time() * 1000),
        "source": args.format,
        "sessions": sessions,
    }
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("\n-> %s  (%.2f MB)" % (out, os.path.getsize(out) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
