"""
Export DSH session transcripts into a single memory.json for the 3D star map.

Reads:
    <dsh-home>/sessions/<project>/<session-id>/session.v4.jsonl.zstd

Writes:
    web/memory.json

Usage:
    python export_memory.py                 # full export
    python export_memory.py --stats         # print statistics only
    python export_memory.py --out x.json    # custom output path
    python export_memory.py --max-text 300  # shorter snippets

Requires: zstandard  (pip install zstandard)
"""
import argparse
import json
import os
import sys
import time

try:
    import zstandard
except ImportError:  # pragma: no cover
    zstandard = None

DEFAULT_DSH_HOME = os.environ.get("DSH_HOME", os.path.join("~", ".dsh"))
ROOT = os.path.dirname(os.path.abspath(__file__))

# Event types we ignore when looking for a session's visible text.
SKIP_SOURCES = ("user", None)


def decode_project(dirname):
    """--D-myproj-- (DSH's escaped cwd) -> a readable path."""
    s = dirname.strip("-")
    s = s.replace("~2018", "'")          # DSH escapes punctuation as ~<code>
    s = s.replace("--", "\x00").replace("-", "\\").replace("\x00", "\\")
    if s and s[0] != "\\":
        s = "\\" + s
    return s


def mask_path(path, home):
    """Replace the real home directory with ~ so nothing personal leaks."""
    if not path or not home:
        return path
    try:
        home = os.path.abspath(os.path.expanduser(home))
    except Exception:
        return path
    for prefix in (home, home.replace("\\", "/")):
        if path.startswith(prefix):
            return "~" + path[len(prefix):]
    return path


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


def read_session(path, max_text=4000, home=None):
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
            if src not in SKIP_SOURCES:
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


def iter_session_files(sessions_dir):
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


def main(argv=None):
    ap = argparse.ArgumentParser(description="Export DSH sessions to memory.json")
    ap.add_argument("--dsh-home", default=os.path.expanduser(DEFAULT_DSH_HOME),
                    help="DSH data directory (default: $DSH_HOME or ~/.dsh)")
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "memory.json"),
                    help="output JSON path (default: web/memory.json)")
    ap.add_argument("--max-text", type=int, default=4000,
                    help="max characters kept per message (default: 4000)")
    ap.add_argument("--stats", action="store_true", help="print stats only, write nothing")
    ap.add_argument("--keep-paths", action="store_true",
                    help="keep absolute paths in the output (off by default)")
    args = ap.parse_args(argv)

    home = None if args.keep_paths else os.path.expanduser("~")
    sessions_dir = os.path.join(args.dsh_home, "sessions")
    sessions = []

    for project, sid, path in iter_session_files(sessions_dir):
        try:
            s = read_session(path, args.max_text, home)
        except Exception as e:
            print("[skip] %s: %s" % (sid, e), file=sys.stderr)
            continue
        if not s:
            continue
        # Prefer the cwd recorded inside the session; the directory name is
        # only a lossy escape of it.
        s["project"] = s.get("cwd") or mask_path(project, home)
        sessions.append(s)

    sessions.sort(key=lambda s: s.get("createdAt") or 0)

    total_msg = sum(s["msgCount"] for s in sessions)
    total_user = sum(1 for s in sessions for m in s["messages"] if m["role"] == "user")
    total_tool = sum(s["toolCount"] for s in sessions)
    print("sessions: %d" % len(sessions))
    print("messages: %d  (user: %d)" % (total_msg, total_user))
    print("tool calls: %d" % total_tool)
    for s in sessions:
        print("  - %-34s %4d msg  %s" % (s["title"][:34], s["msgCount"], s["project"]))

    if args.stats:
        return

    payload = {
        "generatedAt": int(time.time() * 1000),
        "source": "dsh",
        "sessions": sessions,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("\n-> %s  (%.2f MB)" % (args.out, os.path.getsize(args.out) / 1048576))


if __name__ == "__main__":
    main()