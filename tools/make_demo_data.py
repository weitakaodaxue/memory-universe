"""
生成仓库自带的示例数据 web/memory.demo.json。

全部内容都是虚构的，用来让任何人在克隆仓库后不用任何真实对话
也能立刻看到完整效果。仓库不会、也不应该收录任何真实对话。

    python tools/make_demo_data.py
"""
import json
import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "memory.demo.json")

# (标题, 项目路径, 起始时间偏移(天), [(用户, 助手), ...])
TOPICS = [
    ("面包为什么发不起来", "~/demo/cookbook", 0, [
        ("第一次烤欧包，面团发了两小时还是没怎么膨胀，是哪里出了问题？",
         "先看酵母是不是过期了，再确认水温没超过 38°C。室温低于 20°C 时两小时本来就不够，"
         "可以放进烤箱开灯发酵，或者把时间延长到 4 小时以上。"),
        ("酵母是上个月开封的干酵母，一直放在橱柜里。",
         "开封后的干酵母受潮会迅速失活。取 5 克用 30°C 的糖水泡 10 分钟，"
         "表面起一层泡沫说明还活着，没动静就换新的。"),
        ("泡了确实没泡沫，换新酵母之后配方要调吗？",
         "不用调，酵母量保持面粉重量的 1% 左右就行。换成新酵母后发酵会快很多，"
         "每 40 分钟看一次，体积到两倍就折叠排气。"),
        ("折叠几次比较合适？",
         "基础发酵期间折 3 到 4 次，每次间隔 40 分钟。手上沾点水防粘，"
         "从四周拉起往中间压，别把气泡全按掉。"),
        ("烤出来表皮很硬，里面还行，怎么让皮薄一点？",
         "硬皮主要是烤箱内湿度不够加上烤得太久。前 15 分钟放一盘热水制造蒸汽，"
         "后 15 分钟开风门上色，总时长控制在 35 到 40 分钟。"),
    ]),
    ("列表推导式和生成器怎么选", "~/demo/notes/python", 6, [
        ("列表推导式和生成器表达式什么时候该用哪个？",
         "结果要多次遍历、要 len()、要索引，就用列表推导式；只遍历一次或者数据量可能很大，"
         "就用生成器表达式，内存占用是常数级。"),
        ("那 map/filter 跟推导式比呢？",
         "逻辑简单的时候 map/filter 略快一点，但一旦要加条件或者多个变量，推导式可读性好得多。"
         "团队里统一风格比抠这点性能重要。"),
        ("嵌套推导式是不是应该避免？",
         "两层以上就拆开写成普通循环。嵌套推导式的阅读顺序是从内到外，"
         "绝大多数人第一次读都会读反。"),
        ("生成器用完之后还能再用吗？",
         "不能，生成器是一次性的。需要重复使用就写成函数返回新的生成器，或者干脆用列表。"),
        ("怎么判断一个对象是不是可迭代？",
         "用 isinstance(x, collections.abc.Iterable) 判断。注意字符串和字典也是可迭代的，别误判。"),
    ]),
    ("flex 还是 grid", "~/demo/web/layout-lab", 13, [
        ("flex 和 grid 到底怎么选？",
         "一维排布用 flex，二维网格用 grid。实际项目里常见的是外层 grid 划区域，"
         "区域内部的排列用 flex。"),
        ("我只想让卡片等高，用 flex 还是 grid？",
         "两者都行。grid 加 align-items: stretch 更省事，flex 需要给子项设 flex: 1 1 auto，"
         "再处理内容撑开的情况。"),
        ("响应式断点一般设几个？",
         "移动优先的话 640 和 1024 两个断点能覆盖大多数场景，再多维护成本会涨得很快。"),
        ("容器查询现在能直接用吗？",
         "@container 在主流浏览器都支持了，比媒体查询更适合组件级适配。"
         "需要兼容很老的浏览器时再退回媒体查询。"),
        ("怎么让中间那一栏自适应宽度？",
         "外层用 grid-template-columns: 240px minmax(0, 1fr) 240px。"
         "minmax(0, 1fr) 里的 0 很关键，否则长单词会把列撑破。"),
    ]),
    ("TCP 为什么是三次握手", "~/demo/notes/network", 21, [
        ("TCP 三次握手为什么不是两次？",
         "两次握手无法确认客户端的接收能力和服务端的发送能力，历史重复的连接请求还会让服务端"
         "建立无效连接。第三次 ACK 让双方都确认了彼此的收发能力。"),
        ("那四次挥手为什么要多一次？",
         "因为 TCP 是全双工的。一方发完数据只能先说自己这一半关了，另一方的数据可能还没发完，"
         "所以中间多了一个半关闭状态。"),
        ("TIME_WAIT 为什么必须等 2MSL？",
         "一是保证最后一个 ACK 丢了还能重传，二是让这条连接上的旧报文在网络里彻底消失，"
         "不会串到下一个用同样端口的新连接里。"),
        ("服务端出现大量 TIME_WAIT 有什么影响？",
         "一般只有主动关闭的一方才有 TIME_WAIT。服务端出现多半是短连接太频繁，"
         "可以开 tcp_tw_reuse 缓解，但别开 tcp_tw_recycle。"),
    ]),
    ("写一首关于秋天的短诗", "~/demo/writing", 28, [
        ("写一首关于秋天的短诗，八行以内。",
         "风把最后一片叶子\n放在长椅上\n像谁忘了带走的一页信\n\n天色矮下来\n路灯先亮了\n影子比我更早回家"),
        ("太静了，能不能多一点声音？",
         "风翻动铁皮的屋檐\n雨数着台阶\n一、二、三\n数到第四级就停了\n\n有人关窗\n有人在锅里煮桂花"),
        ("第二首好，但最后一句能再收一下吗？",
         "改成「有人在锅里煮桂花，香气比人先到」。把嗅觉提前，收尾更有余味。"),
    ]),
    ("从日志里抠 IP 和状态码", "~/demo/scripts/logparse", 35, [
        ("日志一行长这样：2025-10-11 08:32:17 INFO 10.2.3.44 GET /api/v1/users 200 32ms，"
         "怎么用正则取 IP 和状态码？",
         "用命名分组最清楚：^(?P<time>\\S+ \\S+)\\s+\\S+\\s+(?P<ip>\\d{1,3}(?:\\.\\d{1,3}){3})"
         "\\s+\\S+\\s+\\S+\\s+(?P<status>\\d{3})\\b。状态码末尾加 \\b，避免把毫秒里的数字吃进去。"),
        ("为什么 IP 那段要写成 (?:\\.\\d{1,3}){3}？",
         "非捕获组表示「点和数字」再重复三次，正好凑够四段。用捕获组会让编号乱掉，取值容易取错。"),
        ("如果日志里的时间格式不固定呢？",
         "别在一行里全用正则硬吃。先按空白切分，从固定位置取字段，正则只负责校验 IP 和状态码，稳得多。"),
        ("Python 里 re.match 和 re.search 总混淆。",
         "match 只从开头试，search 会扫全串。日志解析用 search 更安全，"
         "除非你确定那一行开头就是时间戳。"),
    ]),
    ("这条分组查询太慢", "~/demo/db/analysis", 43, [
        ("这条查询在百万级表上要 4 秒："
         "SELECT user_id, COUNT(*) FROM events WHERE created_at >= '2025-10-01' GROUP BY user_id",
         "先看有没有 (created_at, user_id) 的联合索引，顺序不能反。有的话应该是覆盖索引扫，不该回表。"),
        ("现在只有单列 created_at 索引。",
         "单列也能用，但要回表取 user_id。加一个 (created_at, user_id) 联合索引，"
         "扫描变成 index-only，通常能快一个数量级。"),
        ("EXPLAIN 里 type=range，Extra 是 Using index condition，正常吗？",
         "说明还在回表，改成 Using index 才是覆盖索引。另外别在 where 里对 created_at 套函数，"
         "那样索引直接失效。"),
        ("分组结果几十万行，接口顶不住怎么办？",
         "考虑预聚合：按天写一张汇总表，查询时只扫汇总。实时性要求不高的话这是最省事的方案。"),
    ]),
    ("所有权到底在防什么", "~/demo/notes/rust", 52, [
        ("所有权和借用检查器到底在防什么？",
         "防数据竞争和悬垂引用。编译器保证同一时刻要么一个可变借用，要么任意多个不可变借用，"
         "这样不需要 GC 也不会出现并发写。"),
        ("为什么 String 能移动，而 i32 是复制？",
         "String 内部是堆指针，复制会导致双重释放；i32 是纯栈上的定长值，"
         "Copy trait 让它赋值时直接按位复制。"),
        ("生命周期标注是不是只在返回引用时才需要？",
         "编译器能推断的地方都不用写。写 fn f<'a>(x: &'a str) -> &'a str 这种标注，"
         "本质上是在告诉调用方返回值和入参同寿命。"),
        ("报错 value does not live long enough，怎么排查？",
         "顺着报错找到被借用的那个值，看它是不是活得太短：多半是返回了本地变量的引用，"
         "或者闭包捕获了短生命周期的变量。"),
    ]),
    ("做个番茄钟页面", "~/demo/web/pomodoro", 61, [
        ("帮我做一个番茄钟页面，25 分钟工作 5 分钟休息，单个 HTML 文件。",
         "用 setInterval 每秒刷新显示，状态机三态：idle / work / break。"
         "剩余时间用截止时间戳减 Date.now()，避免定时器被限流后计时漂移。"),
        ("后台标签页时间真的会漂？",
         "会。隐藏的标签页定时器最小间隔会被拉长到 1 秒甚至更多，"
         "所以要用截止时间算，而不是每秒减一。"),
        ("到点了怎么提醒？",
         "用 AudioContext 生成一个短促的提示音，比外链音频稳。再让 document.title 闪一下，"
         "切到别的标签页也能注意到。"),
        ("想让计时环有个进度动画。",
         "用 SVG circle 的 stroke-dasharray 和 stroke-dashoffset，"
         "每帧按剩余比例设 offset，再加个 transition 就顺了。"),
        ("多轮之后想记录今天完成了几次。",
         "次数存 localStorage，key 用日期做后缀，读的时候对比今天的日期，"
         "换天就清零，不用后端。"),
    ]),
    ("提交错了怎么撤", "~/demo/repo", 70, [
        ("我把一个不该提交的 config 推到远端了，还能撤吗？",
         "能，但历史已经被别人拉到就撤不干净。本地没推的话用 git reset --soft HEAD~1 改完再提；"
         "已经推送就用 git revert 生成一个反向提交，别去 force push 公共分支。"),
        ("reset --soft 和 --hard 区别在哪？",
         "--soft 只动提交记录，改动全留在暂存区；--mixed 退到工作区；--hard 连工作区一起删，"
         "删了基本找不回来。"),
        ("那 git revert 之后文件还在吗？",
         "在，revert 是新增一次提交把之前的改动反向应用，历史完整保留，适合已经共享的分支。"),
        ("怎么防止下次再提交错文件？",
         "把那个路径写进 .gitignore，再用 git update-index --skip-worktree 处理已经跟踪的配置文件，"
         "或者改成 .env.example 加本地覆盖。"),
        ("已经提交的历史里带着密码怎么办？",
         "先立刻去改密码并让旧密钥失效，再考虑用 filter-repo 重写历史。"
         "顺序反了的话，重写历史也没用，泄露已经发生了。"),
    ]),
    ("镜像为什么这么大", "~/demo/docker", 79, [
        ("一个 Node 服务打出来的镜像 1.2 GB，怎么瘦身？",
         "多半是用了完整基础镜像又把 node_modules 和构建缓存都拷进去了。"
         "换成多阶段构建，运行阶段只留 dist 和生产依赖，通常能砍到 150 MB 以内。"),
        ("多阶段构建具体怎么写？",
         "builder 阶段装全部依赖跑构建，运行阶段 FROM node:20-slim，只 COPY --from=builder /app/dist "
         "和 package*.json，再 npm ci --omit=dev。"),
        ("npm ci --omit=dev 会不会漏掉构建期需要的包？",
         "所以分两个阶段：builder 里装全量，运行阶段才 --omit=dev。别在同一层里又删又装，"
         "那样删掉的层依然占体积。"),
        ("镜像层数怎么减少？",
         "把相关的 RUN 用 && 串起来，一次 apt-get 里完成 update、install、清理 apt 缓存。"),
    ]),
    ("502 和 504 的区别", "~/demo/notes/http", 88, [
        ("502 和 504 都是网关错误，实际排查怎么区分？",
         "502 是网关拿到了无效响应，通常是后端进程崩了或端口没监听；504 是网关等后端超时，"
         "后端还活着但处理太慢。"),
        ("线上偶发 502，日志里没看到后端报错。",
         "先看是不是后端在重启（健康检查失败会被摘掉），再看 nginx 的 upstream 连接数是否打满，"
         "还有 listen backlog 溢出。"),
        ("504 的话优先查什么？",
         "查慢查询、线程池是否耗尽、以及网关自己的 timeout 配置是不是小于后端正常耗时。"),
    ]),
    ("缓存为什么没生效", "~/demo/notes/http", 96, [
        ("接口加了 Cache-Control: max-age=60，但浏览器每次都重新请求。",
         "打开 DevTools 看响应头是不是真带上了。常见原因是中间有 CDN 或代理覆盖了缓存头，"
         "或者请求带了 Cache-Control: no-cache。"),
        ("我看响应头里确实有 max-age=60。",
         "那看请求是不是 POST，POST 默认不缓存。还有 Vary 头缺失导致命中率异常，"
         "或者页面本身带 no-store 把整棵树都禁了。"),
        ("加 ETag 和 max-age 能同时用吗？",
         "能。max-age 内直接用本地副本，过期后带 If-None-Match 去校验，没变就返回 304，省的是带宽。"),
        ("静态资源怎么保证发版后立刻失效？",
         "文件名里带内容哈希，然后把 max-age 设成一年。index.html 本身不缓存，"
         "引用关系变了自然就换新文件。"),
    ]),
]

