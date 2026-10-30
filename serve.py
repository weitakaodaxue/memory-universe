"""
Serve web/ on localhost and open the browser. No dependencies.

    python serve.py                 # http://127.0.0.1:8099/
    python serve.py --port 9000 --no-browser

Unlike the single-file build, this one re-reads web/memory.json on every page
load, so after running export_memory.py a plain refresh shows the new data.
"""
import argparse
import functools
import http.server
import os
import socketserver
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Never cache: this is a live-view server.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("VERBOSE"):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description="Serve the memory universe locally")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(WEB):
        raise SystemExit("web/ not found next to serve.py")

    handler = functools.partial(Handler, directory=WEB)
    with socketserver.TCPServer((args.host, args.port), handler) as httpd:
        url = "http://%s:%d/" % (args.host, args.port)
        print("memory universe -> %s   (Ctrl+C to stop)" % url)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")


if __name__ == "__main__":
    main()