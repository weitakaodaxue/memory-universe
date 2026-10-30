"""
Bundle the star map into ONE self-contained HTML file.

    python build_single.py               # web/memory.json, else the demo data
    python build_single.py --light       # keep only the first 80 chars per message
    python build_single.py --data web/memory.demo.json --out demo.html

Why inline everything: under file:// a browser refuses to fetch local files,
so three.min.js / style.css / app.js / memory.json are all embedded and the
payload is exposed as window.MEMORY.
"""
import argparse
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")


def read(*parts):
    with open(os.path.join(WEB, *parts), "r", encoding="utf-8") as f:
        return f.read()


def pick_data(explicit):
    if explicit:
        return explicit
    real = os.path.join(WEB, "memory.json")
    if os.path.exists(real):
        return real
    return os.path.join(WEB, "memory.demo.json")


def main():
    ap = argparse.ArgumentParser(description="Inline the star map into one HTML file")
    ap.add_argument("--data", help="memory JSON to embed (default: memory.json, then memory.demo.json)")
    ap.add_argument("--out", default=os.path.join(ROOT, "memory-universe.html"),
                    help="output HTML path")
    ap.add_argument("--light", action="store_true", help="truncate every message to 80 chars")
    args = ap.parse_args()

    html = read("index.html")
    css = read("style.css")
    three = read("vendor", "three.min.js")
    app = read("app.js")

    data_path = pick_data(args.data)
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if args.light:
        for s in data.get("sessions", []):
            for m in s.get("messages", []):
                m["text"] = (m.get("text") or "")[:80]

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # "<" must not appear literally: it would close </script> early or start an
    # HTML comment inside the inline script block.
    payload = payload.replace("<", "\\u003c")

    safe_three = three.replace("</script", "<\\/script")
    safe_app = app.replace("</script", "<\\/script")

    html = html.replace('<link rel="stylesheet" href="style.css">',
                        "<style>\n" + css + "\n</style>")
    html = html.replace('<script src="vendor/three.min.js"></script>',
                        "<script>\n" + safe_three + "\n</script>")
    html = html.replace('<script src="app.js"></script>',
                        "<script>window.MEMORY=" + payload + ";</script>\n"
                        "<script>\n" + safe_app + "\n</script>")

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    sessions = data.get("sessions", [])
    total = sum(s.get("msgCount", 0) for s in sessions)
    print("-> %s" % out)
    print("   %.2f MB | %d sessions | %d messages%s"
          % (os.path.getsize(out) / 1048576, len(sessions), total,
             "  [light: 80 chars each]" if args.light else "  [full]"))


if __name__ == "__main__":
    main()