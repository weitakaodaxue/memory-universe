/* =========================================================
   记忆宇宙 · Memory Universe
   读取 memory.json，把每次对话渲染成一颗恒星，
   每条消息是恒星周围的一粒尘埃。
   ========================================================= */
(function () {
  'use strict';

  // ---------------- 常量 ----------------
  const COL_USER = 0xffb056;   // 你
  const COL_AI = 0x4fd8ff;     // 我
  const RING_R0 = 3.0;         // 尘埃环起始半径
  const RING_DR = 0.085;       // 每条消息外扩
  const TURN = 0.55;           // 螺旋角速度（弧度/条）

  // ---------------- 全局状态 ----------------
  let scene, camera, renderer, raycaster;
  const pointer = new THREE.Vector2(-99, -99);
  let sessions = [];
  let selected = null;
  const pickables = [];

  // 轨道相机
  const orbit = {
    theta: 0.9, phi: 1.12, radius: 210,
    target: new THREE.Vector3(0, 0, 0),
    tTheta: 0.9, tPhi: 1.12, tRadius: 210,
    tTarget: new THREE.Vector3(0, 0, 0)
  };

  // ---------------- 小工具 ----------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20261030);
  const DEBUG = location.search.indexOf('debug') >= 0;
  // ?warm=4.5 表示先把动画快进 4.5 秒再画，方便截图/演示拿到中间帧
  const WARM = parseFloat(new URLSearchParams(location.search).get('warm') || '0');

  function glowTexture() {
    const s = 128, c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0.0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.18, 'rgba(255,255,255,.92)');
    grd.addColorStop(0.42, 'rgba(255,255,255,.34)');
    grd.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }

  function labelTexture(text, color) {
    const fs = 44, pad = 26;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = '600 ' + fs + 'px "Microsoft YaHei",sans-serif';
    const tw = Math.ceil(probe.measureText(text).width);
    const w = tw + pad * 2;

    const c = document.createElement('canvas');
    c.width = w; c.height = fs + pad * 2;
    const g = c.getContext('2d');

    // 半透明胶囊底，保证在星空上也读得清
    const r = c.height / 2;
    g.beginPath();
    g.moveTo(r, 0); g.lineTo(w - r, 0);
    g.arcTo(w, 0, w, r, r); g.lineTo(w, c.height - r);
    g.arcTo(w, c.height, w - r, c.height, r); g.lineTo(r, c.height);
    g.arcTo(0, c.height, 0, c.height - r, r); g.lineTo(0, r);
    g.arcTo(0, 0, r, 0, r); g.closePath();
    g.fillStyle = 'rgba(4,9,18,.78)';
    g.fill();
    g.strokeStyle = color;
    g.globalAlpha = 0.55;
    g.lineWidth = 2;
    g.stroke();
    g.globalAlpha = 1;

    g.font = '600 ' + fs + 'px "Microsoft YaHei",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#eaf4ff';
    g.shadowColor = color;
    g.shadowBlur = 14;
    g.fillText(text, w / 2, c.height / 2 + 1);

    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return { tex: tex, aspect: c.width / c.height };
  }

  function projectColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return new THREE.Color().setHSL(h / 360, 0.62, 0.62);
  }

  // ---------------- 关键词向量（中文用二元组） ----------------
  function bigrams(text) {
    const clean = (text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ')
      .toLowerCase();
    const out = {};
    for (const chunk of clean.split(/\s+/)) {
      if (!chunk) continue;
      if (/^[a-z0-9]+$/.test(chunk)) {
        if (chunk.length > 2) out[chunk] = (out[chunk] || 0) + 1;
        continue;
      }
      for (let i = 0; i < chunk.length - 1; i++) {
        const bg = chunk.substr(i, 2);
        out[bg] = (out[bg] || 0) + 1;
      }
    }
    return out;
  }

  function buildVectors(list) {
    const docs = list.map(function (s) {
      const seed = s.title + ' ' + s.messages.slice(0, 6).map(function (m) { return m.text.slice(0, 400); }).join(' ');
      return bigrams(seed);
    });
    const df = {};
    docs.forEach(function (d) {
      Object.keys(d).forEach(function (k) { df[k] = (df[k] || 0) + 1; });
    });
    const N = docs.length;
    return docs.map(function (d) {
      const v = {};
      let norm = 0;
      Object.keys(d).forEach(function (k) {
        const tf = 1 + Math.log(d[k]);
        const idf = Math.log((N + 1) / ((df[k] || 0) + 1)) + 1;
        const w = tf * idf;
        v[k] = w;
        norm += w * w;
      });
      norm = Math.sqrt(norm) || 1;
      Object.keys(v).forEach(function (k) { v[k] /= norm; });
      return v;
    });
  }

  function cosine(a, b) {
    let s = 0;
    for (const k in a) if (b[k]) s += a[k] * b[k];
    return s;
  }

  // ---------------- 布局：话题聚类(XZ) + 时间(Y) ----------------
  function layout(list) {
    const n = list.length;
    const vecs = buildVectors(list);
    const sim = [];
    for (let i = 0; i < n; i++) {
      sim.push([]);
      for (let j = 0; j < n; j++) sim[i].push(i === j ? 1 : cosine(vecs[i], vecs[j]));
    }

    const R = 95;
    const pos = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pos.push({
        x: Math.cos(a) * R * 0.6 + (rnd() - 0.5) * 12,
        z: Math.sin(a) * R * 0.6 + (rnd() - 0.5) * 12
      });
    }

    // 力导向：相似则相吸，全部互斥
    for (let it = 0; it < 420; it++) {
      const fx = new Array(n).fill(0), fz = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[i].x - pos[j].x, dz = pos[i].z - pos[j].z;
          let d2 = dx * dx + dz * dz + 0.01;
          const d = Math.sqrt(d2);
          const rep = 4200 / d2;                    // 排斥
          const attr = sim[i][j] * 0.55 * d;        // 相似吸引
          const f = rep - attr;
          const ux = dx / d, uz = dz / d;
          fx[i] += ux * f; fz[i] += uz * f;
          fx[j] -= ux * f; fz[j] -= uz * f;
        }
      }
      for (let i = 0; i < n; i++) {
        pos[i].x += Math.max(-3, Math.min(3, fx[i] * 0.02));
        pos[i].z += Math.max(-3, Math.min(3, fz[i] * 0.02));
        // 弱向心，避免飘太远
        pos[i].x *= 0.995;
        pos[i].z *= 0.995;
      }
    }

    // 归一化到 ±R 并居中，避免整团星云偏到一边
    let cx = 0, cz = 0;
    pos.forEach(function (p) { cx += p.x; cz += p.z; });
    cx /= n; cz /= n;
    pos.forEach(function (p) { p.x -= cx; p.z -= cz; });

    let maxD = 1;
    pos.forEach(function (p) { maxD = Math.max(maxD, Math.hypot(p.x, p.z)); });
    const scale = R / maxD;

    const times = list.map(function (s) { return s.createdAt || 0; });
    const tMin = Math.min.apply(null, times), tMax = Math.max.apply(null, times);
    const span = Math.max(1, tMax - tMin);

    list.forEach(function (s, i) {
      s.pos = new THREE.Vector3(
        pos[i].x * scale,
        ((times[i] - tMin) / span - 0.5) * 58,
        pos[i].z * scale
      );
    });
  }

  // ---------------- 建场景 ----------------
  function initScene() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060d, 0.0011);

    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 4000);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x04060d, 1);
    document.body.appendChild(renderer.domElement);

    raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 1.8;

    addStarfield();
    addNebula();
    addMeteors();
    addSolarSystem();
  }

  function addStarfield() {
    const N = 3600;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(N * 3);
    const c = new Float32Array(N * 3);
    const col = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const r = 420 + rnd() * 900;
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(2 * rnd() - 1);
      p[i * 3] = r * Math.sin(ph) * Math.cos(th);
      p[i * 3 + 1] = r * Math.cos(ph) * 0.7;
      p[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const t = rnd();
      col.setHSL(0.55 + t * 0.12, 0.35, 0.55 + rnd() * 0.35);
      c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b;
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const m = new THREE.PointsMaterial({
      size: 2.2, sizeAttenuation: true, vertexColors: true,
      map: glowTexture(), transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    scene.add(new THREE.Points(g, m));
  }

  function addNebula() {
    const tex = glowTexture();
    const cols = [0x123a5e, 0x2a1d4d, 0x0e3f43];
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: cols[i], transparent: true, opacity: 0.30,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      const a = (i / 3) * Math.PI * 2;
      s.position.set(Math.cos(a) * 260, (rnd() - 0.5) * 160, Math.sin(a) * 260);
      s.scale.setScalar(520 + rnd() * 240);
      scene.add(s);
    }
  }

  function buildStars() {
    const glowTex = glowTexture();

    sessions.forEach(function (s) {
      const color = projectColor(s.project || s.title);
      const group = new THREE.Group();
      group.position.copy(s.pos);

      // 光晕
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      const gs = 14 + Math.min(26, s.msgCount / 22);
      glow.scale.setScalar(gs);
      group.add(glow);

      // 核心
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.85 + Math.min(1.6, s.msgCount / 420), 18, 18),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      core.userData = { kind: 'session', id: s.id };
      group.add(core);
      pickables.push(core);

      // 外圈（轨道示意）
      const seg = 96, arr = [];
      const rr = RING_R0 + s.msgCount * RING_DR;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        arr.push(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr));
      }
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arr),
        new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.16 })
      );
      group.add(ring);

      // 尘埃：每条消息一个点
      const n = s.messages.length;
      const pos = new Float32Array(n * 3);
      const colr = new Float32Array(n * 3);
      const base = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const m = s.messages[i];
        const a = i * TURN;
        const r = RING_R0 + i * RING_DR;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = Math.sin(i * 1.7) * 0.55 + (rnd() - 0.5) * 0.3;
        pos[i * 3 + 2] = Math.sin(a) * r;
        base.setHex(m.role === 'user' ? COL_USER : COL_AI);
        colr[i * 3] = base.r; colr[i * 3 + 1] = base.g; colr[i * 3 + 2] = base.b;
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      pg.setAttribute('color', new THREE.BufferAttribute(colr, 3));
      const pm = new THREE.PointsMaterial({
        size: 1.5, sizeAttenuation: true, vertexColors: true,
        map: glowTex, transparent: true, opacity: 0.95,
        depthWrite: false, blending: THREE.AdditiveBlending
      });
      const points = new THREE.Points(pg, pm);
      points.userData = { kind: 'messages', id: s.id };
      group.add(points);
      pickables.push(points);

      // 标签
      const lab = labelTexture(s.title, '#' + color.getHexString());
      const ls = new THREE.Sprite(new THREE.SpriteMaterial({
        map: lab.tex, transparent: true, opacity: 0.92,
        depthWrite: false, depthTest: false
      }));
      const h = 3.2;
      ls.scale.set(h * lab.aspect, h, 1);
      ls.position.set(0, 6.4, 0);
      group.add(ls);

      scene.add(group);
      s.obj = { group: group, glow: glow, core: core, points: points, label: ls, ring: ring, color: color, aspect: lab.aspect };
    });
  }

  // ---------------- 流星 ----------------
  const meteors = [];
  let streakTex = null;
  const _pa = new THREE.Vector3();
  const _pb = new THREE.Vector3();

  function streakTexture() {
    const w = 64, h = 256;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');

    // 纵向：尾端透明 -> 头端实白
    const vg = g.createLinearGradient(0, h, 0, 0);
    vg.addColorStop(0.00, 'rgba(120,200,255,0)');
    vg.addColorStop(0.45, 'rgba(170,225,255,.45)');
    vg.addColorStop(0.80, 'rgba(215,240,255,.85)');
    vg.addColorStop(1.00, 'rgba(255,255,255,1)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);

    // 横向羽化，避免出现生硬的矩形边
    const hg = g.createLinearGradient(0, 0, w, 0);
    hg.addColorStop(0.00, 'rgba(0,0,0,0)');
    hg.addColorStop(0.50, 'rgba(0,0,0,1)');
    hg.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = hg;
    g.fillRect(0, 0, w, h);

    return new THREE.CanvasTexture(c);
  }

  function addMeteors() {
    streakTex = streakTexture();
    for (let i = 0; i < 9; i++) {
      const group = new THREE.Group();

      // 拖尾：一张朝相机的长条渐变，按运动方向在屏幕空间旋转
      const streak = new THREE.Sprite(new THREE.SpriteMaterial({
        map: streakTex, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      group.add(streak);

      // 头部亮点
      const head = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: 0xeaf7ff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      head.scale.setScalar(9);
      group.add(head);

      scene.add(group);
      const m = {
        group: group, head: head, streak: streak,
        from: new THREE.Vector3(), to: new THREE.Vector3(), dir: new THREE.Vector3(),
        life: 0, dur: 1, wait: 0
      };
      meteors.push(m);
      // 错开出发时间，开场几秒内就有流星划过
      launchMeteor(m, i * 0.9 + rnd() * 2.0);
    }
  }

  function launchMeteor(m, wait) {
    // 从星云外围斜穿而过，保证经过镜头正前方
    const R = 300;
    const a = rnd() * Math.PI * 2;
    const elev = (rnd() - 0.5) * 110;
    m.from.set(Math.cos(a) * R, elev, Math.sin(a) * R);

    const a2 = a + Math.PI + (rnd() - 0.5) * 0.8;
    m.to.set(Math.cos(a2) * R, -elev * 0.6 + (rnd() - 0.5) * 70, Math.sin(a2) * R);

    m.dir.copy(m.to).sub(m.from).normalize();
    m.dur = 1.3 + rnd() * 1.4;
    m.life = 0;
    m.wait = wait;
  }

  function updateMeteors(dt) {
    for (let i = 0; i < meteors.length; i++) {
      const m = meteors[i];

      if (m.wait > 0) {
        m.wait -= dt;
        m.head.material.opacity = 0;
        m.streak.material.opacity = 0;
        if (m.wait <= 0) launchMeteor(m, 0);
        continue;
      }

      m.life += dt;
      const k = m.life / m.dur;

      if (k >= 1) {
        m.head.material.opacity = 0;
        m.streak.material.opacity = 0;
        launchMeteor(m, 0.6 + rnd() * 4.5);
        continue;
      }

      m.group.position.lerpVectors(m.from, m.to, k);
      const fade = Math.sin(k * Math.PI);

      m.head.material.opacity = fade;
      m.head.scale.setScalar(7 + fade * 8);

      // 屏幕空间里算出运动方向，让拖尾永远顺着飞行的方向
      const p0 = m.group.position;
      _pa.copy(p0).project(camera);
      _pb.copy(p0).addScaledVector(m.dir, 24).project(camera);
      const ang = Math.atan2(_pb.y - _pa.y, _pb.x - _pa.x) - Math.PI / 2;

      const len = 26 + fade * 44;
      m.streak.material.rotation = ang;
      m.streak.scale.set(len * 0.18, len, 1);
      m.streak.position.copy(m.dir).multiplyScalar(-len * 0.5);
      m.streak.material.opacity = fade * 0.95;
    }
  }

  // ---------------- 太阳系：恒星 + 尘埃盘 + 轨道环 + 八大行星 ----------------
  const planets = [];
  const systemGroup = new THREE.Group();
  const SUN_OFF = -78;          // 恒星在盘面上的偏移（营造"光从一端扫过来"）
  const SUN_ANG = Math.PI;      // 对应角度

  function planetTexture(bands) {
    const w = 256, h = 128;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      g.fillStyle = b.c;
      g.globalAlpha = b.a;
      g.fillRect(0, Math.round(b.y * h), w, Math.round(b.h * h) + 1);
    }
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }

  function addSolarSystem() {
    const tex = glowTexture();

    // 盘面：接近侧视，环拉成横贯画面的长椭圆，正好当背景
    systemGroup.position.set(10, 96, -300);
    systemGroup.rotation.x = 1.02;
    systemGroup.rotation.z = -0.14;
    scene.add(systemGroup);

    // ---------- 恒星 ----------
    const sunGroup = new THREE.Group();
    sunGroup.position.set(SUN_OFF, 0, 0);
    systemGroup.add(sunGroup);

    const haloOuter = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xff6a1e, transparent: true, opacity: 0.50,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    haloOuter.scale.setScalar(560);
    sunGroup.add(haloOuter);

    const haloMid = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xffa949, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    haloMid.scale.setScalar(230);
    sunGroup.add(haloMid);

    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(13, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xfffaf0 })
    );
    sunGroup.add(sunCore);

    // ---------- 尘埃盘 / 小行星带 ----------
    const DUST = 11000;
    const dpos = new Float32Array(DUST * 3);
    const dcol = new Float32Array(DUST * 3);
    const warm = new THREE.Color(0xffb14a);
    const cool = new THREE.Color(0x9fc0ff);
    const tmpC = new THREE.Color();

    for (let i = 0; i < DUST; i++) {
      let r;
      const pick = rnd();
      if (pick < 0.40) {
        r = 28 + rnd() * 46;
      } else if (pick < 0.88) {
        r = 82 + Math.pow(rnd(), 0.7) * 40;
      } else {
        r = 130 + rnd() * 96;
      }
      const a = rnd() * Math.PI * 2;

      dpos[i * 3] = Math.cos(a) * r;
      dpos[i * 3 + 1] = (rnd() - 0.5) * 3.0 * (1 - r / 250);
      dpos[i * 3 + 2] = Math.sin(a) * r;

      // 朝向恒星的一侧被照亮
      const heat = Math.pow((Math.cos(a - SUN_ANG) + 1) / 2, 2.0);
      tmpC.copy(cool).lerp(warm, heat);
      const bright = 0.30 + 1.0 * heat;
      dcol[i * 3] = tmpC.r * bright;
      dcol[i * 3 + 1] = tmpC.g * bright;
      dcol[i * 3 + 2] = tmpC.b * bright;
    }

    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
    dgeo.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
    const dust = new THREE.Points(dgeo, new THREE.PointsMaterial({
      map: tex, size: 1.9, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    dust.frustumCulled = false;
    systemGroup.add(dust);

    // ---------- 轨道环：有厚度的环面，比 1px 线更有实体感 ----------
    for (let i = 0; i < 46; i++) {
      const r = 26 + Math.pow(i / 45, 0.85) * 208;
      const heat = 1 - Math.pow(i / 45, 0.75);
      const w = 0.35 + heat * 0.85;

      const geo = new THREE.RingGeometry(r - w / 2, r + w / 2, 160, 1);
      geo.rotateX(-Math.PI / 2);

      const col = new THREE.Color().copy(cool).lerp(warm, heat * 0.95);
      const ring = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: col, transparent: true,
        opacity: 0.045 + heat * 0.115,
        side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending
      }));
      ring.frustumCulled = false;
      systemGroup.add(ring);
    }

    // ---------- 八大行星 ----------
    const LIST = [
      { name: '水星', r: 34, s: 2.2, c: 0xb0a08c, w: 0.52 },
      { name: '金星', r: 50, s: 3.4, c: 0xf0c874, w: 0.40 },
      { name: '地球', r: 68, s: 3.6, c: 0x5aa8e8, w: 0.33 },
      { name: '火星', r: 88, s: 2.8, c: 0xd4552a, w: 0.27 },
      { name: '木星', r: 120, s: 8.0, c: 0xe0d0a4, w: 0.18, bands: true },
      { name: '土星', r: 152, s: 6.6, c: 0xecdcae, w: 0.13, ring: true },
      { name: '天王星', r: 182, s: 4.8, c: 0xa8e4ea, w: 0.10 },
      { name: '海王星', r: 208, s: 4.6, c: 0x5a7fe8, w: 0.08 }
    ];

    LIST.forEach(function (p) {
      const mat = p.bands
        ? new THREE.MeshBasicMaterial({
            map: planetTexture([
              { y: 0.00, h: 0.18, c: '#c9b280', a: 1 },
              { y: 0.18, h: 0.10, c: '#efe2b8', a: 1 },
              { y: 0.28, h: 0.14, c: '#b8865a', a: 1 },
              { y: 0.42, h: 0.12, c: '#f2e6c4', a: 1 },
              { y: 0.54, h: 0.16, c: '#c08a5c', a: 1 },
              { y: 0.70, h: 0.12, c: '#eaddb0', a: 1 },
              { y: 0.82, h: 0.18, c: '#a87450', a: 1 }
            ])
          })
        : new THREE.MeshBasicMaterial({ color: p.c });

      const body = new THREE.Mesh(new THREE.SphereGeometry(p.s, 24, 24), mat);

      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: p.c, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      halo.scale.setScalar(p.s * 6.0);
      body.add(halo);

      systemGroup.add(body);

      if (p.ring) {
        const rp = [];
        for (let i = 0; i <= 128; i++) {
          const a = (i / 128) * Math.PI * 2;
          rp.push(new THREE.Vector3(Math.cos(a) * p.s * 2.5, 0, Math.sin(a) * p.s * 2.5));
        }
        const sat = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(rp),
          new THREE.LineBasicMaterial({
            color: 0xf2e3b8, transparent: true, opacity: 0.6,
            depthWrite: false, blending: THREE.AdditiveBlending
          })
        );
        sat.rotation.x = 0.40;
        body.add(sat);
      }

      planets.push({ body: body, r: p.r, w: p.w, a: rnd() * Math.PI * 2, s: p.s });
    });
  }

  function updateSolarSystem(dt) {
    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      p.a += p.w * dt;
      p.body.position.set(Math.cos(p.a) * p.r, 0, Math.sin(p.a) * p.r);
      p.body.rotation.y += dt * 0.7;
    }
  }

  // ---------------- 相机 ----------------
  function updateCamera(dt) {
    const k = 1 - Math.pow(0.001, dt);
    orbit.theta += (orbit.tTheta - orbit.theta) * k;
    orbit.phi += (orbit.tPhi - orbit.phi) * k;
    orbit.radius += (orbit.tRadius - orbit.radius) * k;
    orbit.target.lerp(orbit.tTarget, k);

    const sp = Math.sin(orbit.phi);
    camera.position.set(
      orbit.target.x + orbit.radius * sp * Math.sin(orbit.theta),
      orbit.target.y + orbit.radius * Math.cos(orbit.phi),
      orbit.target.z + orbit.radius * sp * Math.cos(orbit.theta)
    );
    camera.lookAt(orbit.target);
  }

  // ---------------- 交互 ----------------
  function initInteraction() {
    const el = renderer.domElement;
    let down = false, moved = 0, lx = 0, ly = 0;

    el.addEventListener('pointerdown', function (e) {
      down = true; moved = 0; lx = e.clientX; ly = e.clientY;
    });

    el.addEventListener('pointerup', function (e) {
      down = false;
      if (moved < 6) pick(e.clientX, e.clientY);
    });

    el.addEventListener('pointermove', function (e) {
      pointer.x = (e.clientX / innerWidth) * 2 - 1;
      pointer.y = -(e.clientY / innerHeight) * 2 + 1;
      if (!down) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      lx = e.clientX; ly = e.clientY;
      orbit.tTheta -= dx * 0.005;
      orbit.tPhi = Math.max(0.16, Math.min(3.0, orbit.tPhi - dy * 0.005));
    });

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      orbit.tRadius = Math.max(18, Math.min(900, orbit.tRadius * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });

    addEventListener('resize', function () {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });
  }

  function pick(cx, cy) {
    const nx = (cx / innerWidth) * 2 - 1;
    const ny = -(cy / innerHeight) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hits = raycaster.intersectObjects(pickables, false);
    if (!hits.length) return;

    const h = hits[0];
    const ud = h.object.userData || {};
    const s = sessions.find(function (x) { return x.id === ud.id; });
    if (!s) return;

    if (ud.kind === 'session') {
      selectSession(s, null);
    } else {
      selectSession(s, h.index);
    }
  }

  function selectSession(s, msgIndex) {
    selected = s;
    document.getElementById('panel').classList.add('open');
    document.getElementById('p-proj').textContent = s.project || '';
    document.getElementById('p-title').textContent = s.title;
    document.getElementById('p-meta').textContent =
      s.msgCount + ' 条消息 · ' +
      (s.toolCount || 0) + ' 次工具调用 · ' +
      fmt(s.createdAt) + ' → ' + fmt(s.lastAt);

    renderMessages(s);

    // 相机飞过去
    orbit.tTarget.copy(s.pos);
    const r = RING_R0 + s.msgCount * RING_DR;
    orbit.tRadius = Math.max(30, r * 2.6);

    // 高亮
    sessions.forEach(function (o) {
      const on = o === s;
      o.obj.glow.material.opacity = on ? 1.0 : 0.42;
      o.obj.points.material.opacity = on ? 1.0 : 0.38;
      o.obj.label.material.opacity = on ? 1.0 : 0.55;
      o.obj.ring.material.opacity = on ? 0.34 : 0.10;
    });

    // 左侧列表同步
    document.querySelectorAll('.item').forEach(function (el) {
      el.classList.toggle('on', el.dataset.id === s.id);
    });

    if (msgIndex != null) {
      const box = document.getElementById('msgs');
      const target = box.querySelector('[data-i="' + msgIndex + '"]');
      if (target) {
        target.classList.add('hl');
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  function renderMessages(s) {
    const box = document.getElementById('msgs');
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    s.messages.forEach(function (m, i) {
      const d = document.createElement('div');
      d.className = 'msg ' + (m.role === 'user' ? 'u' : 'a');
      d.dataset.i = i;

      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = (m.role === 'user' ? '你' : '助手') + ' · ' + fmtShort(m.at);

      const tx = document.createElement('div');
      tx.className = 'tx clip';
      tx.textContent = m.text;

      d.appendChild(who);
      d.appendChild(tx);

      if (m.text.length > 220) {
        const more = document.createElement('div');
        more.className = 'more';
        more.textContent = '展开全文';
        more.onclick = function () {
          const clipped = tx.classList.toggle('clip');
          more.textContent = clipped ? '展开全文' : '收起';
        };
        d.appendChild(more);
      }
      frag.appendChild(d);
    });
    box.appendChild(frag);
    box.scrollTop = 0;
  }

  function fmt(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
      ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function fmtShort(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }

  // ---------------- 侧栏 ----------------
  function buildList() {
    const box = document.getElementById('list');
    box.innerHTML = '';
    sessions.forEach(function (s) {
      const el = document.createElement('div');
      el.className = 'item';
      el.dataset.id = s.id;

      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.style.color = '#' + s.obj.color.getHexString();
      dot.style.background = '#' + s.obj.color.getHexString();

      const wrap = document.createElement('div');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = s.title;
      const m = document.createElement('div');
      m.className = 'm';
      m.textContent = s.msgCount + ' 条 · ' + fmt(s.createdAt).slice(5, 16);
      wrap.appendChild(t); wrap.appendChild(m);

      el.appendChild(dot); el.appendChild(wrap);
      el.onclick = function () { selectSession(s, null); };
      box.appendChild(el);
    });
  }

  // ---------------- 搜索 ----------------
  function initSearch() {
    const q = document.getElementById('q');
    q.addEventListener('input', function () {
      const kw = q.value.trim().toLowerCase();
      let firstHit = null;

      sessions.forEach(function (s) {
        const hit = !kw ||
          s.title.toLowerCase().indexOf(kw) >= 0 ||
          s.messages.some(function (m) { return m.text.toLowerCase().indexOf(kw) >= 0; });
        s.obj.glow.material.opacity = hit ? (selected === s ? 1 : 0.85) : 0.10;
        s.obj.points.material.opacity = hit ? 0.95 : 0.08;
        s.obj.label.material.opacity = hit ? 0.92 : 0.18;
        if (hit && !firstHit) firstHit = s;
      });

      document.querySelectorAll('.item').forEach(function (el) {
        const s = sessions.find(function (x) { return x.id === el.dataset.id; });
        const hit = !kw ||
          s.title.toLowerCase().indexOf(kw) >= 0 ||
          s.messages.some(function (m) { return m.text.toLowerCase().indexOf(kw) >= 0; });
        el.style.opacity = hit ? 1 : 0.28;
      });
    });
  }

  // ---------------- 渲染循环 ----------------
  let last = performance.now();
  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    updateCamera(dt);
    updateMeteors(dt);
    updateSolarSystem(dt);

    // 星体自转，尘埃缓缓旋动
    sessions.forEach(function (s, i) {
      s.obj.group.rotation.y += dt * (0.045 + i * 0.004);
      s.obj.glow.material.rotation += dt * 0.1;
      const pulse = 1 + Math.sin(now * 0.0016 + i) * 0.035;
      s.obj.glow.scale.setScalar(s.obj.glow.scale.x * 0.98 + (14 + Math.min(26, s.msgCount / 22)) * pulse * 0.02);

      // 标签恒定屏幕大小，远近都读得清
      const d = camera.position.distanceTo(s.obj.group.position);
      const sc = Math.max(2.0, Math.min(16, d * 0.032));
      s.obj.label.scale.set(sc * s.obj.aspect, sc, 1);
      s.obj.label.position.y = sc * 1.25;
    });

    if (DEBUG) {
      let fly = 0, vis = 0;
      for (let i = 0; i < meteors.length; i++) {
        const mm = meteors[i];
        if (mm.wait <= 0 && mm.life > 0) {
          fly++;
          const wp = mm.group.position.clone().project(camera);
          if (Math.abs(wp.x) < 1 && Math.abs(wp.y) < 1 && wp.z < 1) vis++;
        }
      }
      document.title = 'METEOR fly=' + fly + ' inView=' + vis + ' op=' +
        (meteors[0] ? meteors[0].head.material.opacity.toFixed(2) : 'na');
    }

    renderer.render(scene, camera);
  }

  // ---------------- 启动 ----------------
  // 单文件版把数据内联在 window.MEMORY；网页版才去 fetch。
  // 没有自己的 memory.json 时，自动退回仓库自带的示例数据 memory.demo.json。
  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }
  const source = window.MEMORY
    ? Promise.resolve(window.MEMORY)
    : loadJSON('memory.json?t=' + Date.now()).catch(function () {
        return loadJSON('memory.demo.json');
      });

  source
    .then(function (data) {
      sessions = data.sessions || [];
      sessions.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

      const totalMsg = sessions.reduce(function (a, s) { return a + s.msgCount; }, 0);
      const totalTool = sessions.reduce(function (a, s) { return a + (s.toolCount || 0); }, 0);
      document.getElementById('s-sessions').textContent = sessions.length;
      document.getElementById('s-msgs').textContent = totalMsg;
      document.getElementById('s-tools').textContent = totalTool;

      initScene();
      layout(sessions);
      buildStars();
      buildList();
      initInteraction();
      initSearch();

      document.getElementById('close').onclick = function () {
        document.getElementById('panel').classList.remove('open');
        selected = null;
        sessions.forEach(function (o) {
          o.obj.glow.material.opacity = 0.85;
          o.obj.points.material.opacity = 0.95;
          o.obj.label.material.opacity = 0.92;
          o.obj.ring.material.opacity = 0.16;
        });
        orbit.tTarget.set(-26, 0, 0);
        orbit.tRadius = Math.max(140, far * 2.1);
        document.querySelectorAll('.item').forEach(function (el) { el.classList.remove('on'); });
      };

      // 开局：全景视角，把全部星辰框进画面
      let far = 0;
      sessions.forEach(function (s) {
        const r = RING_R0 + s.msgCount * RING_DR;
        far = Math.max(far, s.pos.length() + r);
      });
      orbit.tRadius = Math.max(140, far * 2.1);
      orbit.radius = orbit.tRadius;
      orbit.target.set(-26, 0, 0);
      orbit.tTarget.set(-26, 0, 0);
      const fi = new URLSearchParams(location.search).get("focus");
      if (fi !== null && sessions[+fi]) selectSession(sessions[+fi], null);

      if (WARM > 0) {
        const steps = Math.min(3600, Math.round(WARM * 60));
        for (let k = 0; k < steps; k++) {
          updateCamera(1 / 60);
          updateMeteors(1 / 60);
          updateSolarSystem(1 / 60);
        }
      }

      tick();
    })
    .catch(function (e) {
      document.body.innerHTML =
        '<pre style="color:#f88;padding:40px;font-size:13px">' + (e && e.stack || e) + '</pre>';
    });

})();