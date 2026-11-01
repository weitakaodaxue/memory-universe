/* =========================================================
   记忆宇宙 · Memory Universe
   把每次对话渲染成一颗恒星，每条消息是恒星周围的一粒尘埃。
   ---------------------------------------------------------
   ?bloom=0   关闭后期泛光        ?swirl=0   关闭星系漩涡
   ?boot=0    跳过开场动画        ?warm=4    动画预演 4 秒
   ?focus=3   开局聚焦第 4 个会话  ?debug=1   调试信息写进标题
   ?flow=0.8  背景流动星云强度（0 = 关闭，默认 1.0）
   ?sun=0     关闭背景八大行星（默认开启）
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
  let dustPts = null;          // 弥漫星尘
  let frameDist = 0;           // 取景后的相机距离，LOD 用
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
  // 背景流动星云强度；?flow=0 关掉，?flow=1.6 加强
  const FLOW = QS.has('flow') ? Math.max(0, parseFloat(QS.get('flow')) || 0) : 1.0;
  const _flowDir = new THREE.Vector3();

  // ---------------- 全局状态 ----------------
  let scene, camera, renderer, raycaster;
  const pointer = new THREE.Vector2(0, 0);      // -1..1，用于视差
  const pointerPx = { x: -1e4, y: -1e4, moved: true };
  let sessions = [];
  let selected = null;
  let hovered = null;
  let hoverLock = null;   // 非空时强制保持悬停（截图/自检）
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
    // 字号比原来大、留白比原来小：同一个胶囊高度里字更大；
    // 文字不再用彩色 shadowBlur（那是糊的主因），改成深色描边压背景
    const fs = 56, pad = 22;
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
    g.fillStyle = 'rgba(4,9,18,.82)';
    g.fill();
    g.strokeStyle = color;
    g.globalAlpha = 0.6;
    g.lineWidth = 2;
    g.stroke();
    g.globalAlpha = 1;

    g.font = '600 ' + fs + 'px "Microsoft YaHei",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(2,5,11,.95)';
    g.lineWidth = 7;
    g.strokeText(text, w / 2, c.height / 2 + 1);
    g.fillStyle = '#f6fbff';
    g.fillText(text, w / 2, c.height / 2 + 1);

    const tex = new THREE.CanvasTexture(c);
    // 纹理比屏幕上显示的像素大好几倍，必须开 mipmap + 各向异性，否则缩小时必然发糊
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (renderer && renderer.capabilities) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
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
  // 力导向是 O(n²)×迭代数：n=1000 时是 2 亿次运算，浏览器会直接冻住十几秒。
  // 超过 LAYOUT_MAX 就换成 O(n) 的确定性布点（按项目分扇区 + 时间螺旋）。
  const LAYOUT_MAX = 260;

  function fastLayout(list, times, tMin, span) {
    const R = 95;
    const sector = {};
    let sectors = 0;
    list.forEach(function (s, i) {
      const key = s.project || s.title || '';
      if (!(key in sector)) {
        sector[key] = (sectors * 137.508) % 360;   // 黄金角，扇区分布均匀
        sectors++;
      }
      const t = list.length > 1 ? i / (list.length - 1) : 0.5;
      const a = sector[key] * Math.PI / 180 + t * 1.9;
      const r = R * (0.30 + 0.70 * Math.sqrt(t));
      s.pos = new THREE.Vector3(
        Math.cos(a) * r + (rnd() - 0.5) * 5,
        ((times[i] - tMin) / span - 0.5) * 58,
        Math.sin(a) * r + (rnd() - 0.5) * 5
      );
    });
  }

  function layout(list) {
    const n = list.length;
    const times = list.map(function (s) { return s.createdAt || 0; });
    const tMin = Math.min.apply(null, times), tMax = Math.max.apply(null, times);
    const span = Math.max(1, tMax - tMin);

    // 导出时带了 --embed：直接用语义坐标（已在 [-1,1] 内），比二元组 TF-IDF 更贴题；
    // 时间只作为一点纵向偏移，不压过语义。
    const embedded = list.filter(function (s) {
      return Array.isArray(s.embed) && s.embed.length === 3;
    }).length;
    if (embedded >= Math.max(3, n * 0.8)) {
      const R0 = 95;
      list.forEach(function (s) {
        const e = Array.isArray(s.embed) && s.embed.length === 3 ? s.embed : [0, 0, 0];
        s.pos = new THREE.Vector3(e[0] * R0, e[1] * 12, e[2] * R0);
      });
      return;
    }

    if (n > LAYOUT_MAX) {
      fastLayout(list, times, tMin, span);
      return;
    }

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
        threshold: { value: 0.75 }
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
        strength: { value: 0.42 },
        vig: { value: 0.34 },
        uTime: { value: 0 },
        grain: { value: 0.030 },
        uFlow: { value: FLOW },
        uCam: { value: new THREE.Vector2(0, 0) }   // 视角方向 xy，用于背景视差
      },
      vertexShader: VERT,
      fragmentShader: [
        'uniform sampler2D tScene; uniform sampler2D tBloom;',
        'uniform float strength; uniform float vig; uniform float uTime; uniform float grain;',
        'uniform float uFlow; uniform vec2 uCam;',
        'varying vec2 vUv;',
        'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        // 值噪声 + 3 阶 fbm：给背景星云用，比纹理便宜、不用额外 RT
        'float n21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
        'float vnoise(vec2 p){',
        '  vec2 i = floor(p), f = fract(p);',
        '  f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(n21(i), n21(i + vec2(1.0, 0.0)), f.x),',
        '             mix(n21(i + vec2(0.0, 1.0)), n21(i + vec2(1.0, 1.0)), f.x), f.y);',
        '}',
        'float fbm(vec2 p){',
        '  float s = 0.0, a = 0.5;',
        '  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.07 + 11.3; a *= 0.5; }',
        '  return s;',
        '}',
        'void main(){',
        '  vec3 col = texture2D(tScene, vUv).rgb;',
        '  vec3 bloom = texture2D(tBloom, vUv).rgb;',
        '  col += bloom * strength;',
        // 流动星云：双层域扭曲，极慢漂移 + 轻微视差；在 ACES 之前叠加，
        // 这样会被压进高光范围，不会在暗角里糊成一片死紫。
        '  if (uFlow > 0.001) {',
        '    vec2 fp = vUv * vec2(2.2, 3.0) + uCam;',
        '    vec2 warp = vec2(fbm(fp + vec2(uTime * 0.020, uTime * 0.006)),',
        '                     fbm(fp + vec2(4.7, -uTime * 0.014)));',
        '    float cloud = fbm(fp * 1.5 + warp * 1.1 + vec2(-uTime * 0.030, uTime * 0.011));',
        '    float band = smoothstep(0.30, 0.92, cloud);',
        '    float lift = smoothstep(0.15, 0.95, cloud * 0.7 + warp.x * 0.3);',
        '    vec3 flow = mix(vec3(0.010, 0.006, 0.030), vec3(0.105, 0.048, 0.245), band);',
        '    flow = mix(flow, vec3(0.170, 0.045, 0.210), smoothstep(0.55, 0.90, warp.y) * 0.40);',
        '    flow *= (0.85 + 0.15 * vUv.y) * (0.45 + 0.75 * lift);',
        '    col += flow * uFlow;',
        '  }',
        '  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);', // ACES 近似
        '  col = pow(max(col, 0.0), vec3(0.4545));',      // 线性→sRGB，缺这步整屏会偏暗偏灰
        // 胶片颗粒：在最终色彩空间里加一点点亮度噪声，去掉 3D 引擎的塑料感
        '  float g = hash(gl_FragCoord.xy + fract(uTime * 0.7) * 91.7) - 0.5;',
        '  col += g * grain * (0.35 + 0.65 * (1.0 - dot(col, vec3(0.333))));',
        '  float d = length(vUv - 0.5);',
        '  col *= mix(1.0, 1.0 - vig, smoothstep(0.30, 0.86, d));',
        '  gl_FragColor = vec4(max(col, 0.0), 1.0);',
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
    // 参考模板没有雾；雾会把远处星尘压暗、整片发灰，这里去掉

    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 4000);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x050209, 1);
    document.body.appendChild(renderer.domElement);

    raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 1.8;

    addStarfield();
    addGalaxy();
    addNebula();
    initShockwave();
    // 流星条容易糊成硬边白块，仍默认关闭；八大行星挂在相机背板上，不参与星图取景，默认开启
    if (QS.get('meteor') === '1') addMeteors();
    if (flag('sun', true)) addSolarSystem();
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

  // 粒子柔光 shader：很慢的呼吸（不是闪烁）+ 近大远小，移植自参考模板
  const P_VERT = [
    'attribute float aSize; attribute float aPhase; attribute vec3 aColor;',
    'uniform float uTime; uniform float uPix;',
    'varying vec3 vColor; varying float vTw;',
    'void main(){',
    '  vColor=aColor;',
    '  float br=0.9+0.1*sin(uTime*0.28+aPhase);',
    '  vTw=br;',
    '  vec4 mv=modelViewMatrix*vec4(position,1.0);',
    '  gl_PointSize=aSize*uPix*br*(1.0/-mv.z);',
    '  gl_Position=projectionMatrix*mv;',
    '}'
  ].join('\n');
  const P_FRAG = [
    'varying vec3 vColor; varying float vTw;',
    'void main(){',
    '  float d=length(gl_PointCoord-0.5);',
    '  float a=1.0-smoothstep(0.0,0.5,d);',   // 反向 smoothstep 是 UB（edge0>=edge1），改成等价形式
    '  a=pow(a,1.6)*vTw;',
    '  if(a<0.01) discard;',
    '  gl_FragColor=vec4(vColor,a);',
    '}'
  ].join('\n');
  // 世界尺度比模板大一个量级，点必须画得比「等比」更大，
  // 否则每个点只有 1px、叠不出连续光带，整片会退化成噪点
  const PSIZE_K = 90;

  function particleMat(sizeScale) {
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPix: { value: renderer.getPixelRatio() * sizeScale } },
      vertexShader: P_VERT, fragmentShader: P_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    m.userData.baseUxPix = m.uniforms.uPix.value;   // 取景缩放时同步缩点径
    return m;
  }

  // 星系盘：核心偏粉、中段紫、外圈蓝，稀疏金色点缀；散射大一点让双臂糊成一条带
  function addGalaxy() {
    const N = 14000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const sz = new Float32Array(N);
    const phs = new Float32Array(N);
    const cIn = new THREE.Color(0xffdcf2);
    const cMid = new THREE.Color(0xc891ff);
    const cOut = new THREE.Color(0x8fb0ff);
    const gold = new THREE.Color(0xffcf9a);
    const scat = 0.42;

    for (let i = 0; i < N; i++) {
      const r = Math.pow(rnd(), 1.7) * GALAXY_R;
      const branch = (i % 2) / 2 * Math.PI * 2;
      const spin = (r / GALAXY_R) * 5.75;
      const sx = Math.pow(rnd(), 2.6) * (rnd() < 0.5 ? 1 : -1) * scat * (r + GALAXY_R * 0.08);
      const sz2 = Math.pow(rnd(), 2.6) * (rnd() < 0.5 ? 1 : -1) * scat * (r + GALAXY_R * 0.08);
      const sy = Math.pow(rnd(), 3.0) * (rnd() < 0.5 ? 1 : -1) * scat * 0.34 * (r + GALAXY_R * 0.06);

      pos[i * 3] = Math.cos(branch + spin) * r + sx;
      pos[i * 3 + 1] = sy;
      pos[i * 3 + 2] = Math.sin(branch + spin) * r + sz2;

      const tN = r / GALAXY_R;
      let cr, cg, cb;
      if (tN < 0.5) {
        const k = tN / 0.5;
        cr = cIn.r + (cMid.r - cIn.r) * k; cg = cIn.g + (cMid.g - cIn.g) * k; cb = cIn.b + (cMid.b - cIn.b) * k;
      } else {
        const k = (tN - 0.5) / 0.5;
        cr = cMid.r + (cOut.r - cMid.r) * k; cg = cMid.g + (cOut.g - cMid.g) * k; cb = cMid.b + (cOut.b - cMid.b) * k;
      }
      if (rnd() < 0.06) { cr = gold.r; cg = gold.g; cb = gold.b; }
      col[i * 3] = cr; col[i * 3 + 1] = cg; col[i * 3 + 2] = cb;
      sz[i] = (1.4 + rnd() * 3.6) * PSIZE_K;
      phs[i] = rnd() * 6.28;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phs, 1));
    const pts = new THREE.Points(g, particleMat(1.3));
    pts.frustumCulled = false;
    scene.add(pts);
    galaxyPts = pts;
  }

  // 弥漫星尘：铺满空间，主要作用是景深
  function addNebula() {
    const N = 6400;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const sz = new Float32Array(N);
    const phs = new Float32Array(N);
    const cols = [0xe8b8ff, 0x9fb8ff, 0xffd0ec, 0xc8a0f0, 0xffe0b0].map(function (h) {
      return new THREE.Color(h);
    });

    for (let i = 0; i < N; i++) {
      const r = Math.pow(rnd(), 1.1) * GALAXY_R * 1.7 + GALAXY_R * 0.1;
      const th = rnd() * Math.PI * 2;
      const y = (rnd() - 0.5) * GALAXY_R * 1.1;
      pos[i * 3] = Math.cos(th) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(th) * r;
      const c = cols[Math.floor(rnd() * cols.length)];
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      sz[i] = (0.5 + rnd() * 1.3) * PSIZE_K;
      phs[i] = rnd() * 6.28;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phs, 1));
    const m = particleMat(1);
    m.uniforms.uPix.value *= 0.9;
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    scene.add(pts);
    dustPts = pts;
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
        new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.38) })
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

      // 超巨星（消息多）多一层缓慢自转的日冕碎片环
      let corona = null;
      if (s.msgCount >= 40 && sessions.length <= 400) {
        corona = new THREE.Mesh(
          new THREE.RingGeometry(2.1, 2.55, 72),
          new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.30, side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending, depthWrite: false
          })
        );
        corona.rotation.x = -Math.PI / 2 + 0.18;
        group.add(corona);
      }

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
        label: ls, ring: ring, corona: corona, color: color, aspect: lab.aspect,
        baseGlow: gs, scale: 1, liftCur: 0, liftT: 0
      };
      // 透明度目标值，逐帧逼近 = 所有淡入淡出都平滑
      s.op = { glow: 0.85, points: 0.95, label: 0.92, ring: 0.16 };
    });

    buildLinks();
    computeNeighbors();
  }

  // ---------------- 悬停连线 ----------------
  // 每根连线画一条朝相机的带状面片（不是 1px 线）：
  // 宽度按屏幕像素算，两端收细、中段最宽，横截面用高斯核当发光核心。
  // 关键：depthTest 关掉 —— 星系尘埃会写深度，开着的话整条光纤被挡掉大半。
  let linkObj = null, linkMat = null, linkGeo = null;
  let linkOpacity = 0;
  let linkPick = [];        // 本次实际连到的邻居（自检/调试用）

  const LINK_RIBBON = 7;            // 沿线横截面数
  const LINK_SEG = LINK_RIBBON - 1;
  const LINK_MAX = 3;
  const LINK_VPL = LINK_RIBBON * 2; // 单条链路的顶点数

  function buildLinks() {
    const total = LINK_MAX * LINK_VPL;
    const pos = new Float32Array(total * 3);
    const prg = new Float32Array(total);
    const sid = new Float32Array(total);
    const idx = [];
    for (let l = 0; l < LINK_MAX; l++) {
      const base = l * LINK_VPL;
      for (let i = 0; i < LINK_SEG; i++) {
        const v = base + i * 2;
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    for (let l = 0; l < LINK_MAX; l++) {
      for (let i = 0; i < LINK_RIBBON; i++) {
        const k = l * LINK_VPL + i * 2;
        prg[k] = prg[k + 1] = i / LINK_SEG;
        sid[k] = -1; sid[k + 1] = 1;
      }
    }
    linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    linkGeo.setAttribute('aProg', new THREE.BufferAttribute(prg, 1));
    linkGeo.setAttribute('aSide', new THREE.BufferAttribute(sid, 1));
    linkGeo.setIndex(idx);
    // 流光光纤：沿线跑的能量包由 aProg + uTime 算，不用贴图
    linkMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(0x9fe2ff) }
      },
      vertexShader: [
        'attribute float aProg;',
        'attribute float aSide;',
        'varying float vProg;',
        'varying float vSide;',
        'void main(){',
        '  vProg = aProg; vSide = aSide;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uTime; uniform float uOpacity;',
        'varying float vProg; varying float vSide;',
        'void main(){',
        '  float core = exp(-abs(vSide) * abs(vSide) * 4.5);',          // 横向高斯核
        '  float fl = 0.5 + 0.5 * sin(vProg * 6.0 - uTime * 3.2);',     // 沿线流动
        '  float flow = 0.40 + 1.0 * fl * fl;',
        '  float ends = min(1.0, min(vProg, 1.0 - vProg) * 10.0);',     // 两端淡出
        '  float a = clamp(core * flow * ends * uOpacity, 0.0, 1.0);',
        '  vec3 c = mix(uColor, vec3(1.0), core * 0.6);',
        // 强度乘进颜色、alpha 给 1：加色混合只走 SrcAlpha=1 这条路，
        // 不赌驱动的 alpha 混合实现（之前整条光纤就是在这里被乘没的）
        '  gl_FragColor = vec4(c * a, 1.0);',
        '}'
      ].join('\n')
    });
    linkObj = new THREE.Mesh(linkGeo, linkMat);
    linkObj.frustumCulled = false;
    linkObj.renderOrder = 10;
    scene.add(linkObj);
    linkObj.visible = false;
  }

  function computeNeighbors() {
    // 只留最近 12 个带距离的候选，真正连哪几个在 showLinks 里按
    // 「屏幕距离够不够长」决定 —— 挨在一起的星连出来只有几十像素，
    // 全糊在双方光晕里，看着就像没有线。
    sessions.forEach(function (s) {
      const arr = [];
      for (let i = 0; i < sessions.length; i++) {
        if (sessions[i] !== s) {
          arr.push({ o: sessions[i], d2: s.pos.distanceToSquared(sessions[i].pos) });
        }
      }
      arr.sort(function (a, b) { return a.d2 - b.d2; });
      s.nearN = arr.slice(0, 12).map(function (a) {
        return { o: a.o, d: Math.sqrt(a.d2) };
      });
      s.near = s.nearN.slice(0, 3).map(function (a) { return a.o; });
    });
  }

  const _lv1 = new THREE.Vector3(), _lv2 = new THREE.Vector3(), _lv3 = new THREE.Vector3();

  function showLinks(s) {
    const arr = linkGeo.attributes.position.array;
    _lv1.setFromMatrixColumn(camera.matrixWorld, 0);   // 相机右方向
    const fovK = 2 * Math.tan(camera.fov * Math.PI / 360) / innerHeight;
    const wppS = camera.position.distanceTo(s.pos) * fovK;   // 世界单位 / 像素
    const minLen = 110 * wppS;                               // 至少 110 像素长才连
    const picks = [];
    for (let i = 0; i < s.nearN.length && picks.length < 3; i++) {
      if (s.nearN[i].d >= minLen) picks.push(s.nearN[i]);
    }
    if (picks.length === 0) {
      picks.push.apply(picks, s.nearN.slice(-3));             // 全挤在一起，就连最远的
    } else if (picks.length < 3) {
      const rest = s.nearN.filter(function (a) { return picks.indexOf(a) < 0; })
        .sort(function (a, b) { return b.d - a.d; });
      while (picks.length < 3 && rest.length) picks.push(rest.shift());
    }
    let vi = 0;
    picks.forEach(function (it) {
      const o = it.o;
      _lv2.subVectors(o.pos, s.pos);
      const len = _lv2.length() || 1;
      _lv2.multiplyScalar(1 / len);
      // 两端各按自己到相机的距离换算像素宽度，推近拉远粗细都一致
      const k0 = wppS;
      const k1 = camera.position.distanceTo(o.pos) * fovK;
      for (let i = 0; i < LINK_RIBBON; i++) {
        const t = i / LINK_SEG;
        const wpp = k0 + (k1 - k0) * t;
        const half = wpp * 4.0 * (0.45 + 0.55 * Math.sin(Math.PI * t));
        _lv3.copy(s.pos).addScaledVector(_lv2, len * t);
        arr[vi * 3] = _lv3.x - _lv1.x * half;
        arr[vi * 3 + 1] = _lv3.y - _lv1.y * half;
        arr[vi * 3 + 2] = _lv3.z - _lv1.z * half;
        vi++;
        arr[vi * 3] = _lv3.x + _lv1.x * half;
        arr[vi * 3 + 1] = _lv3.y + _lv1.y * half;
        arr[vi * 3 + 2] = _lv3.z + _lv1.z * half;
        vi++;
      }
    });
    linkGeo.attributes.position.needsUpdate = true;
    linkGeo.setDrawRange(0, picks.length * LINK_SEG * 6);
    linkPick = picks;
    linkObj.visible = true;
  }


  // ---------------- 引力冲击波：点星时在 XZ 平面炸开一圈 ----------------
  const shock = { mesh: null, t0: 0, dur: 900, active: false, maxScale: 30 };

  function initShockwave() {
    const geo = new THREE.RingGeometry(0.86, 1.0, 96);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0x7fe2ff) },
        uProgress: { value: 0 }
      },
      vertexShader: [
        'varying vec2 vUv;',
        'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor; uniform float uProgress;',
        'varying vec2 vUv;',
        'void main(){',
        '  float d = length(vUv - 0.5) * 2.0;',
        '  float ring = smoothstep(0.0, 0.45, d) * (1.0 - smoothstep(0.62, 1.0, d));',  // 同上：等价曲线，不再用反向 edge
        '  float a = ring * (1.0 - uProgress) * 0.85;',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(uColor, a);',
        '}'
      ].join('\n')
    });
    shock.mesh = new THREE.Mesh(geo, mat);
    shock.mesh.rotation.x = -Math.PI / 2;
    shock.mesh.visible = false;
    scene.add(shock.mesh);
  }

  function triggerShockwave(pos) {
    if (!shock.mesh) return;
    shock.mesh.position.copy(pos);
    shock.mesh.scale.setScalar(0.6);
    shock.mesh.visible = true;
    shock.t0 = performance.now();
    shock.active = true;
  }

  function updateShockwave() {
    if (!shock.active) return;
    const p = Math.min(1, (performance.now() - shock.t0) / shock.dur);
    const e = 1 - Math.pow(1 - p, 3);          // easeOutCubic
    shock.mesh.scale.setScalar(0.6 + e * shock.maxScale);
    shock.mesh.material.uniforms.uProgress.value = e;
    if (p >= 1) { shock.active = false; shock.mesh.visible = false; }
  }

  // ---------------- 音效：纯 Web Audio 合成，零素材 ----------------
  const sfx = {
    ctx: null, on: true, drone: null, droneGain: null,
    unlock: function () {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    },
    // 悬停：清脆的谐波短音
    blip: function () {
      if (!this.on || !this.unlock()) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
      g.gain.setValueAtTime(0.022, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(g); g.connect(this.ctx.destination);
      osc.start(t); osc.stop(t + 0.1);
    },
    // 跃迁：低通下潜
    warp: function () {
      if (!this.on || !this.unlock()) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const filt = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(35, t + 0.45);
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(420, t);
      filt.frequency.exponentialRampToValueAtTime(80, t + 0.45);
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(filt); filt.connect(g); g.connect(this.ctx.destination);
      osc.start(t); osc.stop(t + 0.46);
    },
    // 环境底噪：粉红噪声循环，音量极低
    startDrone: function () {
      if (this.drone || !this.on || !this.unlock()) return;
      const ctx = this.ctx;
      const len = ctx.sampleRate * 4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;      // 简易粉红噪声
        data[i] = last * 3.2;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = 320;
      const gain = ctx.createGain();
      gain.gain.value = 0.012;                    // 很轻，只是垫底
      src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
      src.start();
      this.drone = src; this.droneGain = gain;
    },
    toggle: function () {
      this.on = !this.on;
      if (this.on) { this.startDrone(); }
      else if (this.droneGain) { this.droneGain.gain.value = 0; }
      if (this.on && this.droneGain) this.droneGain.gain.value = 0.012;
      return this.on;
    }
  };

  // ---------------- 黑客解密式文字渐入 ----------------
  function scrambleText(el, target, duration) {
    const chars = '!<>-_\\/[]{}=+*^?#0123456789ABCDEF';
    const t0 = performance.now();
    const dur = duration || 320;
    if (el._scrTimer) cancelAnimationFrame(el._scrTimer);
    function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      const cut = Math.floor(p * target.length);
      let out = target.slice(0, cut);
      for (let i = cut; i < target.length; i++) {
        out += (target[i] === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)]);
      }
      el.textContent = out;
      if (p < 1) el._scrTimer = requestAnimationFrame(frame);
      else { el.textContent = target; el._scrTimer = 0; }
    }
    el._scrTimer = requestAnimationFrame(frame);
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
  // 八大行星挂在「相机背板」上：每帧把 systemGroup 贴到相机前方 BACK 处、姿态对齐相机，
  // 所以不管星图怎么转、镜头怎么飞，行星永远停在画面下缘当背景，不吃构图、不吃标签。
  const SOLAR = {
    back: 2600,
    sun: { sx: 1.085, sy: 1.09, z: -420 },
    // 统一光向（背板局部系：+x 右、+y 上、+z 朝相机）——右下角起光
    light: new THREE.Vector3(0.54, -0.18, 0.72).normalize(),
    // sx/sy 是屏幕比例（左上角为 0），rh 是半径占「尺寸基准」的比例
    list: [
      { key: 'mercury', sx: 0.335, sy: 0.905, rh: 0.019, spin: 0.10, tilt: 0.02, atmo: 0x9a938a, atmoGain: 0.55 },
      { key: 'venus',   sx: 0.415, sy: 0.830, rh: 0.027, spin: 0.07, tilt: 0.04, atmo: 0xffc865, atmoGain: 1.05 },
      { key: 'earth',   sx: 0.505, sy: 0.895, rh: 0.031, spin: 0.22, tilt: 0.41, atmo: 0x5fb4ff, atmoGain: 1.20 },
      { key: 'mars',    sx: 0.585, sy: 0.822, rh: 0.022, spin: 0.20, tilt: 0.22, atmo: 0xff8a52, atmoGain: 0.70 },
      { key: 'uranus',  sx: 0.645, sy: 0.918, rh: 0.023, spin: 0.12, tilt: 0.05, atmo: 0x8fe6ea, atmoGain: 0.62 },
      { key: 'jupiter', sx: 0.720, sy: 0.878, rh: 0.060, spin: 0.34, tilt: 0.06, atmo: 0xf2d9a8, atmoGain: 0.85 },
      { key: 'saturn',  sx: 0.848, sy: 0.838, rh: 0.048, spin: 0.30, tilt: 0.06, atmo: 0xf4dfa6, atmoGain: 0.95 },
      { key: 'neptune', sx: 0.962, sy: 0.920, rh: 0.026, spin: 0.16, tilt: 0.10, atmo: 0x5d8cff, atmoGain: 0.88 }
    ]
  };

  let solarRoot = null;              // systemGroup 里真正摆行星的层
  let solarBuilt = false;
  const planets = [];
  const solarSunPos = new THREE.Vector3();
  const _solarFwd = new THREE.Vector3();
  const _solarSunLocal = new THREE.Vector3();
  const sunDirWorld = new THREE.Vector3();   // 所有材质共享这一个 uniform 值

  // 独立随机源：行星纹理不能扰动星图/星尘的确定性布局
  const trnd = mulberry32(0x5EED17);
  const PERM = (function () {
    const p = new Uint8Array(512);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (trnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
    return p;
  })();

  function nhash(i, j, k) {
    return PERM[(PERM[(PERM[i & 255] + (j & 255)) & 255] + (k & 255)) & 255] / 255;
  }
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const n000 = nhash(xi, yi, zi), n100 = nhash(xi + 1, yi, zi);
    const n010 = nhash(xi, yi + 1, zi), n110 = nhash(xi + 1, yi + 1, zi);
    const n001 = nhash(xi, yi, zi + 1), n101 = nhash(xi + 1, yi, zi + 1);
    const n011 = nhash(xi, yi + 1, zi + 1), n111 = nhash(xi + 1, yi + 1, zi + 1);
    const nx00 = n000 + (n100 - n000) * u, nx10 = n010 + (n110 - n010) * u;
    const nx01 = n001 + (n101 - n001) * u, nx11 = n011 + (n111 - n011) * u;
    const nxy0 = nx00 + (nx10 - nx00) * v, nxy1 = nx01 + (nx11 - nx01) * v;
    return nxy0 + (nxy1 - nxy0) * w;
  }
  function fbm(x, y, z, oct) {
    let a = 0.5, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * vnoise(x * f, y * f, z * f);
      n += a; a *= 0.5; f *= 2.03;
    }
    return s / n;
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function sstep(a, b, v) { return clamp01((v - a) / (b - a)); }
  function mix3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // 逐像素生成等距圆柱贴图；在球面方向采样 3D 噪声，因此经线接缝、两极都不会裂
  function planetTexture(kind) {
    const W = 512, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;

    for (let y = 0; y < H; y++) {
      const lat = (0.5 - (y + 0.5) / H) * Math.PI;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * Math.PI * 2;
        const px = cl * Math.cos(lon), py = sl, pz = cl * Math.sin(lon);
        let col;
        let alpha = 255;

        if (kind === 'mercury') {
          const n = fbm(px * 3.2 + 1.7, py * 3.2, pz * 3.2, 4);
          const m = fbm(px * 11.0, py * 11.0, pz * 11.0, 2);
          const maria = sstep(0.58, 0.38, fbm(px * 1.15 + 27.0, py * 1.15, pz * 1.15, 3));
          const v = 0.28 + 0.28 * n + 0.10 * m;
          col = mix3([v * 1.04, v * 0.98, v * 0.90], [0.23, 0.215, 0.20], maria * 0.7);

        } else if (kind === 'venus') {
          const swirl = fbm(px * 1.6 + 3.0, py * 6.0, pz * 1.6, 4);   // 纬向拉长的云带
          const warp = fbm(px * 1.0 + 9.0, py * 2.0, pz * 1.0, 3);
          const fine = fbm(px * 6.0 + 15.0, py * 8.0, pz * 6.0, 2);
          const band = Math.sin(lat * 9.0 + warp * 4.0 + swirl * 2.0);
          const v = 0.72 + 0.08 * band + 0.22 * (swirl - 0.5) + 0.06 * (fine - 0.5);
          col = mix3([0.68, 0.50, 0.24], [1.0, 0.94, 0.72], clamp01(v));
          col = mix3(col, [0.99, 0.95, 0.80], Math.pow(Math.abs(sl), 6) * 0.55);

        } else if (kind === 'earth') {
          const e = fbm(px * 1.85 + 5.1, py * 1.85, pz * 1.85, 5);
          const e2 = fbm(px * 5.4 + 11.0, py * 5.4, pz * 5.4, 3);
          const elev = e + 0.05 * Math.cos(lat * 3.0) + 0.04 * (e2 - 0.5);
          const ice = sstep(1.16, 1.44, Math.abs(lat));
          alpha = elev >= 0.535 ? 255 : 0;   // alpha 通道兼职陆地掩膜，夜里点城市灯
          if (elev < 0.535) {
            const t = sstep(0.20, 0.535, elev);
            col = mix3([0.018, 0.085, 0.230], [0.040, 0.260, 0.520], t);
            // 浅海/海岸线
            col = mix3(col, [0.060, 0.310, 0.520], sstep(0.010, 0.0, Math.abs(elev - 0.535)) * 0.8);
          } else {
            const dry = fbm(px * 3.9 + 17.0, py * 3.9, pz * 3.9, 3);
            const detail = fbm(px * 9.0 + 23.0, py * 9.0, pz * 9.0, 2);
            const green = [0.13, 0.26 + 0.06 * (1 - Math.abs(lat)), 0.11];
            const olive = [0.30, 0.29, 0.16];
            const sand = [0.56, 0.44, 0.24];
            const mtn = [0.48, 0.46, 0.40];
            const desertBand = Math.exp(-Math.pow((Math.abs(lat) - 0.42) / 0.16, 2));
            col = mix3(green, olive, sstep(0.38, 0.62, dry));
            col = mix3(col, sand, clamp01(sstep(0.52, 0.74, dry) * 0.85 + desertBand * 0.45));
            col = mix3(col, mtn, sstep(0.60, 0.78, elev) * 0.6);
            col = mix3(col, [0.11, 0.20, 0.09], sstep(0.62, 0.78, detail) * 0.22);
          }
          col = mix3(col, [0.86, 0.92, 0.98], ice);

        } else if (kind === 'mars') {
          const n = fbm(px * 2.4 + 7.0, py * 2.4, pz * 2.4, 4);
          const dk = fbm(px * 1.5 + 21.0, py * 1.5, pz * 1.5, 3);
          const v = 0.44 + 0.34 * n;
          col = [0.50 + v * 0.34, 0.19 + v * 0.15, 0.10 + v * 0.09];
          col = mix3(col, [0.30, 0.15, 0.10], sstep(0.48, 0.28, dk) * 0.8);
          const ice = sstep(1.20, 1.42, Math.abs(lat));
          col = mix3(col, [0.95, 0.94, 0.92], ice);

        } else if (kind === 'jupiter') {
          const warp = fbm(px * 1.5 + 2.3, py * 1.5, pz * 1.5, 4) - 0.5;
          const band = Math.sin(lat * 14.0 + warp * 7.0);
          const band2 = Math.sin(lat * 27.0 + warp * 4.0);
          const fine = fbm(px * 6.2 + 31.0, py * 6.2, pz * 6.2, 3);
          const t = clamp01(0.52 + 0.32 * band + 0.10 * band2 + 0.20 * (fine - 0.5));
          col = mix3([0.56, 0.36, 0.22], [0.95, 0.87, 0.72], t);
          col = mix3(col, [0.97, 0.94, 0.86], sstep(0.72, 0.92, t) * 0.7);
          col = mix3(col, [0.42, 0.26, 0.17], Math.pow(Math.abs(sl), 4) * 0.6);

        } else if (kind === 'saturn') {
          const warp = fbm(px * 1.4 + 4.7, py * 1.4, pz * 1.4, 3) - 0.5;
          const band = Math.sin(lat * 9.5 + warp * 5.0);
          const fine = fbm(px * 5.0 + 41.0, py * 5.0, pz * 5.0, 3);
          const t = clamp01(0.54 + 0.30 * band + 0.18 * (fine - 0.5));
          col = mix3([0.70, 0.57, 0.35], [0.95, 0.89, 0.74], t);
          col = mix3(col, [0.62, 0.52, 0.35], Math.pow(Math.abs(sl), 3) * 0.55);

        } else if (kind === 'uranus') {
          const warp = fbm(px * 1.2 + 6.1, py * 1.2, pz * 1.2, 3) - 0.5;
          const band = Math.sin(lat * 7.0 + warp * 4.0);
          const fine = fbm(px * 4.0 + 51.0, py * 4.0, pz * 4.0, 2);
          const v = 0.74 + 0.07 * band + 0.06 * (fine - 0.5);
          col = [0.52 * v, 0.88 * v, 0.90 * v];
          col = mix3(col, [0.72, 0.95, 0.96], Math.pow(Math.abs(sl), 4) * 0.5);

        } else { // neptune
          const warp = fbm(px * 1.5 + 8.9, py * 1.5, pz * 1.5, 3) - 0.5;
          const band = Math.sin(lat * 9.0 + warp * 5.0);
          const fine = fbm(px * 5.4 + 61.0, py * 5.4, pz * 5.4, 3);
          const v = 0.58 + 0.18 * band + 0.12 * (fine - 0.5);
          col = [0.11 + 0.22 * v, 0.26 + 0.46 * v, 0.64 + 0.40 * v];
          col = mix3(col, [0.22, 0.44, 0.88], Math.pow(Math.abs(sl), 3) * 0.55);
        }

        const i = (y * W + x) * 4;
        d[i] = clamp01(col[0]) * 255;
        d[i + 1] = clamp01(col[1]) * 255;
        d[i + 2] = clamp01(col[2]) * 255;
        d[i + 3] = alpha;
      }
    }
    g.putImageData(img, 0, 0);

    if (kind === 'mercury') craterOverlay(g, W, H, 38);
    if (kind === 'mars') marsOverlay(g, W, H);
    if (kind === 'jupiter') jupiterOverlay(g, W, H);
    if (kind === 'neptune') neptuneOverlay(g, W, H);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  function craterOverlay(g, W, H, n) {
    for (let i = 0; i < n; i++) {
      const u = trnd(), v = 0.18 + trnd() * 0.64;
      const x = u * W, y = v * H;
      const lat = (0.5 - v) * Math.PI;
      const r = (3 + trnd() * 9) * (W / 256);
      const rx = r / Math.max(0.35, Math.cos(lat));
      const grd = g.createRadialGradient(x, y, 0, x, y, rx);
      grd.addColorStop(0, 'rgba(30,28,25,0.30)');
      grd.addColorStop(0.62, 'rgba(44,41,37,0.16)');
      grd.addColorStop(0.86, 'rgba(226,220,208,0.16)');
      grd.addColorStop(1, 'rgba(226,220,208,0)');
      g.save();
      g.translate(x, y); g.scale(1, r / rx); g.translate(-x, -y);
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, rx, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }

  function marsOverlay(g, W, H) {
    // 水手号峡谷：一条横贯中纬度的暗色裂谷
    g.save();
    g.strokeStyle = 'rgba(48,20,12,0.42)';
    g.lineCap = 'round';
    g.lineWidth = 3.2 * (W / 256);
    g.beginPath();
    for (let i = 0; i <= 40; i++) {
      const x = (0.22 + i * 0.016) * W;
      const y = (0.56 + Math.sin(i * 0.25) * 0.018) * H;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.strokeStyle = 'rgba(120,60,36,0.20)';
    g.lineWidth = 7 * (W / 256);
    g.stroke();
    g.restore();
    craterOverlay(g, W, H, 10);
  }

  function jupiterOverlay(g, W, H) {
    // 大红斑
    const cx = W * 0.63, cy = H * 0.665, rx = W * 0.085, ry = H * 0.052;
    g.save();
    g.translate(cx, cy); g.scale(1, ry / rx);
    const grd = g.createRadialGradient(0, 0, rx * 0.10, 0, 0, rx);
    grd.addColorStop(0, 'rgba(196,72,44,0.95)');
    grd.addColorStop(0.45, 'rgba(168,74,48,0.80)');
    grd.addColorStop(0.78, 'rgba(224,150,110,0.55)');
    grd.addColorStop(1, 'rgba(240,220,190,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
    g.restore();
    // 几颗白色风暴卵
    const ovals = [[0.22, 0.71, 0.030, 0.016], [0.36, 0.755, 0.022, 0.012], [0.80, 0.40, 0.018, 0.010]];
    for (let i = 0; i < ovals.length; i++) {
      const o = ovals[i];
      g.save();
      g.translate(W * o[0], H * o[1]);
      g.scale(1, o[3] / o[2]);
      g.fillStyle = 'rgba(250,240,222,0.65)';
      g.beginPath(); g.arc(0, 0, W * o[2], 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }

  function neptuneOverlay(g, W, H) {
    // 大暗斑 + 伴生的亮云
    const cx = W * 0.36, cy = H * 0.60, rx = W * 0.070, ry = H * 0.045;
    g.save();
    g.translate(cx, cy); g.scale(1, ry / rx);
    const grd = g.createRadialGradient(0, 0, rx * 0.08, 0, 0, rx);
    grd.addColorStop(0, 'rgba(8,22,78,0.92)');
    grd.addColorStop(0.70, 'rgba(10,28,92,0.70)');
    grd.addColorStop(1, 'rgba(20,50,130,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
    g.restore();
    g.save();
    g.strokeStyle = 'rgba(232,244,255,0.75)';
    g.lineWidth = 2.2 * (W / 256);
    g.beginPath();
    g.moveTo(W * 0.40, H * 0.635);
    g.bezierCurveTo(W * 0.45, H * 0.625, W * 0.50, H * 0.650, W * 0.55, H * 0.638);
    g.stroke();
    g.restore();
  }

  // 地球云层：白色 + alpha，单独一层壳
  function cloudTexture() {
    const W = 512, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const lat = (0.5 - (y + 0.5) / H) * Math.PI;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let x = 0; x < W; x++) {
        const lon = ((x + 0.5) / W) * Math.PI * 2;
        const px = cl * Math.cos(lon), py = sl, pz = cl * Math.sin(lon);
        // 纬向拉伸的云带 + 涡旋
        const n = fbm(px * 1.6 + 3.7, py * 2.4, pz * 1.6, 5);
        const w = fbm(px * 4.5 + 13.0, py * 6.0, pz * 4.5, 3);
        const band = 0.5 + 0.5 * Math.sin(lat * 7.0 + w * 7.0 + n * 4.0);
        const fine = fbm(px * 9.0 + 29.0, py * 10.0, pz * 9.0, 2);
        const a = clamp01(sstep(0.54, 0.86, n * 0.58 + band * 0.42) + sstep(0.66, 0.90, fine) * 0.22);
        const i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  // 环纹理：u = 归一化半径（内 0 → 外 1），alpha 里画卡西尼缝/恩克缝
  function ringTexture(kind) {
    const W = 256, H = 8;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const saturn = kind !== 'uranus';
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1);
      let a, col;
      if (saturn) {
        a = 0.80 + 0.10 * Math.sin(t * 5.0 + 1.3) + 0.05 * Math.sin(t * 13.0 + 0.4) + 0.03 * Math.sin(t * 33.0 + 2.2);
        a *= 1 - 0.95 * Math.exp(-Math.pow((t - 0.615) / 0.032, 2));  // Cassini
        a *= 1 - 0.85 * Math.exp(-Math.pow((t - 0.885) / 0.014, 2));  // Encke
        a *= 1 - 0.62 * Math.exp(-Math.pow((t - 0.335) / 0.017, 2));  // Maxwell
        a *= sstep(0.02, 0.10, t) * (1 - sstep(0.94, 1.0, t));
        const warm = 0.90 + 0.09 * Math.sin(t * 31.0 + 2.0);
        col = [0.98 * warm, 0.92 * warm, 0.79 * warm];
      } else {
        a = 0.34 + 0.16 * Math.sin(t * 13.0 + 0.7) + 0.08 * Math.sin(t * 31.0 + 1.9);
        a *= 1 - 0.85 * Math.exp(-Math.pow((t - 0.55) / 0.03, 2));
        a *= sstep(0.03, 0.16, t) * (1 - sstep(0.88, 1.0, t));
        col = [0.62, 0.84, 0.90];
      }
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        d[i] = clamp01(col[0]) * 255;
        d[i + 1] = clamp01(col[1]) * 255;
        d[i + 2] = clamp01(col[2]) * 255;
        d[i + 3] = clamp01(a) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  const systemGroup = new THREE.Group();
  let sunGroup = null;
  const sunSprites = [];
  const _solarRingC = new THREE.Vector3();

  const SOLAR_VERT = [
    'varying vec2 vUv; varying vec3 vNw; varying vec3 vWp;',
    'void main() {',
    '  vUv = uv;',
    '  vNw = normalize(mat3(modelMatrix) * normal);',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWp = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  const PLANET_FRAG = [
    'uniform sampler2D uMap;',
    'uniform vec3 uSunDir; uniform vec3 uRim; uniform vec3 uAmbient;',
    'uniform float uDim; uniform float uSpec; uniform float uNight;',
    'varying vec2 vUv; varying vec3 vNw; varying vec3 vWp;',
    'void main() {',
    '  vec4 tex = texture2D(uMap, vUv);',
    '  vec3 alb = pow(tex.rgb, vec3(2.2));',
    '  vec3 N = normalize(vNw);',
    '  vec3 V = normalize(cameraPosition - vWp);',
    '  float ndl = dot(N, uSunDir);',
    '  float day = smoothstep(-0.10, 0.42, ndl);',
    '  vec3 col = alb * (uAmbient + vec3(1.06, 0.98, 0.88) * day);',
    '  float ocean = smoothstep(0.015, 0.12, alb.b - alb.r);',
    '  vec3 H = normalize(uSunDir + V);',
    '  col += vec3(1.0, 0.94, 0.84) * pow(max(dot(N, H), 0.0), 54.0) * ocean * uSpec * day;',
    '  float land = tex.a;',
    '  col += vec3(1.0, 0.62, 0.28) * land * (1.0 - day) * uNight * 0.34;',
    '  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
    '  col += uRim * rim * (0.26 + 0.95 * day);',
    '  gl_FragColor = vec4(col * uDim, 1.0);',
    '}'
  ].join('\n');

  const ATMO_FRAG = [
    'uniform vec3 uColor; uniform vec3 uSunDir;',
    'uniform float uGain; uniform float uPow;',
    'varying vec2 vUv; varying vec3 vNw; varying vec3 vWp;',
    'void main() {',
    '  vec3 N = normalize(vNw);',
    '  vec3 V = normalize(cameraPosition - vWp);',
    '  float f = pow(1.0 - abs(dot(N, V)), uPow);',
    '  float lit = 0.34 + 0.66 * smoothstep(-0.35, 0.50, dot(N, uSunDir));',
    '  vec3 tint = mix(uColor, vec3(1.0, 0.60, 0.28), (lit - 0.34) * 0.65);',
    '  gl_FragColor = vec4(tint * f * uGain * lit, 1.0);',
    '}'
  ].join('\n');

  const CLOUD_FRAG = [
    'uniform sampler2D uMap; uniform vec3 uSunDir;',
    'varying vec2 vUv; varying vec3 vNw; varying vec3 vWp;',
    'void main() {',
    '  float a = texture2D(uMap, vUv).a;',
    '  if (a < 0.004) discard;',
    '  vec3 N = normalize(vNw);',
    '  float lit = smoothstep(-0.25, 0.45, dot(N, uSunDir));',
    '  vec3 col = vec3(0.93, 0.96, 1.0) * (0.16 + 0.95 * lit);',
    '  gl_FragColor = vec4(col, a * (0.20 + 0.80 * lit) * 0.72);',
    '}'
  ].join('\n');

  const RING_FRAG = [
    'uniform sampler2D uMap; uniform vec3 uSunDir;',
    'uniform vec3 uCenter; uniform float uRadius; uniform float uDim;',
    'varying vec2 vUv; varying vec3 vNw; varying vec3 vWp;',
    'void main() {',
    '  vec4 tex = texture2D(uMap, vec2(vUv.x, 0.5));',
    '  if (tex.a < 0.012) discard;',
    '  vec3 col = pow(tex.rgb, vec3(2.2));',
    '  vec3 N = normalize(vNw);',
    '  vec3 V = normalize(cameraPosition - vWp);',
    '  float light = 0.50 + 0.50 * abs(dot(N, uSunDir));',
    '  light += 0.30 * pow(1.0 - abs(dot(N, V)), 2.0);',
    '  vec3 d = vWp - uCenter;',
    '  float along = dot(d, uSunDir);',
    '  float perp = length(d - uSunDir * along);',
    '  float sh = 1.0;',
    '  if (along < 0.0) sh = mix(0.16, 1.0, smoothstep(uRadius * 0.86, uRadius * 1.12, perp));',
    '  gl_FragColor = vec4(col * light * sh, tex.a * uDim);',
    '}'
  ].join('\n');

  function addSolarSystem() {
    const geo = new THREE.SphereGeometry(1, 64, 40);
    solarRoot = new THREE.Group();
    systemGroup.add(solarRoot);
    scene.add(systemGroup);

    const glow = glowTexture();
    const cloudTex = cloudTexture();
    const ringTex = { saturn: ringTexture('saturn'), uranus: ringTexture('uranus') };

    // 右下角画面外的太阳：多层叠加光晕 + 一道横向光斑
    sunGroup = new THREE.Group();
    solarRoot.add(sunGroup);
    [
      [0xff4d10, 0.100, 2.20, 1.70, 0],
      [0xff8a34, 0.260, 0.66, 0.66, 0],
      [0xffc46e, 0.400, 0.28, 0.28, 0],
      [0xfff5e0, 1.000, 0.095, 0.095, 0],
      [0xffa348, 0.120, 2.80, 0.075, -0.13]
    ].forEach(function (d) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow, color: d[0], transparent: true, opacity: d[1],
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
      }));
      s.userData.w = d[2]; s.userData.h = d[3];
      if (d[4]) s.material.rotation = d[4];
      sunSprites.push(s);
      sunGroup.add(s);
    });

    const zs = { mercury: -20, venus: -46, earth: 0, mars: -30, uranus: 22, jupiter: -58, saturn: 32, neptune: 8 };

    SOLAR.list.forEach(function (cfg) {
      const holder = new THREE.Group();
      holder.rotation.z = cfg.tilt;
      solarRoot.add(holder);

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: planetTexture(cfg.key) },
          uSunDir: { value: sunDirWorld },
          uRim: { value: new THREE.Color(cfg.atmo).multiplyScalar(0.55) },
          uAmbient: { value: new THREE.Color(0x08101d) },
          uDim: { value: cfg.key === 'mercury' ? 0.94 : 1.0 },
          uSpec: { value: cfg.key === 'earth' ? 0.95 : 0.0 },
          uNight: { value: cfg.key === 'earth' ? 1.0 : 0.0 }
        },
        vertexShader: SOLAR_VERT, fragmentShader: PLANET_FRAG
      });
      const body = new THREE.Mesh(geo, mat);
      holder.add(body);

      const p = {
        cfg: cfg, holder: holder, body: body, cloud: null, rings: [],
        base: new THREE.Vector3(), z: zs[cfg.key] || 0,
        phase: trnd() * Math.PI * 2, spinAngle: trnd() * Math.PI * 2,
        radius: 1, bob: 0
      };

      // 大气辉光壳：背面渲染 + 菲涅尔边缘，亮部会进入泛光
      const atmo = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(cfg.atmo) },
          uSunDir: { value: sunDirWorld },
          uGain: { value: cfg.atmoGain },
          uPow: { value: cfg.key === 'venus' ? 2.2 : 3.0 }
        },
        vertexShader: SOLAR_VERT, fragmentShader: ATMO_FRAG,
        side: THREE.BackSide, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending
      }));
      atmo.scale.setScalar(1.075);
      atmo.renderOrder = 4;
      holder.add(atmo);

      if (cfg.key === 'earth') {
        const cloud = new THREE.Mesh(geo, new THREE.ShaderMaterial({
          uniforms: { uMap: { value: cloudTex }, uSunDir: { value: sunDirWorld } },
          vertexShader: SOLAR_VERT, fragmentShader: CLOUD_FRAG,
          transparent: true, depthWrite: false, side: THREE.FrontSide
        }));
        cloud.scale.setScalar(1.016);
        cloud.renderOrder = 3;
        holder.add(cloud);
        p.cloud = cloud;
      }

      if (cfg.key === 'saturn') {
        p.rings.push(addRing(holder, ringTex.saturn, 1.34, 2.32, -1.13, -0.16, 0.0, 1.0, p));
      }
      if (cfg.key === 'uranus') {
        p.rings.push(addRing(holder, ringTex.uranus, 1.62, 2.02, 0.30, 0.12, 0.85, 0.60, p));
      }

      // 卫星：几颗就够，屏幕上只是亮点，但让行星"活"起来
      if (cfg.key === 'jupiter') {
        addMoon(holder, 1.75, 0.050, 0xd8c6a8, 1.5, 0.4);
        addMoon(holder, 2.15, 0.042, 0xf0e6d2, 1.1, 2.1);
        addMoon(holder, 2.55, 0.062, 0xc9a87c, 0.8, 4.0);
      }
      if (cfg.key === 'saturn') addMoon(holder, 3.00, 0.058, 0xd9b07a, 0.9, 1.2);
      if (cfg.key === 'earth') addMoon(holder, 2.45, 0.072, 0xcfd0cf, 1.9, 0.9);
      if (cfg.key === 'neptune') addMoon(holder, 2.05, 0.058, 0xc8d0dd, 1.2, 3.3);
      if (cfg.key === 'mars') {
        addMoon(holder, 1.8, 0.022, 0x9a8570, 2.6, 1.0);
        addMoon(holder, 2.4, 0.018, 0x8f7c68, 1.8, 4.4);
      }

      planets.push(p);
    });

    solarBuilt = true;
    layoutSolarSystem();
    updateSolarSystem(0);
  }

  function addRing(holder, tex, inner, outer, rx, rz, ry, dim, p) {
    const g = new THREE.RingGeometry(inner, outer, 160, 1);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, clamp01((r - inner) / (outer - inner)), 0.5);
    }
    const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uSunDir: { value: sunDirWorld },
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: 1 },
        uDim: { value: dim }
      },
      vertexShader: SOLAR_VERT, fragmentShader: RING_FRAG,
      side: THREE.DoubleSide, transparent: true, depthWrite: false
    }));
    mesh.rotation.x = rx;
    mesh.rotation.y = ry;
    mesh.rotation.z = rz;
    mesh.renderOrder = 2;
    holder.add(mesh);
    return mesh;
  }

  function addMoon(holder, orbitR, size, color, speed, phase) {
    const pivot = new THREE.Group();
    pivot.rotation.x = 1.10;
    pivot.rotation.z = 0.16;
    holder.add(pivot);
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: color }));
    m.scale.setScalar(size);
    m.userData.orbitR = orbitR;
    m.userData.speed = speed;
    m.userData.a = phase;
    pivot.add(m);
  }

  // 屏幕比例 → 背板局部坐标：所有行星按「画面下缘的一排天体」来摆
  function layoutSolarSystem() {
    if (!solarRoot) return;
    const W = innerWidth, H = innerHeight;
    const tanV = Math.tan(camera.fov * Math.PI / 360);
    const wpp = 2 * SOLAR.back * tanV / H;
    const base = Math.min(H, W * 0.82) * 1.12;   // 略放大；窄屏自动缩小，避免挤出画面
    const spread = Math.min(1, W / 980);     // 窄屏把水平位置向中间收拢

    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      const sxPx = (0.5 + (p.cfg.sx - 0.5) * spread) * W;
      p.base.set((sxPx - W / 2) * wpp, (H / 2 - p.cfg.sy * H) * wpp, p.z);
      p.holder.position.copy(p.base);
      p.radius = p.cfg.rh * base * wpp;
      p.holder.scale.setScalar(p.radius);
      p.bob = (2.0 + p.cfg.rh * 36) * wpp;
    }

    const sunDepth = SOLAR.back - SOLAR.sun.z;
    const sunWpp = 2 * sunDepth * tanV / H;
    sunGroup.position.set(
      (SOLAR.sun.sx - 0.5) * W * sunWpp,
      (0.5 - SOLAR.sun.sy) * H * sunWpp,
      SOLAR.sun.z
    );
    for (let i = 0; i < sunSprites.length; i++) {
      const s = sunSprites[i];
      s.scale.set(s.userData.w * H * sunWpp, s.userData.h * H * sunWpp, 1);
    }
  }

  function updateSolarSystem(dt) {
    if (!solarBuilt) return;

    _solarFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    systemGroup.position.copy(camera.position).addScaledVector(_solarFwd, SOLAR.back);
    systemGroup.quaternion.copy(camera.quaternion);

    // 面板推开视线时，行星跟着内容一起往左让位
    solarRoot.position.x = -Math.tan(0.42 * panelShift) * SOLAR.back;

    sunDirWorld.copy(SOLAR.light).applyQuaternion(camera.quaternion).normalize();

    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      p.spinAngle = (p.spinAngle + dt * p.cfg.spin) % (Math.PI * 2);
      p.body.rotation.y = p.spinAngle;
      if (p.cloud) p.cloud.rotation.y = p.spinAngle * 1.35;
      p.holder.position.y = p.base.y + Math.sin(clock * 0.00021 + p.phase) * p.bob;

      const pivots = p.holder.children;
      for (let j = 0; j < pivots.length; j++) {
        const c = pivots[j];
        if (!c.isGroup || !c.children.length) continue;
        const m = c.children[0];
        if (m.userData.orbitR === undefined) continue;
        m.userData.a = (m.userData.a + dt * m.userData.speed) % (Math.PI * 2);
        const a = m.userData.a, r = m.userData.orbitR;
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
    }

    systemGroup.updateMatrixWorld(true);

    for (let i = 0; i < planets.length; i++) {
      const p = planets[i];
      if (!p.rings.length) continue;
      p.holder.getWorldPosition(_solarRingC);
      for (let j = 0; j < p.rings.length; j++) {
        p.rings[j].material.uniforms.uCenter.value.copy(_solarRingC);
        p.rings[j].material.uniforms.uRadius.value = p.radius;
      }
    }
    sunGroup.getWorldPosition(solarSunPos);
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
      layoutSolarSystem();
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
    if (hoverLock) { setHover(hoverLock); return; }   // 截图/自检用
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
    if (s) {
      showLinks(s);
      sfx.blip();
      reticleLock(s);
    } else {
      linkObj.visible = false;
      reticleLock(null);
    }
  }

  // ---------------- 瞄准准星：跟着鼠标走，锁定时收缩并显示坐标 ----------------
  const reticle = { el: null, dot: null, label: null, locked: false };

  function initReticle() {
    reticle.el = document.getElementById('reticle');
    if (!reticle.el) return;
    reticle.label = reticle.el.querySelector('.ret-coord');
    window.addEventListener('pointermove', function (e) {
      reticle.el.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
      reticle.el.classList.add('on');
      // 靠近右边缘时坐标读数翻到准星左边，否则会被画布切掉
      reticle.el.classList.toggle('near-r', e.clientX > innerWidth - 210);
    }, { passive: true });
    document.addEventListener('pointerleave', function () {
      reticle.el.classList.remove('on');
    });
  }

  function reticleLock(s) {
    if (!reticle.el) return;
    reticle.locked = !!s;
    reticle.el.classList.toggle('lock', !!s);
    if (!s) { reticle.label.textContent = ''; return; }
    // 用位置换算出「赤经/赤纬」，纯装饰，但每颗星都不同
    const r = Math.max(1, s.pos.length());
    let ra = (Math.atan2(s.pos.z, s.pos.x) / (Math.PI * 2) + 1) % 1;
    const dec = Math.asin(Math.max(-1, Math.min(1, s.pos.y / r))) * 180 / Math.PI;
    const hh = Math.floor(ra * 24), mm = Math.floor((ra * 24 - hh) * 60);
    reticle.label.textContent =
      'RA ' + p2(hh) + 'h' + p2(mm) + 'm  DEC ' + (dec >= 0 ? '+' : '') + dec.toFixed(1) + '°';
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
    scrambleText(document.getElementById('p-title'), s.title, 340);
    document.getElementById('p-meta').textContent =
      s.msgCount + ' 条消息 · ' +
      (s.toolCount || 0) + ' 次工具调用 · ' +
      fmt(s.createdAt) + ' → ' + fmt(s.lastAt);

    renderMessages(s);

    // 缓动飞过去
    const r = RING_R0 + s.msgCount * RING_DR;
    flightTo(s.pos, Math.max(30, r * 2.6), 1.15, easeInOutCubic);
    triggerShockwave(s.pos);
    sfx.warp();
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
  // 会话多了以后，把几千个 DOM 节点一次性塞进侧栏会直接卡住首屏：
// 超过 VIRT_MIN 条就只渲染视口附近那几十条（虚拟滚动），行高固定才可能算得准。
  const VIRT_MIN = 120;
  const VIRT_ROW = 58;
  const vlist = { on: false, box: null, inner: null, dim: {} };

  function makeListItem(s) {
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
    if (vlist.dim[s.id]) el.style.opacity = 0.26;
    return el;
  }

  function renderWindow() {
    const box = vlist.box, inner = vlist.inner;
    if (!box || !inner || !vlist.on) return;
    const n = sessions.length;
    const h = box.clientHeight || 600;
    const first = Math.max(0, Math.floor(box.scrollTop / VIRT_ROW) - 5);
    const last = Math.min(n, Math.ceil((box.scrollTop + h) / VIRT_ROW) + 5);
    inner.innerHTML = '';
    inner.style.paddingTop = (first * VIRT_ROW) + 'px';
    inner.style.paddingBottom = (Math.max(0, n - last) * VIRT_ROW) + 'px';
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.appendChild(makeListItem(sessions[i]));
    inner.appendChild(frag);
  }

  function buildList() {
    const box = document.getElementById('list');
    vlist.box = box;
    box.innerHTML = '';
    vlist.on = sessions.length > VIRT_MIN;
    box.classList.toggle('virtual', vlist.on);

    if (!vlist.on) {
      const frag = document.createDocumentFragment();
      sessions.forEach(function (s) { frag.appendChild(makeListItem(s)); });
      box.appendChild(frag);
      return;
    }

    const inner = document.createElement('div');
    inner.className = 'vlist-inner';
    box.appendChild(inner);
    vlist.inner = inner;
    renderWindow();
    box.addEventListener('scroll', renderWindow, { passive: true });
    window.addEventListener('resize', renderWindow);
  }

  // ---------------- 搜索 ----------------
  function initSearch() {
    const q = document.getElementById('q');
    q.addEventListener('input', function () {
      searchKey = q.value.trim().toLowerCase();
      refreshOpacity();

      vlist.dim = {};
      sessions.forEach(function (s) {
        const hit = !searchKey ||
          s.title.toLowerCase().indexOf(searchKey) >= 0 ||
          s.messages.some(function (m) { return m.text.toLowerCase().indexOf(searchKey) >= 0; });
        if (!hit) vlist.dim[s.id] = 1;
      });
      if (vlist.on) {
        renderWindow();          // 虚拟列表只改了视口内那几行，得重画
      } else {
        sessions.forEach(function (s) {
          const el = document.querySelector('.item[data-id="' + s.id + '"]');
          if (el) el.style.opacity = vlist.dim[s.id] ? 0.26 : 1;
        });
      }
    });
  }

  // ---------------- 每帧更新 ----------------
  function updateStars(dt) {
    // 相机右/上方向：标签贴边时要把世界偏移转回本地（group 在自转）
    _cR.setFromMatrixColumn(camera.matrixWorld, 0);
    _cU.setFromMatrixColumn(camera.matrixWorld, 1);
    sessions.forEach(function (s, i) {
      const o = s.op;

      s.obj.glow.material.opacity = toward(s.obj.glow.material.opacity, o.glow, dt, 7);
      s.obj.points.material.opacity = toward(s.obj.points.material.opacity, o.points, dt, 7);
      s.obj.label.material.opacity = toward(s.obj.label.material.opacity, o.label, dt, 7);
      s.obj.ring.material.opacity = toward(s.obj.ring.material.opacity, o.ring, dt, 7);

      s.obj.group.rotation.y += dt * (0.045 + i * 0.004);
      if (s.obj.corona) s.obj.corona.rotation.z += dt * 0.22;

      const hover = hovered === s ? 1.45 : 1;
      const pulse = 1 + Math.sin(clock * 0.0016 + i * 1.3) * 0.045;
      s.obj.scale = toward(s.obj.scale, s.obj.baseGlow * hover * pulse, dt, 6);
      s.obj.glow.scale.setScalar(s.obj.scale);
      s.obj.glow.material.rotation += dt * 0.1;

      const d = camera.position.distanceTo(s.obj.group.position);

      // LOD：拉远时省掉每条消息的尘埃点和轨道圈，几千个会话也不掉帧；
      // 推近到能看清时才出现。阈值按相机距离，缩放是连续的，不会闪。
      const far = frameDist || 240;
      s.obj.points.visible = d < far * 1.15;
      s.obj.ring.visible = d < far * 1.6;
      // 标签每人一张 canvas 纹理，上千个会话就是上千次 draw call：
      // 只在近处显示，远处的靠光晕和侧栏认人。
      if (sessions.length > 400) s.obj.label.visible = d < far * 1.35;

      const sc = Math.max(2.0, Math.min(16, d * 0.032));
      s.obj.label.scale.set(sc * s.obj.aspect, sc, 1);
      // 屏幕像素 -> 世界单位，用来把打架的标签往上顶
      const worldPerPx = (2 * d * Math.tan(camera.fov * Math.PI / 360)) / innerHeight;
      s.obj.liftCur = toward(s.obj.liftCur || 0, s.obj.liftT || 0, dt, 9);
      clampLabel(s, sc, worldPerPx, dt);
    });

    if (linkObj && linkObj.visible) {
      // 相机在动，带状面片的宽度/朝向每帧重算（只有 3 条，开销可忽略）
      if (hovered) showLinks(hovered);
      linkOpacity = toward(linkMat.uniforms.uOpacity.value, hovered ? 0.8 : 0, dt, 8);
      linkMat.uniforms.uOpacity.value = linkOpacity;
      linkMat.uniforms.uTime.value = clock * 0.001;
      if (linkOpacity < 0.01 && !hovered) linkObj.visible = false;
    }
  }

  // ---------------- 标签贴边夹取 ----------------
  // 标签是屏幕对齐的精灵，不会自己换行也不会被画布边缘裁掉，
  // 所以靠近右边/底部时按投影后的像素位置把它推回安全区。
  const _cR = new THREE.Vector3(), _cU = new THREE.Vector3(), _cv = new THREE.Vector3();
  const LABEL_M = 14;             // 安全边距（像素）
  const LABEL_MAX_SHIFT = 280;    // 最多推这么远，别让标签跑离自己的星

  function clampLabel(s, sc, wpp, dt) {
    const o = s.obj;
    if (!o.label.visible) return;
    _cv.copy(o.group.position).project(camera);
    if (_cv.z > 1) return;
    const sx = (_cv.x * 0.5 + 0.5) * innerWidth;
    const sy = (-_cv.y * 0.5 + 0.5) * innerHeight;
    const halfW = (sc * o.aspect * 0.5) / wpp;
    const halfH = (sc * 0.5) / wpp;
    const cy = sy - o.label.position.y / wpp;   // 标签中心在锚点上方
    let dr = 0, du = 0;
    const r = sx + halfW, l = sx - halfW;
    if (r > innerWidth - LABEL_M) dr = innerWidth - LABEL_M - r;
    else if (l < LABEL_M) dr = LABEL_M - l;
    const b = cy + halfH, t = cy - halfH;
    if (b > innerHeight - LABEL_M) du = b - (innerHeight - LABEL_M);   // 下方溢出 -> 上移
    else if (t < LABEL_M) du = t - LABEL_M;                            // 上方溢出 -> 下移
    dr = Math.max(-LABEL_MAX_SHIFT, Math.min(LABEL_MAX_SHIFT, dr));
    du = Math.max(-LABEL_MAX_SHIFT * 0.5, Math.min(LABEL_MAX_SHIFT * 0.5, du));
    o.dxCur = toward(o.dxCur || 0, dr, dt, 10);
    o.dyCur = toward(o.dyCur || 0, du, dt, 10);
    const wx = (_cR.x * o.dxCur + _cU.x * o.dyCur) * wpp;
    const wy = (_cR.y * o.dxCur + _cU.y * o.dyCur) * wpp;
    const wz = (_cR.z * o.dxCur + _cU.z * o.dyCur) * wpp;
    // 世界偏移 -> group 本地（绕 Y 反向旋转，group 每帧都在转）
    const th = o.group.rotation.y, ct = Math.cos(th), st = Math.sin(th);
    o.label.position.x = wx * ct - wz * st;
    o.label.position.z = wx * st + wz * ct;
    o.label.position.y = sc * 1.25 + o.liftCur * wpp + wy;
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
    updateShockwave(dt);

    if (starfield) starfield.rotation.y += dt * 0.004;
    for (let i = 0; i < nebulas.length; i++) {
      nebulas[i].material.opacity = 0.26 + Math.sin(clock * 0.0004 + i * 2) * 0.05;
    }
    const tsec = clock * 0.001;
    if (post.comp) {
      post.comp.uniforms.uTime.value = tsec;
      // 背景视差：直接用视线方向 xy，连续无接缝（不用 atan2，避免 ±π 跳变）
      _flowDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
      post.comp.uniforms.uCam.value.set(_flowDir.x * 1.1, _flowDir.y * 1.1);
    }
    if (galaxyPts && galaxyPts.material.uniforms) galaxyPts.material.uniforms.uTime.value = tsec;
    if (dustPts && dustPts.material.uniforms) dustPts.material.uniforms.uTime.value = tsec;
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
    const gScale = Math.max(0.5, Math.min(1.6, far * 2.0 / GALAXY_R));
    // 点径不跟着缩，缩完就糊成一团灰雾；uPix 一起缩放才保持颗粒感
    function applyScale(pts, s) {
      if (!pts) return;
      pts.scale.setScalar(s);
      const u = pts.material && pts.material.uniforms;
      if (u && pts.material.userData.baseUxPix) u.uPix.value = pts.material.userData.baseUxPix * s;
    }
    applyScale(galaxyPts, gScale);
    applyScale(dustPts, gScale);
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
    frameDist = orbit.radius;   // LOD 的基准距离：取景时的相机距离

    // 太阳系挂在相机背板上，按视口重新排版；不参与星图取景
    layoutSolarSystem();
    updateSolarSystem(0);

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
      _v.copy(solarSunPos).project(camera);
      const sunPx = [Math.round((_v.x * 0.5 + 0.5) * innerWidth), Math.round((-_v.y * 0.5 + 0.5) * innerHeight)];

      // 标签贴边：量「不夹取」和「夹取后」两个溢出量（像素），验几何而不是靠眼睛
      let rawBad = 0, rawMax = 0, fixBad = 0, fixMax = 0;
      const wv = new THREE.Vector3();
      sessions.forEach(function (s) {
        const dd = camera.position.distanceTo(s.obj.group.position);
        const sc = Math.max(2.0, Math.min(16, dd * 0.032));
        const wpp = 2 * dd * Math.tan(camera.fov * Math.PI / 360) / innerHeight;
        const hw = (sc * s.obj.aspect * 0.5) / wpp, hh = (sc * 0.5) / wpp;
        s.obj.liftCur = 0; s.obj.liftT = 0; s.obj.dxCur = 0; s.obj.dyCur = 0;
        s.obj.label.position.set(0, sc * 1.25, 0);
        function ovf() {
          s.obj.label.getWorldPosition(wv);
          wv.project(camera);
          const cx = (wv.x * 0.5 + 0.5) * innerWidth, cy2 = (-wv.y * 0.5 + 0.5) * innerHeight;
          return Math.max(0, cx + hw - (innerWidth - 14), 14 - (cx - hw),
                          0, cy2 + hh - (innerHeight - 14), 14 - (cy2 - hh));
        }
        let o = ovf();
        if (o > 0.5) { rawBad++; rawMax = Math.max(rawMax, o); }
        clampLabel(s, sc, wpp, 1);
        o = ovf();
        if (o > 0.5) { fixBad++; fixMax = Math.max(fixMax, o); }
      });

      document.title = 'PROBE ' + JSON.stringify({
        n: n, Rg: Math.round(Rg), gScale: +gScale.toFixed(2), d: Math.round(orbit.radius),
        farNode: Math.round(far), nodesPx: nodes, armsPx: arms, W: innerWidth, H: innerHeight,
        baseShift: Math.round(orbit.baseShift), phi: +orbit.phi.toFixed(2),
        sunPx: sunPx, freeCX: Math.round(freeCX), trace: trace,
        lblRaw: [rawBad, Math.round(rawMax)], lblFix: [fixBad, Math.round(fixMax)]
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
      // 调试：?debug=1 时把运行时错误写进标题，headless 抓 DOM 就能看到
      if (QS.get('debug') === '1') {
        window.addEventListener('error', function (e) {
          document.title = 'ERR ' + (e.message || '') + ' @' +
            String(e.filename || '').split('/').pop() + ':' + e.lineno;
        });
      }

      initSearch();

      initReticle();
      // 第一次交互再解锁音频，符合浏览器自动播放策略
      window.addEventListener('pointerdown', function () { sfx.startDrone(); }, { once: true });
      const muteBtn = document.getElementById('mute');
      if (muteBtn) {
        muteBtn.onclick = function () {
          const on = sfx.toggle();
          muteBtn.classList.toggle('off', !on);
          muteBtn.textContent = on ? '◉ 音' : '◎ 静';
        };
      }

      document.getElementById('close').onclick = closePanel;

      // 调试：锁定悬停，把光纤端点的屏幕坐标写进 title，供像素级验证
      if (QS.get('links') === '1') {
        setTimeout(function () {
          hoverLock = sessions[Math.min(1, sessions.length - 1)];
          setHover(hoverLock);
          setTimeout(function () {
            const pts = [], v = new THREE.Vector3();
            camera.updateMatrixWorld(true);
            linkPick.concat([{ o: hoverLock }]).forEach(function (it) {
              v.copy(it.o.pos).project(camera);
              pts.push([Math.round((v.x * 0.5 + 0.5) * innerWidth),
                        Math.round((-v.y * 0.5 + 0.5) * innerHeight)]);
            });
            document.title = 'LINKS ' + JSON.stringify({
              pts: pts, op: +linkMat.uniforms.uOpacity.value.toFixed(2),
              vis: linkObj.visible, picks: linkPick.length,
              dd: linkPick.map(function (it) { return +it.d.toFixed(1); })
            });
          }, 700);
        }, 200);
      }

      // 自检：模拟「选中会话 → 点右上角 ×」，并报告 × 位置上最顶层的元素是谁
      if (QS.get('selftest') === '1') {
        if (QS.get('hover') === '1') {
          // 悬停态截图用：合成一次指针移动 + 锁定第二颗星
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: 1120, clientY: 430 }));
          setTimeout(function () { hoverLock = sessions[1]; setHover(sessions[1]); }, 120);
        }
        setTimeout(function () {
          let flow = 'n/a', top = 'n/a', err = '';
          try {
            selectSession(sessions[0]);
            flow = document.getElementById('panel').classList.contains('open') ? 'opened' : 'not-open';
            // headless 虚拟时间下 CSS transition 不推进，这里直接关掉过渡，量到最终位置
            const pn = document.getElementById('panel');
            pn.style.transition = 'none';
            pn.classList.add('open');
            void pn.offsetWidth;
            setTimeout(function () {
              let top2 = 'n/a', after = '';
              try {
                const cb = document.getElementById('close');
                const r = cb.getBoundingClientRect();
                const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                top2 = el ? (el.id || el.className || el.tagName) : 'none';
                const hit = (el === cb) || (el && el.contains && el.contains(cb));
                after = 'rect=' + [r.left, r.top, r.width, r.height].map(Math.round).join(',') +
                  ' hit=' + (hit ? 'yes' : 'no') +
                  ' panel=' + (function () { const p = document.getElementById('panel').getBoundingClientRect(); return [p.left, p.width].map(Math.round).join(','); })() +
                  ' parent=' + (cb.offsetParent ? (cb.offsetParent.id || cb.offsetParent.className) : 'null') +
                  ' innerW=' + innerWidth;
                cb.click();
                after += ' state=' + (document.getElementById('panel').classList.contains('open') ? 'still-open' : 'closed');
              } catch (e2) { after = 'ERR ' + String((e2 && e2.message) || e2); }
              document.title = 'TEST ' + JSON.stringify({
              flow: flow, topAt: String(top2), after: after, err: err,
              pos0: sessions[0].pos ? [sessions[0].pos.x, sessions[0].pos.y, sessions[0].pos.z].map(Math.round) : null,
              layout: (sessions[0].embed ? 'embed' : (sessions.length > 260 ? 'fast' : 'force'))
            });
            }, 900);
          } catch (e) { err = String((e && e.message) || e); document.title = 'TEST ' + JSON.stringify({ flow: flow, topAt: top, after: '', err: err }); }
        }, 700);
      }

      // 背景图：?bg=<url> 优先，其次同目录 bg.jpg；单文件版可用 window.MEMORY_BG 内联
      (function () {
        const b = document.getElementById('bg');
        if (!b) return;
        function use(src) {
          b.style.backgroundImage = 'url("' + src + '")';
          b.classList.add('on');
        }
        const q = QS.get('bg') || window.MEMORY_BG;
        if (q) { use(q); return; }
        fetch('bg.jpg', { method: 'HEAD' }).then(function (r) {
          if (r.ok) use('bg.jpg');
        }).catch(function () {});
      })();

      // 开局：先定视角，再自动取景
      orbit.tTheta = 0.9;
      orbit.tPhi = 0.95;
      orbit.theta = 0.9;
      orbit.phi = 0.95;
      frameAll();

      // ?zoom=0.6 之类：把取景再收紧一档。默认取景要把整条旋臂都装进来，
      // 会话星就只占画面中间一小块；截图/README 里用这个参数才看得清星。
      const zoomK = parseFloat(QS.get('zoom') || '');
      if (zoomK > 0.2 && zoomK < 3) orbit.radius = Math.max(40, orbit.radius * zoomK);

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