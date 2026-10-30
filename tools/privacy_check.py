"""
Scan the repository for content that should not be published.

    python tools/privacy_check.py                      # built-in patterns only
    python tools/privacy_check.py --token 张三 --token my-company
    python tools/privacy_check.py --tokens-file private.txt   # one token per line

Built-in patterns catch the usual accidents: absolute home paths, Windows drive
paths, API keys, e-mail addresses and long digit strings.

Exits with status 1 when anything matches, so it can gate a commit hook or CI.
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT_EXT = {".py", ".js", ".html", ".css", ".md", ".json", ".txt", ".yml", ".yaml", ".bat", ".toml", ".cfg"}
SKIP_DIRS = {".git", ".dsh-project-memory", "node_modules", "__pycache__", ".venv", "venv", "vendor"}

DEFAULT_RULES = [
    ("windows-home", re.compile(r"[A-Za-z]:\\\\?Users\\\\?[^\\\\/\s\"'<>]+", re.I)),
    ("posix-home", re.compile(r"/(?:home|Users)/[A-Za-z0-9._-]+")),
    ("api-key", re.compile(r"\b(?:sk|pk|ghp|gho|xox[bap])[-_][A-Za-z0-9]{16,}")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("phone-cn", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("id-card-cn", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
]


def iter_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = os.path.join(dirpath, name)
            if os.path.splitext(name)[1].lower() in TEXT_EXT:
                yield path


def main():
    ap = argparse.ArgumentParser(description="Find private data before publishing")
    ap.add_argument("--token", action="append", default=[], help="extra literal string to look for")
    ap.add_argument("--tokens-file", help="file with one token per line")
    ap.add_argument("--include-vendor", action="store_true", help="also scan web/vendor")
    args = ap.parse_args()

    tokens = list(args.token)
    if args.tokens_file:
        with open(args.tokens_file, "r", encoding="utf-8") as f:
            tokens += [ln.strip() for ln in f if ln.strip()]
    tokens = [t for t in tokens if len(t) >= 3]

    if args.include_vendor:
        SKIP_DIRS.discard("vendor")

    hits = 0
    scanned = 0
    for path in iter_files(ROOT):
        rel = os.path.relpath(path, ROOT)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().split("\n")
        except OSError:
            continue
        scanned += 1
        for lineno, line in enumerate(lines, 1):
            problems = []
            for name, rx in DEFAULT_RULES:
                if rx.search(line):
                    problems.append(name)
            for t in tokens:
                if t in line:
                    problems.append("token:" + (t[:2] + "*" * max(1, len(t) - 2) if len(t) > 4 else t))
            if problems:
                hits += 1
                if hits <= 200:
                    print("%s:%d  [%s]" % (rel, lineno, ", ".join(sorted(set(problems)))))
                    print("    " + line.strip()[:160])

    print("\nscanned %d files, %d matching lines" % (scanned, hits))
    if hits:
        print("review the lines above before publishing")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())