BASE_MS = 1_756_000_000_000  # 固定基准时间，保证截图和示例稳定可复现


def build():
    sessions = []
    for idx, (title, project, day_offset, pairs) in enumerate(TOPICS):
        # Deterministic but varied clock times, so the demo does not look seeded
        # with 13 identical timestamps.
        hour = 8 + (idx * 5) % 12
        minute = (idx * 17 + 7) % 60
        gap = (3 + idx % 5) * 60_000
        start = (BASE_MS + day_offset * 86_400_000
                 + hour * 3_600_000 + minute * 60_000 + (idx * 137) % 60_000)
        messages = []
        seq = 1
        for u, a in pairs:
            messages.append({"role": "user", "text": u, "at": start, "seq": seq})
            seq += 1
            at = start + gap
            messages.append({"role": "assistant", "text": a, "at": at, "seq": seq})
            seq += 1
            start = at + 45_000 + (idx * 7919) % 90_000
        ats = [m["at"] for m in messages]
        sessions.append({
            "id": "demo-%02d" % (idx + 1),
            "project": project,
            "title": title,
            "createdAt": min(ats),
            "lastAt": max(ats),
            "msgCount": len(messages),
            "toolCount": len(pairs),
            "messages": messages,
        })

    payload = {
        "generatedAt": BASE_MS,
        "source": "demo",
        "sessions": sessions,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    total = sum(s["msgCount"] for s in sessions)
    print("sessions: %d   messages: %d   -> %s (%.1f KB)"
          % (len(sessions), total, OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    build()