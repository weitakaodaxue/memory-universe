"""
一键刷新：导出会话 -> 重新打包单文件 -> 覆盖桌面那份。

    python refresh.py                 # 跑一次
    python refresh.py --watch         # 常驻，盯着会话目录，有变化就重做
    python refresh.py --watch --every 30

为什么需要它：单文件版是**快照**，双击打开的那份不会自己变，只有重新打包才带得上新对话。
如果你是用 `python serve.py` 看的，那更简单——页面每次加载都会重读 memory.json，
点一下刷新就是最新的，不需要这个脚本。
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
DSH_SESSIONS = os.path.join(
    os.path.expanduser(os.environ.get("DSH_HOME", "~/.dsh")), "sessions")
DESKTOP_FILE = os.path.join(
    os.path.expanduser("~"), "Desktop", "记忆宇宙（双击即看）.html")


def newest_session_mtime():
    """目录里最新的 session.v4* 的修改时间；用来判断有没有新对话。"""
    best = 0.0
    for dirpath, _, files in os.walk(DSH_SESSIONS):
        for name in files:
            if not name.startswith("session.v4"):
                continue
            try:
                best = max(best, os.path.getmtime(os.path.join(dirpath, name)))
            except OSError:
                pass
    return best


def refresh():
    t0 = time.time()
    subprocess.run([PY, "export_memory.py"], cwd=ROOT, check=True)
    subprocess.run([PY, "build_single.py"], cwd=ROOT, check=True)
    out = os.path.join(ROOT, "memory-universe.html")
    if os.path.isdir(os.path.dirname(DESKTOP_FILE)):
        shutil.copyfile(out, DESKTOP_FILE)
        print("-> " + DESKTOP_FILE)
    print("done in %.1fs" % (time.time() - t0))


def main():
    ap = argparse.ArgumentParser(description="刷新记忆宇宙的数据与单文件版")
    ap.add_argument("--watch", action="store_true", help="常驻，检测到新对话就重做")
    ap.add_argument("--every", type=int, default=60, help="检查间隔（秒，默认 60）")
    args = ap.parse_args()

    if not args.watch:
        refresh()
        return

    if not os.path.isdir(DSH_SESSIONS):
        raise SystemExit("找不到会话目录：" + DSH_SESSIONS)

    print("watching %s  (Ctrl+C 退出)" % DSH_SESSIONS)
    last = 0.0
    while True:
        try:
            now = newest_session_mtime()
            if now > last:
                last = now
                refresh()
        except KeyboardInterrupt:
            print("\nbye")
            return
        except Exception as e:                      # 单个文件读不出来不该让守护停掉
            print("skip: %s" % e)
        try:
            time.sleep(max(5, args.every))
        except KeyboardInterrupt:
            print("\nbye")
            return


if __name__ == "__main__":
    main()