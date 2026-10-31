/* =========================================================
   记忆宇宙 · Memory Universe
   把每次对话渲染成一颗恒星，每条消息是恒星周围的一粒尘埃。
   ---------------------------------------------------------
   ?bloom=0   关闭后期泛光        ?swirl=0   关闭星系漩涡
   ?boot=0    跳过开场动画        ?warm=4    动画预演 4 秒
   ?focus=3   开局聚焦第 4 个会话  ?debug=1   调试信息写进标题
   ========================================================= */
(function () {
  'use strict';

  // ---------------- 常量 ----------------
  const COL_USER = 0xffb056;
  const COL_AI = 0x4fd8ff;
  const RING_R0 = 3.0;
  const RING_DR = 0.085;
  const GALAXY_R = 236;        // 旋臂外径，取景时也要框进去
  let galaxyPts = null;        // 旋臂点云，取景时按星团规模缩放
  const TURN = 0.55;

  const QS = new URLSearchParams(location.search);
  function flag(k, dflt) {
    const v = QS.get(k);
    return v === null ? dflt : (v !== '0' && v !== 'false');
  }
  const WARM = parseFloat(QS.get('warm') || '0');
  const DEBUG = QS.has('debug');
  const USE_BLOOM = flag('bloom', true);
  const USE_SWIRL = flag('swirl', true);
  const USE_BOOT = flag('boot', true);

  // ---------------- 全局状态 ----------------
  let scene, camera, renderer, raycaster;
  const pointer = new THREE.Vector2(0, 0);      // -1..1，用于视差
  const pointerPx = { x: -1e4, y: -1e4, moved: true };
  let sessions = [];
  let selected = null;
  let hovered = null;
  const hitSpheres = [];
  const messagePoints = [];
  let clock = 0;

  // 轨道相机
  const orbit = {
    theta: 0.9, phi: 1.12, radius: 210,
    target: new THREE.Vector3(-26, 0, 0),
    tTheta: 0.9, tPhi: 1.12,
    baseShift: 0               // 侧栏常驻，视线中心左移，把星图推到空出来的那半边
  };
  let flight = null;          // 缓动飞行
  let panelShift = 0;         // 面板打开时把视线中心右移
  let panelShiftT = 0;

  // ---------------- 缓动 ----------------
  function easeInOutCubic(k) {
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  }
  function easeOutQuint(k) { return 1 - Math.pow(1 - k, 5); }
  function toward(cur, target, dt, speed) {
    return cur + (target - cur) * (1 - Math.exp(-speed * dt));
  }

  function flightTo(target, radius, dur, ease) {
    flight = {
      t: 0, dur: dur || 1.15, ease: ease || easeInOutCubic,
      r0: orbit.radius, r1: radius,
      p0: orbit.target.clone(), p1: target.clone()
    };
  }

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
      const seed = s.title + ' ' + s.messages.slice(0, 6).map(function (m) {
        return m.text.slice(0, 400);
      }).join(' ');
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

  // ---------------- 布局：话题聚类(XZ) → 星系漩涡 → 时间(Y) ----------------
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
          const dx = pos[i].x - pos[j].x, dz = pos[i].z - pos[j].z;
          const d2 = dx * dx + dz * dz + 0.01;
          const d = Math.sqrt(d2);
          const rep = 4200 / d2;
          const attr = sim[i][j] * 0.55 * d;
          const f = rep - attr;
          const ux = dx / d, uz = dz / d;
          fx[i] += ux * f; fz[i] += uz * f;
          fx[j] -= ux * f; fz[j] -= uz * f;
        }
      }
      for (let i = 0; i < n; i++) {
        pos[i].x += Math.max(-3, Math.min(3, fx[i] * 0.02));
        pos[i].z += Math.max(-3, Math.min(3, fz[i] * 0.02));
        pos[i].x *= 0.995;
        pos[i].z *= 0.995;
      }
    }

    let cx = 0, cz = 0;
    pos.forEach(function (p) { cx += p.x; cz += p.z; });
    cx /= n; cz /= n;
    pos.forEach(function (p) { p.x -= cx; p.z -= cz; });

    let maxD = 1;
    pos.forEach(function (p) { maxD = Math.max(maxD, Math.hypot(p.x, p.z)); });
    const scale = R / maxD;

    // 与背景星系的旋臂同一族：角度随半径剪切，星团顺势排进旋臂
    const SPIRAL_K = 0.92;
    pos.forEach(function (p) {
      p.x *= scale; p.z *= scale;
      if (!USE_SWIRL) return;
      const r = Math.hypot(p.x, p.z);
      if (r < 1) return;
      const a = Math.atan2(p.z, p.x) + SPIRAL_K * Math.log(Math.max(r, 8) / 26);
      p.x = Math.cos(a) * r;
      p.z = Math.sin(a) * r;
    });

    const times = list.map(function (s) { return s.createdAt || 0; });
    const tMin = Math.min.apply(null, times), tMax = Math.max.apply(null, times);
    const span = Math.max(1, tMax - tMin);

    list.forEach(function (s, i) {
      s.pos = new THREE.Vector3(
        pos[i].x,
        ((times[i] - tMin) / span - 0.5) * 58,
        pos[i].z
      );
    });
  }

  // ---------------- 后期处理：泛光 + 暗角 ----------------
  const post = {
    on: false, rtScene: null, rtA: null, rtB: null,
    quadScene: null, quadCam: null, quad: null,
    bright: null, blur: null, comp: null
  };

  function makeRT(w, h) {
    return new THREE.WebGLRenderTarget(
      Math.max(2, Math.floor(w)), Math.max(2, Math.floor(h)), {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false
      });
  }

  const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  function initPost() {
    if (!USE_BLOOM) return;

    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    post.rtScene = makeRT(sz.x, sz.y);
    post.rtA = makeRT(sz.x / 2, sz.y / 2);
    post.rtB = makeRT(sz.x / 2, sz.y / 2);

    post.quadScene = new THREE.Scene();
    post.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    post.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    post.quad.frustumCulled = false;
    post.quadScene.add(post.quad);

    post.bright = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        threshold: { value: 0.84 }
      },
      vertexShader: VERT,
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform float threshold; varying vec2 vUv;',
        'void main(){',
        '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
        '  float l = max(c.r, max(c.g, c.b));',
        '  float k = smoothstep(threshold, threshold + 0.22, l);',
        '  gl_FragColor = vec4(c * k, 1.0);',
        '}'
      ].join('\n'),
      depthTest: false, depthWrite: false
    });

    post.blur = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        dir: { value: new THREE.Vector2(1 / 512, 0) }
      },
      vertexShader: VERT,
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform vec2 dir; varying vec2 vUv;',
        'void main(){',
        '  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;',
        '  s += texture2D(tDiffuse, vUv + dir * 1.3846153846).rgb * 0.3162162162;',
        '  s += texture2D(tDiffuse, vUv - dir * 1.3846153846).rgb * 0.3162162162;',
        '  s += texture2D(tDiffuse, vUv + dir * 3.2307692308).rgb * 0.0702702703;',
        '  s += texture2D(tDiffuse, vUv - dir * 3.2307692308).rgb * 0.0702702703;',
        '  gl_FragColor = vec4(s, 1.0);',
        '}'
      ].join('\n'),
      depthTest: false, depthWrite: false
    });

    post.comp = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        strength: { value: 0.40 },
        vig: { value: 0.34 }
      },
      vertexShader: VERT,
      fragmentShader: [
        'uniform sampler2D tScene; uniform sampler2D tBloom;',
        'uniform float strength; uniform float vig;',
        'varying vec2 vUv;',
        'void main(){',
        '  vec3 col = texture2D(tScene, vUv).rgb;',
        '  vec3 bloom = texture2D(tBloom, vUv).rgb;',
        '  col += bloom * strength;',
        '  col = col / (1.0 + col * 0.16);',            // 柔和压高光，不糊
        '  float d = length(vUv - 0.5);',
        '  col *= mix(1.0, 1.0 - vig, smoothstep(0.30, 0.86, d));',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n'),
      depthTest: false, depthWrite: false
    });

    post.on = true;
  }

  function disposePost() {
    if (!post.on) return;
    post.rtScene.dispose();
    post.rtA.dispose();
    post.rtB.dispose();
    post.on = false;
  }

  function resizePost() {
    if (!post.on) return;
    const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
    post.rtScene.setSize(Math.max(2, Math.floor(sz.x)), Math.max(2, Math.floor(sz.y)));
    post.rtA.setSize(Math.max(2, Math.floor(sz.x / 2)), Math.max(2, Math.floor(sz.y / 2)));
    post.rtB.setSize(Math.max(2, Math.floor(sz.x / 2)), Math.max(2, Math.floor(sz.y / 2)));
  }

  function blit(material, target) {
    post.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(post.quadScene, post.quadCam);
  }

  function renderFrame() {
    if (!post.on) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    renderer.setRenderTarget(post.rtScene);
    renderer.render(scene, camera);

    post.bright.uniforms.tDiffuse.value = post.rtScene.texture;
    blit(post.bright, post.rtA);

    for (let i = 0; i < 2; i++) {
      post.blur.uniforms.tDiffuse.value = post.rtA.texture;
      post.blur.uniforms.dir.value.set(1 / post.rtA.width, 0);
      blit(post.blur, post.rtB);

      post.blur.uniforms.tDiffuse.value = post.rtB.texture;
      post.blur.uniforms.dir.value.set(0, 1 / post.rtB.height);
      blit(post.blur, post.rtA);
    }

    post.comp.uniforms.tScene.value = post.rtScene.texture;
    post.comp.uniforms.tBloom.value = post.rtA.texture;
    blit(post.comp, null);
  }

  // ---------------- 建场景 ----------------
  let starfield = null;
  const nebulas = [];

  function initScene() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060d, 0.0011);

    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 4000);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x04060d, 1);
    document.body.appendChild(renderer.domElement);

    raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 1.8;

    addStarfield();
    addGalaxy();
    addNebula();
    addMeteors();
    addSolarSystem();
    initPost();
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
    starfield = new THREE.Points(g, m);
    scene.add(starfield);
  }

  // 背景星系旋臂：与星团共用一条对数螺旋线
  function addGalaxy() {
    const ARMS = 2, PER = 1600, R0 = 24, RMAX = GALAXY_R, TWIST = 1.18;
    const N = ARMS * PER;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const core = new THREE.Color(0xffd9a6);
    const edge = new THREE.Color(0x6f8fd6);
    const tmp = new THREE.Color();

    for (let i = 0; i < N; i++) {
      const arm = i % ARMS;
      const t = Math.pow(rnd(), 0.65);
      const r = R0 + t * (RMAX - R0);
      const spread = (rnd() - 0.5) * (0.28 + t * 0.55);
      const a = arm * (Math.PI * 2 / ARMS) + TWIST * Math.log(r / R0) + spread;

      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = (rnd() - 0.5) * (5 - t * 3.4);
      pos[i * 3 + 2] = Math.sin(a) * r;

      tmp.copy(core).lerp(edge, Math.pow(t, 0.8));
      const b = 0.42 + rnd() * 0.5;
      col[i * 3] = tmp.r * b; col[i * 3 + 1] = tmp.g * b; col[i * 3 + 2] = tmp.b * b;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.05, sizeAttenuation: true, vertexColors: true,
      map: glowTexture(), transparent: true, opacity: 0.58,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    pts.frustumCulled = false;
    scene.add(pts);
    galaxyPts = pts;
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
      s.position.set(Math.cos(a) * 300, (rnd() - 0.5) * 190, Math.sin(a) * 300);
      s.scale.setScalar(560 + rnd() * 260);
      nebulas.push(s);
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

      // 核心（带一点本星颜色，纯白在泛光下会全糊成一片）
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.85 + Math.min(1.6, s.msgCount / 420), 18, 18),
        new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.62) })
      );
      group.add(core);

      // 拾取用的隐形球（比核心大，鼠标更容易命中）
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(7, 12, 12),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.userData = { kind: 'session', id: s.id };
      group.add(hit);
      hitSpheres.push(hit);

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
      messagePoints.push(points);

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
      s.obj = {
        group: group, glow: glow, core: core, points: points,
        label: ls, ring: ring, color: color, aspect: lab.aspect,
        baseGlow: gs, scale: 1, liftCur: 0, liftT: 0
      };
      // 透明度目标值，逐帧逼近 = 所有淡入淡出都平滑
      s.op = { glow: 0.85, points: 0.95, label: 0.92, ring: 0.16 };
    });

    buildLinks();
    computeNeighbors();
  }

  // ---------------- 悬停连线 ----------------
  let linkObj = null, linkMat = null, linkGeo = null;
  let linkOpacity = 0;

  function buildLinks() {
    linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 3), 3));
    linkMat = new THREE.LineBasicMaterial({
      color: 0x9fe2ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    linkObj = new THREE.LineSegments(linkGeo, linkMat);
    linkObj.frustumCulled = false;
    scene.add(linkObj);
    linkObj.visible = false;
  }

  function computeNeighbors() {
    sessions.forEach(function (s) {
      const others = sessions.filter(function (o) { return o !== s; });
      others.sort(function (a, b) {
        return a.pos.distanceToSquared(s.pos) - b.pos.distanceToSquared(s.pos);
      });
      s.near = others.slice(0, 3);
    });
  }

  function showLinks(s) {
    const arr = linkGeo.attributes.position.array;
    let k = 0;
    s.near.forEach(function (o) {
      arr[k++] = s.pos.x; arr[k++] = s.pos.y; arr[k++] = s.pos.z;
      arr[k++] = o.pos.x; arr[k++] = o.pos.y; arr[k++] = o.pos.z;
    });
    linkGeo.attributes.position.needsUpdate = true;
    linkObj.visible = true;
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

    const vg = g.createLinearGradient(0, h, 0, 0);
    vg.addColorStop(0.00, 'rgba(120,200,255,0)');
    vg.addColorStop(0.45, 'rgba(170,225,255,.45)');
    vg.addColorStop(0.80, 'rgba(215,240,255,.85)');
    vg.addColorStop(1.00, 'rgba(255,255,255,1)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, h);

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
      const streak = new THREE.Sprite(new THREE.SpriteMaterial({
        map: streakTex, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      group.add(streak);

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
      launchMeteor(m, i * 0.9 + rnd() * 2.0);
    }
  }

  function launchMeteor(m, wait) {
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
      m.head.scale.setScalar(5 + fade * 6);

      const p0 = m.group.position;
      _pa.copy(p0).project(camera);
      _pb.copy(p0).addScaledVector(m.dir, 24).project(camera);
      const ang = Math.atan2(_pb.y - _pa.y, _pb.x - _pa.x) - Math.PI / 2;

      const len = 26 + fade * 44;
      m.streak.material.rotation = ang;
      m.streak.scale.set(len * 0.18, len, 1);
      m.streak.position.copy(m.dir).multiplyScalar(-len * 0.5);
      m.streak.material.opacity = fade * 0.55;
    }
  }

  // ---------------- 太阳系 ----------------
  const planets = [];
  const systemGroup = new THREE.Group();
  const SUN_OFF = -78;
  const SUN_ANG = Math.PI;

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

    systemGroup.position.set(0, 58, -285);
    systemGroup.rotation.x = 1.02;
    systemGroup.rotation.z = -0.14;
    scene.add(systemGroup);

    const sunGroup = new THREE.Group();
    sunGroup.position.set(SUN_OFF, 0, 0);
    systemGroup.add(sunGroup);

    const haloOuter = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xff6a1e, transparent: true, opacity: 0.06,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    haloOuter.scale.setScalar(470);
    sunGroup.add(haloOuter);

    const haloMid = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xffa949, transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    haloMid.scale.setScalar(196);
    sunGroup.add(haloMid);

    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(12, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xffab4a })
    );
    sunGroup.add(sunCore);

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
  const _dir = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _look = new THREE.Vector3();

  function updateCamera(dt) {
    if (flight) {
      flight.t += dt;
      const k = Math.min(1, flight.t / flight.dur);
      const e = flight.ease(k);
      orbit.radius = flight.r0 + (flight.r1 - flight.r0) * e;
      orbit.target.lerpVectors(flight.p0, flight.p1, e);
      if (k >= 1) flight = null;
    }

    const k = 1 - Math.pow(0.0006, dt);
    orbit.theta += (orbit.tTheta - orbit.theta) * k;
    orbit.phi += (orbit.tPhi - orbit.phi) * k;

    panelShift = toward(panelShift, panelShiftT, dt, 5.5);

    const sp = Math.sin(orbit.phi);
    _dir.set(sp * Math.sin(orbit.theta), Math.cos(orbit.phi), sp * Math.cos(orbit.theta));

    camera.position.copy(orbit.target).addScaledVector(_dir, orbit.radius);

    // 鼠标视差：轻微偏移，营造纵深
    _right.set(_dir.z, 0, -_dir.x).normalize();
    camera.position.addScaledVector(_right, pointer.x * orbit.radius * 0.035);
    camera.position.y += pointer.y * orbit.radius * 0.022;

    _look.copy(orbit.target)
      .addScaledVector(_right, panelShift * orbit.radius * 0.42 + orbit.baseShift);
    camera.lookAt(_look);
  }

  // ---------------- 交互 ----------------
  function initInteraction() {
    const el = renderer.domElement;
    let down = false, moved = 0, lx = 0, ly = 0;

    el.addEventListener('pointerdown', function (e) {
      down = true; moved = 0; lx = e.clientX; ly = e.clientY;
      flight = null;
    });

    el.addEventListener('pointerup', function (e) {
      if (down && moved < 6) pick(e.clientX, e.clientY);
      down = false;
    });

    el.addEventListener('pointermove', function (e) {
      pointer.x = (e.clientX / innerWidth) * 2 - 1;
      pointer.y = -(e.clientY / innerHeight) * 2 + 1;
      pointerPx.x = e.clientX; pointerPx.y = e.clientY; pointerPx.moved = true;

      if (!down) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      lx = e.clientX; ly = e.clientY;
      orbit.tTheta -= dx * 0.005;
      orbit.tPhi = Math.max(0.16, Math.min(3.0, orbit.tPhi - dy * 0.005));
    });

    el.addEventListener('pointerleave', function () {
      pointer.x = 0; pointer.y = 0;
      setHover(null);
    });

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      flight = null;
      orbit.radius = Math.max(18, Math.min(900, orbit.radius * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });

    addEventListener('resize', function () {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
      resizePost();
    });

    addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!sessions.length) return;
        let i = selected ? sessions.indexOf(selected) : -1;
        i += (e.key === 'ArrowRight' ? 1 : -1);
        i = (i + sessions.length) % sessions.length;
        selectSession(sessions[i], null);
      }
    });

    const menuBtn = document.getElementById('menu');
    const side = document.getElementById('side');
    if (menuBtn) {
      menuBtn.onclick = function () {
        side.classList.toggle('open');
        menuBtn.classList.toggle('on');
      };
    }
  }

  function ndc(cx, cy) {
    return new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  }

  function pick(cx, cy) {
    raycaster.setFromCamera(ndc(cx, cy), camera);

    const pts = raycaster.intersectObjects(messagePoints, false);
    if (pts.length && pts[0].index != null) {
      const s = byId(pts[0].object.userData.id);
      if (s) { selectSession(s, pts[0].index); return; }
    }
    const hits = raycaster.intersectObjects(hitSpheres, false);
    if (hits.length) {
      const s = byId(hits[0].object.userData.id);
      if (s) selectSession(s, null);
    }
  }

  function byId(id) {
    for (let i = 0; i < sessions.length; i++) if (sessions[i].id === id) return sessions[i];
    return null;
  }

  let hoverTick = 0;
  function updateHover() {
    if (!pointerPx.moved) return;
    if (++hoverTick % 2) return;
    pointerPx.moved = false;

    raycaster.setFromCamera(ndc(pointerPx.x, pointerPx.y), camera);
    const hits = raycaster.intersectObjects(hitSpheres, false);
    const s = hits.length ? byId(hits[0].object.userData.id) : null;
    setHover(s);
  }

  function setHover(s) {
    if (s === hovered) return;
    hovered = s;
    renderer.domElement.style.cursor = s ? 'pointer' : 'grab';
    if (s) showLinks(s);
    else linkObj.visible = false;
  }

  function closePanel() {
    document.getElementById('panel').classList.remove('open');
    selected = null;
    panelShiftT = 0;
    refreshOpacity();
    document.querySelectorAll('.item').forEach(function (el) { el.classList.remove('on'); });
    let far = 0;
    sessions.forEach(function (s) { far = Math.max(far, s.pos.length()); });
    flightTo(new THREE.Vector3(-26, 0, 0), Math.max(140, far * 2.1), 1.0, easeInOutCubic);
  }

  function selectSession(s, msgIndex) {
    if (!s) return;
    selected = s;
    document.getElementById('panel').classList.add('open');
    document.getElementById('p-proj').textContent = s.project || '';
    document.getElementById('p-title').textContent = s.title;
    document.getElementById('p-meta').textContent =
      s.msgCount + ' 条消息 · ' +
      (s.toolCount || 0) + ' 次工具调用 · ' +
      fmt(s.createdAt) + ' → ' + fmt(s.lastAt);

    renderMessages(s);

    // 缓动飞过去
    const r = RING_R0 + s.msgCount * RING_DR;
    flightTo(s.pos, Math.max(30, r * 2.6), 1.15, easeInOutCubic);
    panelShiftT = 1;

    refreshOpacity();

    document.querySelectorAll('.item').forEach(function (el) {
      el.classList.toggle('on', el.dataset.id === s.id);
    });

    if (msgIndex != null) {
      const box = document.getElementById('msgs');
      const target = box.querySelector('[data-i="' + msgIndex + '"]');
      if (target) {
        target.classList.add('hl');
        setTimeout(function () {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 60);
      }
    }
  }

  // 根据「选中 + 搜索」统一算透明度目标，淡入淡出全部交给逐帧逼近
  let searchKey = '';
  function refreshOpacity() {
    sessions.forEach(function (s) {
      const on = s === selected;
      const hit = !searchKey ||
        s.title.toLowerCase().indexOf(searchKey) >= 0 ||
        s.messages.some(function (m) { return m.text.toLowerCase().indexOf(searchKey) >= 0; });

      if (!hit) {
        s.op.glow = 0.10; s.op.points = 0.07; s.op.label = 0.14; s.op.ring = 0.04;
        return;
      }
      s.op.glow = on ? 1.0 : 0.85;
      s.op.points = on ? 1.0 : 0.95;
      s.op.label = on ? 1.0 : (selected ? 0.6 : 0.92);
      s.op.ring = on ? 0.34 : 0.16;
    });
  }

  function renderMessages(s) {
    const box = document.getElementById('msgs');
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    s.messages.forEach(function (m, i) {
      const d = document.createElement('div');
      d.className = 'msg ' + (m.role === 'user' ? 'u' : 'a');
      d.dataset.i = i;
      d.style.setProperty('--d', Math.min(420, i * 16) + 'ms');

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
      searchKey = q.value.trim().toLowerCase();
      refreshOpacity();

      sessions.forEach(function (s) {
        const hit = !searchKey ||
          s.title.toLowerCase().indexOf(searchKey) >= 0 ||
          s.messages.some(function (m) { return m.text.toLowerCase().indexOf(searchKey) >= 0; });
        const el = document.querySelector('.item[data-id="' + s.id + '"]');
        if (el) el.style.opacity = hit ? 1 : 0.26;
      });
    });
  }

  // ---------------- 每帧更新 ----------------
  function updateStars(dt) {
    sessions.forEach(function (s, i) {
      const o = s.op;

      s.obj.glow.material.opacity = toward(s.obj.glow.material.opacity, o.glow, dt, 7);
      s.obj.points.material.opacity = toward(s.obj.points.material.opacity, o.points, dt, 7);
      s.obj.label.material.opacity = toward(s.obj.label.material.opacity, o.label, dt, 7);
      s.obj.ring.material.opacity = toward(s.obj.ring.material.opacity, o.ring, dt, 7);

      s.obj.group.rotation.y += dt * (0.045 + i * 0.004);

      const hover = hovered === s ? 1.45 : 1;
      const pulse = 1 + Math.sin(clock * 0.0016 + i * 1.3) * 0.045;
      s.obj.scale = toward(s.obj.scale, s.obj.baseGlow * hover * pulse, dt, 6);
      s.obj.glow.scale.setScalar(s.obj.scale);
      s.obj.glow.material.rotation += dt * 0.1;

      const d = camera.position.distanceTo(s.obj.group.position);
      const sc = Math.max(2.0, Math.min(16, d * 0.032));
      s.obj.label.scale.set(sc * s.obj.aspect, sc, 1);
      // 屏幕像素 -> 世界单位，用来把打架的标签往上顶
      const worldPerPx = (2 * d * Math.tan(camera.fov * Math.PI / 360)) / innerHeight;
      s.obj.liftCur = toward(s.obj.liftCur || 0, s.obj.liftT || 0, dt, 9);
      s.obj.label.position.y = sc * 1.25 + s.obj.liftCur * worldPerPx;
    });

    if (linkObj && linkObj.visible) {
      linkOpacity = toward(linkMat.opacity, hovered ? 0.30 : 0, dt, 8);
      linkMat.opacity = linkOpacity;
      if (linkOpacity < 0.01 && !hovered) linkObj.visible = false;
    }
  }

  // 标签防重叠：屏幕空间里简单堆叠，被压住的往上挪
  const _pv = new THREE.Vector3();
  const _scr = [];
  let declutterTick = 0;

  function declutterLabels() {
    _scr.length = 0;
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      _pv.copy(s.obj.group.position).project(camera);
      if (_pv.z > 1) continue;
      _scr.push({
        x: (_pv.x * 0.5 + 0.5) * innerWidth,
        y: (-_pv.y * 0.5 + 0.5) * innerHeight,
        s: s
      });
    }
    _scr.sort(function (a, b) { return a.y - b.y; });
    const placed = [];
    for (let i = 0; i < _scr.length; i++) {
      const p = _scr[i];
      const w = Math.max(64, p.s.obj.aspect * 26);
      let lift = 0, guard = 0;
      while (guard++ < 10) {
        let hit = false;
        for (let j = 0; j < placed.length; j++) {
          const q = placed[j];
          // 用 q 抬升后的实际位置比较，否则多级抬升会互相压住
          if (Math.abs(p.x - q.x) < (w + q.w) * 0.5 &&
              Math.abs((p.y - lift) - (q.y - q.lift)) < 32) { hit = true; break; }
        }
        if (!hit) break;
        lift += 30;
      }
      p.w = w;
      p.lift = lift;
      placed.push(p);
      p.s.obj.liftT = lift;
    }
  }

  function step(dt) {
    clock += dt * 1000;
    updateCamera(dt);
    updateHover();
    if (++declutterTick % 8 === 1) declutterLabels();
    updateStars(dt);
    updateMeteors(dt);
    updateSolarSystem(dt);

    if (starfield) starfield.rotation.y += dt * 0.004;
    for (let i = 0; i < nebulas.length; i++) {
      nebulas[i].material.opacity = 0.26 + Math.sin(clock * 0.0004 + i * 2) * 0.05;
    }
  }

  // ---------------- 渲染循环 ----------------
  let last = 0;
  let slow = 0;

  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;

    step(dt);

    // 性能兜底：连续卡顿就关掉泛光
    if (post.on) {
      slow = dt > 0.042 ? slow + 1 : Math.max(0, slow - 2);
      if (slow > 90) {
        disposePost();
        slow = 0;
      }
    }

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
      document.title = 'bloom=' + (post.on ? 1 : 0) + ' hover=' + (hovered ? hovered.title : '-') +
        ' fly=' + fly + ' inView=' + vis;
    }

    renderFrame();
  }

  // ---------------- 开场 ----------------
  function bootDone(ctx) {
    const b = document.getElementById('boot');
    document.body.classList.add('ready');

    if (!USE_BOOT || WARM > 0) {
      if (b) b.remove();
      startIntro(false);
      return;
    }
    // 等场景第一帧出来，再放跃迁
    setTimeout(function () {
      if (b) { b.classList.add('done'); setTimeout(function () { b.remove(); }, 1000); }
      startIntro(true);
    }, 240 + Math.floor(ctx || 0));
  }

  // 开局机位：旋臂按星团规模收放，再按「近侧外沿」反算距离，
  // 数据是 5 个簇还是 30 个簇都能自己找到合适的远近，不会被侧栏挡住或一半挤出画面。
  function frameAll() {
    const n = sessions.length || 1;
    const c = new THREE.Vector3();
    let far = 0;
    sessions.forEach(function (s) {
      c.add(s.pos);
      far = Math.max(far, s.pos.length());
    });
    c.divideScalar(n);
    far = Math.max(far, 40);

    // 旋臂贴着星团走：星团小的时候别把星系拉成一大团灰雾，反过来也别缩得比星团还小
    const gScale = Math.max(0.42, Math.min(1.15, far * 1.45 / GALAXY_R));
    if (galaxyPts) galaxyPts.scale.setScalar(gScale);
    const Rg = GALAXY_R * gScale;          // 旋臂外径（缩放后）

    const W = innerWidth, H = innerHeight;
    const sideEl = document.getElementById('side');
    let sideW = 0;
    if (W > 820 && sideEl) {
      const r = sideEl.getBoundingClientRect();
      if (r.width > 0) sideW = r.width + 34;
    }
    const freeW = Math.max(220, W - sideW);

    const vfov = camera.fov * Math.PI / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * freeW / H);
    const tanH = Math.tan(hfov / 2), tanV = Math.tan(vfov / 2);
    // 透视修正：近侧外沿离相机约 d-0.28Rg（实测放大系数），先给个解析初值
    const NEAR = 0.28 * Rg;
    const dW = Rg / (0.90 * tanH) + NEAR;
    const dH = (Rg * Math.cos(orbit.tPhi)) / (0.86 * tanV) + NEAR;
    let d = Math.max(dW, dH, far * 2.2);

    // 再做几轮数值拟合：投影到屏幕量真实包围盒，按比例调距离、按偏差挪视线。
    // 强透视下解析解总会偏心，量像素才靠谱。
    const freeCX = sideW + freeW / 2, freeCY = H / 2 + 18;   // 目标：侧栏右边那块空白的正中，略偏下
    const allowW = freeW * 0.94, allowH = H * 0.92;
    const _v = new THREE.Vector3();
    const _rt = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const _rim = [];
    for (let a = 0; a < 24; a++) {
      const th = a / 24 * Math.PI * 2;
      _rim.push(new THREE.Vector3(Math.cos(th) * Rg, 0, Math.sin(th) * Rg));
      _rim.push(new THREE.Vector3(Math.cos(th) * Rg * 0.5, 0, Math.sin(th) * Rg * 0.5));
    }
    const _box = { x0: 0, y0: 0, x1: 0, y1: 0 };
    function measure() {
      _box.x0 = _box.y0 = 1e9; _box.x1 = _box.y1 = -1e9;
      camera.updateMatrixWorld(true);
      for (let i = 0; i < _rim.length + sessions.length; i++) {
        if (i < _rim.length) _v.copy(_rim[i]).add(c);
        else _v.copy(sessions[i - _rim.length].pos);
        _v.project(camera);
        const sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H;
        if (sx < _box.x0) _box.x0 = sx; if (sx > _box.x1) _box.x1 = sx;
        if (sy < _box.y0) _box.y0 = sy; if (sy > _box.y1) _box.y1 = sy;
      }
    }

    orbit.target.copy(c);
    const trace = [];
    let used = Math.max(100, Math.min(1400, d));
    for (let it = 0; it < 6; it++) {
      used = Math.max(100, Math.min(1400, d));
      orbit.radius = used;
      // 侧栏让位（像素量为准，跟着距离缩放）也放进拟合里，否则量出来的框和最终画面对不上
      orbit.baseShift = -sideW / 2 * (2 * tanV / H) * used;
      updateCamera(0);
      measure();
      // 标签浮在星星上方，纵向多留 34px
      const bw = _box.x1 - _box.x0, bh = _box.y1 - _box.y0 + 34;
      const k = Math.max(bw / allowW, bh / allowH);
      const cx = (_box.x0 + _box.x1) / 2, cy = (_box.y0 + _box.y1) / 2 + 17;
      trace.push([Math.round(used), +k.toFixed(3), Math.round(bw), Math.round(bh), Math.round(cx), Math.round(cy)]);
      const wpp = 2 * used * tanV / H;
      _rt.setFromMatrixColumn(camera.matrixWorld, 0);
      _up.setFromMatrixColumn(camera.matrixWorld, 1);
      // 水平：视线右移 → 画面内容左移；垂直：视线下移 → 画面内容上移
      orbit.target.addScaledVector(_rt, (cx - freeCX) * wpp);
      orbit.target.addScaledVector(_up, -(cy - freeCY) * wpp);
      if (Math.abs(k - 1) < 0.015) break;
      d *= k;
    }
    orbit.radius = used;
    orbit.baseShift = -sideW / 2 * (2 * tanV / H) * orbit.radius;
    updateCamera(0);

    // 太阳系：推到星盘后面很远的地方，只剩一层暖色底光，不参与构图
    if (systemGroup && systemGroup.parent) {
      systemGroup.scale.setScalar(0.32 * Math.max(0.8, gScale));
      systemGroup.position.set(c.x - Rg * 0.55, c.y + Rg * 0.10, c.z - Rg * 3.0);
    }

    if (QS.has('probe')) {
      let far2 = far;
      camera.updateMatrixWorld(true);
      updateCamera(0);
      camera.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      function acc(p) {
        v.copy(p).project(camera);
        const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      }
      sessions.forEach(function (s) { acc(s.pos); });
      const nodes = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
      x0 = y0 = 1e9; x1 = y1 = -1e9;
      for (let a = 0; a < 16; a++) {
        const th = a / 16 * Math.PI * 2;
        acc(new THREE.Vector3(Math.cos(th) * Rg, 0, Math.sin(th) * Rg));
      }
      const arms = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
      _v.copy(systemGroup.position).project(camera);
      const sunPx = [Math.round((_v.x * 0.5 + 0.5) * innerWidth), Math.round((-_v.y * 0.5 + 0.5) * innerHeight)];
      document.title = 'PROBE ' + JSON.stringify({
        n: n, Rg: Math.round(Rg), gScale: +gScale.toFixed(2), d: Math.round(orbit.radius),
        farNode: Math.round(far), nodesPx: nodes, armsPx: arms, W: innerWidth, H: innerHeight,
        baseShift: Math.round(orbit.baseShift), phi: +orbit.phi.toFixed(2),
        sunPx: sunPx, freeCX: Math.round(freeCX), trace: trace
      });
    }
  }

  function startIntro(animate) {
    if (!animate) return;
    const target = orbit.radius;
    orbit.radius = target * 2.4;
    flightTo(orbit.target.clone(), target, 1.9, easeOutQuint);
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

      document.getElementById('close').onclick = closePanel;

      // 开局：先定视角，再自动取景
      orbit.tTheta = 0.9;
      orbit.tPhi = 0.95;
      orbit.theta = 0.9;
      orbit.phi = 0.95;
      frameAll();

      const fi = QS.get('focus');
      const focusS = fi !== null ? sessions[+fi] : null;

      if (WARM > 0) {
        const steps = Math.min(3600, Math.round(WARM * 60));
        for (let k = 0; k < steps; k++) step(1 / 60);
      }

      last = performance.now();
      tick();
      bootDone(0);

      if (focusS) {
        // 等跃迁结束再飞过去
        setTimeout(function () { selectSession(focusS, null); }, WARM > 0 ? 0 : 900);
      }
    })
    .catch(function (e) {
      const b = document.getElementById('boot');
      if (b) b.remove();
      document.body.innerHTML =
        '<pre style="color:#f88;padding:40px;font-size:13px">' + (e && e.stack || e) + '</pre>';
    });

})();