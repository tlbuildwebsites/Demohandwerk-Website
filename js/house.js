/* =========================================================
   Demohandwerk – 3D-Scroll-Geschichte «Vom Rohbau zum fertigen Haus»
   Version 2: PBR-Materialien, HDRI-Licht, Tageslichtverlauf, Baukran,
   Aufbau-Shader (Lage für Lage / Bahn für Bahn), Partikel, Kamerafahrten.
   Benötigt: js/lib/three.bundle.min.js (THREE + Zusatzmodule), js/textures.js
   Fortschritt p: 0 … 8 (Etappe k wird zwischen k-1 und k gebaut)
   ========================================================= */
(function () {
  'use strict';
  const T = window.THREE;

  /* ---------- Hilfsfunktionen ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeBack = (t) => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  // gedämpfte Feder: schiesst leicht über und pendelt sich ein
  const spring = (t) => (t >= 1 ? 1 : 1 - Math.exp(-5.5 * t) * Math.cos(9.5 * t) * (1 - t));
  const rand = (() => { let s = 12345; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();

  /* ---------- Hausmasse (Meter) ---------- */
  const T_W = 0.3;           // Mauerstärke Backstein
  const EH = 4.2;            // Traufhöhe
  const SLOPE = 0.8;         // Dachneigung
  const RH = EH + 4 * SLOPE; // Firsthöhe Mauer = 7.4
  const FL = 0.3;            // Sockel über Terrain
  const INS = 0.14;          // Dämmung
  const PL = 0.025;          // Verputz
  const ANG = Math.atan(SLOPE);

  /* ---------- Texturen aus window.DH_TEX ---------- */
  const texLoader = new T.TextureLoader();
  const texCache = {};
  let maxAniso = 4, pending = 0, onTexReady = null;
  function tex(set, ch, rep) {
    const key = set + ch + rep;
    if (texCache[key]) return texCache[key];
    const src = window.DH_TEX && window.DH_TEX[set] && window.DH_TEX[set][ch];
    if (!src) return null;
    pending++;
    const t = texLoader.load(src, () => { pending--; if (onTexReady && pending === 0) onTexReady(); });
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(rep, rep);
    t.anisotropy = maxAniso;
    if (ch === 'color') t.colorSpace = T.SRGBColorSpace;
    texCache[key] = t;
    return t;
  }
  function pbr(set, params, rep, normalScale) {
    rep = rep || 1;
    const m = new T.MeshStandardMaterial(Object.assign({
      map: tex(set, 'color', rep), normalMap: tex(set, 'normal', rep),
      roughnessMap: tex(set, 'orm', rep), aoMap: tex(set, 'orm', rep), aoMapIntensity: 1,
      roughness: 1, metalness: 0
    }, params || {}));
    m.normalScale = new T.Vector2(normalScale || 1, normalScale || 1);
    return m;
  }

  /* UV in Metern aus Geometrie-Koordinaten (Kachel = 1 m) */
  function worldUV(geo) {
    const p = geo.attributes.position, n = geo.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u, v;
      if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
      else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
      else { u = p.getX(i); v = p.getY(i); }
      uv[i * 2] = u; uv[i * 2 + 1] = v;
    }
    geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
    return geo;
  }

  /* Mehrere Geometrien zu einer zusammenfassen (weniger Draw-Calls) */
  function mergeGeos(list) {
    const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
    let count = 0; parts.forEach((g) => { count += g.attributes.position.count; });
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    let o = 0;
    parts.forEach((g) => {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
    });
    const m = new T.BufferGeometry();
    m.setAttribute('position', new T.BufferAttribute(pos, 3));
    m.setAttribute('normal', new T.BufferAttribute(nor, 3));
    m.setAttribute('uv', new T.BufferAttribute(uv, 2));
    return m;
  }

  /* ---------- Aufbau-Shader ----------
     Zeigt ein Material «Lage für Lage»: Lagen entlang axisC (Abstand step),
     innerhalb der aktuellen Lage wird entlang axisA von a0 nach a1 aufgefüllt.
     mode 'discard' = unsichtbar bis aufgebaut, 'mix' = Farbe A → Farbe B (Anstrich). */
  let revId = 0;
  function addReveal(material, cfg) {
    const id = ++revId;
    const U = {
      uRev: { value: 0 },
      uAxisC: { value: new T.Vector3().fromArray(cfg.axisC) }, uC0: { value: cfg.c0 }, uStep: { value: cfg.step }, uCount: { value: cfg.count },
      uAxisA: { value: new T.Vector3().fromArray(cfg.axisA) }, uA0: { value: cfg.a0 }, uA1: { value: cfg.a1 },
      uColA: { value: new T.Color(cfg.colA || 0xffffff) }, uColB: { value: new T.Color(cfg.colB || 0xffffff) }
    };
    const mix = cfg.mode === 'mix';
    const head = `varying vec3 vRW;
uniform float uRev, uC0, uStep, uCount, uA0, uA1;
uniform vec3 uAxisC, uAxisA, uColA, uColB;
float revealMask() {
  if (uRev <= 0.0001) return 0.0;
  if (uRev >= 0.9999) return 1.0;
  float ci = floor((dot(vRW, uAxisC) - uC0) / uStep);
  float a = clamp((dot(vRW, uAxisA) - uA0) / (uA1 - uA0), 0.0, 1.0);
  float P = uRev * uCount; float fi = floor(P);
  return ci < fi ? 1.0 : (ci < fi + 0.5 ? step(a, P - fi) : 0.0);
}
`;
    function inject(shader, isDepth) {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = 'varying vec3 vRW;\n' + shader.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n vRW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = head + shader.fragmentShader;
      if (mix && !isDepth) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
          '#include <map_fragment>\n diffuseColor.rgb *= mix(uColA, uColB, revealMask());');
      } else if (!mix) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n if (revealMask() < 0.5) discard;');
      }
    }
    material.onBeforeCompile = (s) => inject(s, false);
    material.customProgramCacheKey = () => 'rev' + id;
    let depth = null;
    if (!mix) {
      depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
      depth.onBeforeCompile = (s) => inject(s, true);
      depth.customProgramCacheKey = () => 'revd' + id;
      if (material.clippingPlanes) { depth.clippingPlanes = material.clippingPlanes; depth.clipShadows = true; }
      material.clipShadows = false; // Schatten übernimmt das eigene Tiefenmaterial
    }
    material.userData.reveal = { U, depth };
    return { U, depth, set(v) { U.uRev.value = v; } };
  }

  /* ---------- Partikel (Staub, Funken) ---------- */
  function Particles(max, opts) {
    const geo = new T.BufferGeometry();
    const pos = new Float32Array(max * 3), size = new Float32Array(max), alpha = new Float32Array(max);
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new T.BufferAttribute(alpha, 1));
    const mat = new T.ShaderMaterial({
      uniforms: { uScale: { value: 500 }, uColor: { value: new T.Color(opts.color) } },
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
          float f = ${opts.additive ? 'pow(1.0 - d * 2.0, 2.0)' : 'smoothstep(0.5, 0.1, d)'};
          gl_FragColor = vec4(uColor * ${opts.additive ? '2.5' : '1.0'}, f * vA);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
      blending: opts.additive ? T.AdditiveBlending : T.NormalBlending
    });
    const pts = new T.Points(geo, mat);
    pts.frustumCulled = false;
    const vel = new Float32Array(max * 3), life = new Float32Array(max), maxLife = new Float32Array(max), baseSize = new Float32Array(max);
    let cursor = 0, limit = max, active = false;
    return {
      obj: pts, mat,
      setLimit(n) { limit = Math.max(1, Math.min(max, n)); cursor = cursor % limit; },
      spawn(x, y, z, vx, vy, vz, l, s) {
        const i = cursor; cursor = (cursor + 1) % limit;
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
        life[i] = maxLife[i] = l; baseSize[i] = s; active = true;
      },
      update(dt) {
        if (!active) return false;
        let alive = 0;
        const g = opts.gravity, drag = Math.exp(-opts.drag * dt);
        for (let i = 0; i < max; i++) {
          if (life[i] <= 0) { alpha[i] = 0; continue; }
          life[i] -= dt; alive++;
          vel[i * 3] *= drag; vel[i * 3 + 1] = vel[i * 3 + 1] * drag + g * dt; vel[i * 3 + 2] *= drag;
          pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          const k = Math.max(0, life[i] / maxLife[i]);
          alpha[i] = opts.additive ? k : Math.min(1, (1 - k) * 4) * k * opts.alpha;
          size[i] = baseSize[i] * (opts.additive ? (0.4 + 0.6 * k) : (1 + (1 - k) * 1.2));
        }
        geo.attributes.position.needsUpdate = true; geo.attributes.aSize.needsUpdate = true; geo.attributes.aAlpha.needsUpdate = true;
        active = alive > 0;
        return true; // auch das letzte (ausgeblendete) Bild noch zeichnen
      }
    };
  }

  /* ---------- HDRI (RGBE in PNG) → Half-Float-Textur ---------- */
  function loadHDRI(src, cb) {
    const img = new Image();
    img.onload = () => {
      const w = img.width, h = img.height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      const out = new Uint16Array(w * h * 4);
      const one = T.DataUtils.toHalfFloat(1);
      for (let y = 0; y < h; y++) {
        const ty = h - 1 - y; // DataTexture: Zeile 0 = unten
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4, o = (ty * w + x) * 4;
          const e = d[i + 3];
          const f = e ? Math.pow(2, e - 136) : 0; // 2^(e-128) / 256
          out[o] = T.DataUtils.toHalfFloat(d[i] * f);
          out[o + 1] = T.DataUtils.toHalfFloat(d[i + 1] * f);
          out[o + 2] = T.DataUtils.toHalfFloat(d[i + 2] * f);
          out[o + 3] = one;
        }
      }
      const t = new T.DataTexture(out, w, h, T.RGBAFormat, T.HalfFloatType);
      t.mapping = T.EquirectangularReflectionMapping;
      t.magFilter = T.LinearFilter; t.minFilter = T.LinearFilter;
      t.needsUpdate = true;
      cb(t);
    };
    img.src = src;
  }

  /* =========================================================
     Szene
     ========================================================= */
  function createHouseScene(canvas, options) {
    options = options || {};
    let tier = options.tier || 'medium';

    let renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!options.still });
    } catch (e) { return null; }
    if (!renderer.capabilities.isWebGL2) return null;
    maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = false; // keine echten Schatten (Leistung)

    const scene = new T.Scene();
    const fog = new T.Fog(0xdfe4e6, 45, 150);
    scene.fog = fog;
    const camera = new T.PerspectiveCamera(35, 1.6, 0.3, 400);
    const Yv = new T.Vector3(0, 1, 0);
    const tmpV = new T.Vector3();

    /* ---------- Himmel (Kuppel mit Verlauf + Sonnenschein) ---------- */
    const skyU = {
      uTop: { value: new T.Color() }, uHor: { value: new T.Color() }, uGnd: { value: new T.Color() },
      uSunDir: { value: new T.Vector3(0, 1, 0) }, uSunCol: { value: new T.Color() }
    };
    const sky = new T.Mesh(new T.SphereGeometry(300, 32, 16), new T.ShaderMaterial({
      uniforms: skyU, side: T.BackSide, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 uTop, uHor, uGnd, uSunDir, uSunCol; varying vec3 vDir;
        void main(){ vec3 d = normalize(vDir); float h = d.y;
          vec3 c = h > 0.0 ? mix(uHor, uTop, pow(h, 0.55)) : mix(uHor, uGnd, smoothstep(0.0, 0.12, -h));
          float s = max(dot(d, uSunDir), 0.0);
          c += uSunCol * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.35);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    }));
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    scene.add(sky);

    /* ---------- Licht ---------- */
    const sun = new T.DirectionalLight(0xffffff, 3);
    const sc = sun.shadow.camera; sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 90;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025;
    scene.add(sun); scene.add(sun.target);
    const ambient = new T.AmbientLight(0x6070a0, 0);
    scene.add(ambient);

    /* ---------- Clipping-Ebenen (Schnitt in den Etappen 4–6) ---------- */
    const planes = {
      front: new T.Plane(new T.Vector3(0, -1, 0), 50),   // Frontwand senkt sich
      roofCut: new T.Plane(new T.Vector3(0, 0, -1), 50), // vordere Dachhälfte
      intp: new T.Plane(new T.Vector3(0, -1, 0), 50)     // Innenputz steigt
    };

    /* ---------- Materialien (PBR) ---------- */
    const M = {};
    M.concrete = pbr('beton', {}, 0.5);
    M.concreteSlab = pbr('beton', { color: 0xe8e8e8 }, 0.5);
    M.concretePlain = pbr('beton', {}, 0.5);
    M.brick = pbr('backstein', { color: 0xe6d6cc, side: T.DoubleSide }, 1, 1.2);
    M.brickF = pbr('backstein', { color: 0xe6d6cc, side: T.DoubleSide, clippingPlanes: [planes.front] }, 1, 1.2);
    M.chimney = pbr('backstein', { color: 0xe6d6cc }, 1, 1.2);
    M.ins = pbr('daemmung', {}, 1);
    M.insF = pbr('daemmung', { clippingPlanes: [planes.front] }, 1);
    M.plas = pbr('verputz', { color: 0xd6d0c4 }, 0.8, 0.8);
    M.plasF = pbr('verputz', { color: 0xd6d0c4, clippingPlanes: [planes.front] }, 0.8, 0.8);
    M.plinth = pbr('verputz', { color: 0x3a3e42 }, 0.8, 0.6);
    M.plinthF = pbr('verputz', { color: 0x3a3e42, clippingPlanes: [planes.front] }, 0.8, 0.6);
    M.frame = new T.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.38, metalness: 0.35 });
    M.frameF = new T.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.38, metalness: 0.35, clippingPlanes: [planes.front] });
    M.sill = new T.MeshStandardMaterial({ color: 0xa3a9ae, roughness: 0.3, metalness: 0.75 });
    M.sillF = new T.MeshStandardMaterial({ color: 0xa3a9ae, roughness: 0.3, metalness: 0.75, clippingPlanes: [planes.front] });
    const glassParams = { color: 0x7d97a6, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.38, envMapIntensity: 2.4,
      clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.5, specularIntensity: 1, emissive: 0xffb062, emissiveIntensity: 0, depthWrite: false };
    M.oak = pbr('eiche', {}, 1);
    M.oakDark = pbr('eiche', { color: 0x8a6a4a }, 1);
    M.timber = pbr('eiche', { color: 0xf0dcc0, clippingPlanes: [planes.roofCut] }, 1);
    M.timberFree = pbr('eiche', { color: 0xf0dcc0 }, 1);
    M.deck = pbr('bretter', { color: 0xe0c8a8, side: T.DoubleSide, clippingPlanes: [planes.roofCut] }, 1);
    M.clad = pbr('bretter', { clippingPlanes: [planes.roofCut] }, 1);
    M.verge = pbr('bretter', { clippingPlanes: [planes.roofCut] }, 1);
    M.tiles = pbr('ziegel', { color: 0xa3928b, clippingPlanes: [planes.roofCut] }, 1, 1.3);
    M.ridge = pbr('ziegel', { color: 0xb07060 }, 2);
    M.gutter = new T.MeshStandardMaterial({ color: 0x5b6066, roughness: 0.28, metalness: 0.85, side: T.DoubleSide, clippingPlanes: [planes.roofCut] });
    M.metal = new T.MeshStandardMaterial({ color: 0x5b6066, roughness: 0.3, metalness: 0.85 });
    M.intp = pbr('verputz', {}, 1, 0.7); M.intp.clippingPlanes = [planes.intp];
    M.intpRoof = pbr('verputz', { side: T.DoubleSide }, 1, 0.7); M.intpRoof.clippingPlanes = [planes.intp, planes.roofCut];
    M.parquet = pbr('parkett', { color: 0xf2d6b0 }, 1, 0.8);
    M.ground = pbr('erde', {}, 0.22, 1.2);
    M.stone = pbr('stein', {}, 1);
    M.steel = new T.MeshStandardMaterial({ color: 0xa4aaaf, roughness: 0.35, metalness: 0.8 });
    M.board = pbr('bretter', { color: 0xe6c793 }, 1);
    M.warn = new T.MeshStandardMaterial({ color: 0xf2bd00, roughness: 0.55 });
    M.crane = new T.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0.35 });
    M.craneDark = new T.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.5, metalness: 0.4 });
    M.cable = new T.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.6, metalness: 0.6 });
    M.profile = new T.MeshStandardMaterial({ color: 0xf3f0ea, roughness: 0.6 });
    M.profileRed = new T.MeshStandardMaterial({ color: 0xc8322b, roughness: 0.6 });
    M.cabinet = pbr('verputz', { color: 0x30353a, roughness: 0.6 }, 1, 0.15);
    M.counter = new T.MeshStandardMaterial({ color: 0xe9e5dd, roughness: 0.22 });
    M.white = new T.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.5 });
    M.fabric = pbr('verputz', { color: 0x4a4f55 }, 3, 0.6);
    M.fabricLight = pbr('verputz', { color: 0xd8cfc0 }, 3, 0.6);
    M.trunk = pbr('bretter', { color: 0x6a4f3a }, 2, 1.5);
    M.fence = pbr('eiche', { color: 0xc4bcb0 }, 1);
    M.lampShade = new T.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.4, metalness: 0.6, side: T.DoubleSide });
    M.bulb = new T.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffc56b, emissiveIntensity: 0 });
    M.glow = new T.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffc56b, emissiveIntensity: 0 });
    M.glowF = new T.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffc56b, emissiveIntensity: 0, clippingPlanes: [planes.front] });
    M.fuse = new T.MeshStandardMaterial({ color: 0xd2d5d7, roughness: 0.4 });
    M.door = pbr('bretter', { color: 0xc89a66, clippingPlanes: [planes.front] }, 1);

    /* ---------- Aufbau-Shader verknüpfen ---------- */
    const R = {};
    R.found = addReveal(M.concrete, { axisC: [0, 1, 0], c0: -0.62, step: 0.04, count: 24, axisA: [1, 0, 0], a0: -5.5, a1: 5.5 });
    // Mauerwerk: Lage für Lage (12.5 cm), jede Lage läuft einmal ums Haus
    const brickCfg = { axisC: [0, 1, 0], c0: FL - 0.005, step: 0.125, count: Math.ceil((RH + 1.2) / 0.125), axisA: [0.7071, 0, 0.7071], a0: -9.5, a1: 9.5 };
    R.brick = addReveal(M.brick, brickCfg); R.brickF = addReveal(M.brickF, brickCfg); R.chimney = addReveal(M.chimney, brickCfg);
    // Dämmplatten: Reihe für Reihe (50 cm)
    const insCfg = { axisC: [0, 1, 0], c0: FL - 0.1, step: 0.5, count: Math.ceil((RH + 0.6) / 0.5), axisA: [0.7071, 0, 0.7071], a0: -9.5, a1: 9.5 };
    R.ins = addReveal(M.ins, insCfg); R.insF = addReveal(M.insF, insCfg);
    // Verputz: Bahn für Bahn, jede Bahn von oben nach unten
    const plasCfg = { axisC: [0.7071, 0, 0.7071], c0: -7.2, step: 0.72, count: 20, axisA: [0, -1, 0], a0: -(FL + RH + 0.5), a1: -FL };
    R.plas = addReveal(M.plas, plasCfg); R.plasF = addReveal(M.plasF, plasCfg);
    // Unterdach-Schalung und Ziegel: Reihe für Reihe von der Traufe zum First
    const eaveY = FL + EH - 0.5;
    R.deck = addReveal(M.deck, { axisC: [0, 1, 0], c0: eaveY, step: 0.35, count: 13, axisA: [1, 0, 0], a0: -5.6, a1: 5.6 });
    const tileStep = 0.33 * Math.sin(ANG);
    R.tiles = addReveal(M.tiles, { axisC: [0, 1, 0], c0: eaveY, step: tileStep, count: Math.ceil((RH + 1.0 - EH + 0.5) / tileStep), axisA: [1, 0, 0], a0: -5.6, a1: 5.6 });
    // Giebelschalung: Brett für Brett
    R.clad = addReveal(M.clad, { axisC: [0, 0, 1], c0: -4.4, step: 0.18, count: 50, axisA: [0, 1, 0], a0: FL + EH, a1: FL + RH + 0.2 });
    // Anstrich innen: Farbe rollt Bahn für Bahn (60 cm Roller) von unten nach oben
    const paintCfg = { mode: 'mix', axisC: [0.7071, 0, 0.7071], c0: -7.2, step: 0.6, count: 24, axisA: [0, 1, 0], a0: FL, a1: FL + 2.9, colA: 0xb8b1a5, colB: 0xf4f0e8 };
    R.paint = addReveal(M.intp, paintCfg); R.paintRoof = addReveal(M.intpRoof, paintCfg);
    // Parkett: Brett für Brett (12.5 cm Riemen)
    R.floor = addReveal(M.parquet, { axisC: [1, 0, 0], c0: -4.75, step: 0.125, count: 76, axisA: [0, 0, 1], a0: -3.7, a1: 3.7 });
    // Schatten auch bei geschnittenen Materialien korrekt
    Object.keys(M).forEach((k) => { const m = M[k]; if (m.clippingPlanes && !(m.userData.reveal && m.userData.reveal.depth)) m.clipShadows = true; });

    // Rasen wächst: Erde → Gras (eigener Shader auf dem Boden)
    const grassU = { uGrass: { value: 0 }, tGrass: { value: tex('rasen', 'color', 0.7) } };
    M.ground.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, grassU);
      s.vertexShader = 'varying vec3 vRW;\n' + s.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vRW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      s.fragmentShader = `varying vec3 vRW; uniform float uGrass; uniform sampler2D tGrass;
        float hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hsh(i), hsh(i+vec2(1,0)), f.x), mix(hsh(i+vec2(0,1)), hsh(i+vec2(1,1)), f.x), f.y); }
        ` + s.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= 0.72 + 0.45 * vnoise(vRW.xz * 0.09) + 0.15 * vnoise(vRW.xz * 0.37);
        { vec3 gc = texture2D(tGrass, vRW.xz * 0.45).rgb * (0.75 + 0.4 * vnoise(vRW.xz * 0.13 + 7.0));
          float d = length(vRW.xz - vec2(0.0, 3.0));
          float n = vnoise(vRW.xz * 0.45) * 3.0 + vnoise(vRW.xz * 2.1) * 0.8;
          float m = smoothstep(0.0, 1.6, uGrass * 40.0 - d + n - 2.0);
          m *= 1.0 - step(abs(vRW.x), 5.75) * step(abs(vRW.z), 4.75);
          diffuseColor.rgb = mix(diffuseColor.rgb, gc, m); }`);
    };
    M.ground.customProgramCacheKey = () => 'ground-grass';

    /* ---------- Hilfen zum Bauen ---------- */
    const house = new T.Group();
    house.position.y = FL;
    scene.add(house);

    function mesh(geo, material, parent, shadow) {
      const m = new T.Mesh(geo, material);
      if (shadow !== false) { m.castShadow = true; m.receiveShadow = true; }
      const rv = material.userData && material.userData.reveal;
      if (rv && rv.depth) m.customDepthMaterial = rv.depth;
      (parent || house).add(m);
      return m;
    }
    function rbox(w, h, d, r) {
      const rr = Math.min(r === undefined ? 0.02 : r, Math.min(w, h, d) / 2 - 0.001);
      return rr > 0.004 ? new T.RoundedBoxGeometry(w, h, d, 2, rr) : new T.BoxGeometry(w, h, d);
    }
    function box(w, h, d, material, x, y, z, parent, opts) {
      opts = opts || {};
      const g = rbox(w, h, d, opts.r);
      if (opts.uv !== false) { g.translate(x, y, z); worldUV(g); g.translate(-x, -y, -z); }
      const m = mesh(g, material, parent, opts.shadow);
      m.position.set(x, y, z);
      return m;
    }

    /* ---------- Animations-Register ---------- */
    const anims = [];
    function at(t0, t1, fn) { anims.push({ t0, t1, fn, last: -1 }); }
    const S = (k, a, b) => [k - 1 + a, k - 1 + b];

    function growY(obj, k, a, b, ease) {
      const [t0, t1] = S(k, a, b);
      obj.scale.y = 0.0001; obj.visible = false;
      at(t0, t1, (t) => { obj.scale.y = Math.max(0.0001, (ease || easeOut)(t)); obj.visible = t > 0; });
    }
    function pop(obj, k, a, b, ease) {
      const [t0, t1] = S(k, a, b);
      const s0 = obj.scale.clone();
      obj.visible = false;
      at(t0, t1, (t) => { const e = Math.max(0.0001, (ease || easeBack)(t)); obj.scale.copy(s0).multiplyScalar(e); obj.visible = t > 0; });
    }
    function slide(obj, k, a, b, dx, dy, dz, ease) {
      const [t0, t1] = S(k, a, b);
      const p0 = obj.position.clone(); obj.visible = false;
      at(t0, t1, (t) => { const e = 1 - (ease || easeOut)(t); obj.position.set(p0.x + dx * e, p0.y + dy * e, p0.z + dz * e); obj.visible = t > 0; });
    }
    function uniformTo(rv, t0, t1, from, to) {
      rv.set(from);
      at(t0, t1, (t) => rv.set(lerp(from, to, t)));
    }
    function colorTo(color, t0, t1, from, to) {
      const a = new T.Color(from), b = new T.Color(to);
      color.copy(a);
      at(t0, t1, (t) => color.copy(a).lerp(b, smooth(t)));
    }
    function stagger(list, k, a, b, fn, overlap) {
      const n = list.length, span = b - a, w = Math.min(span, span / n * (overlap || 3));
      list.forEach((o, i) => { const s = a + (span - w) * (n > 1 ? i / (n - 1) : 0); fn(o, k, s, s + w, i); });
    }

    /* ---------- Partikel ---------- */
    const dust = Particles(130, { color: 0xa79d8c, gravity: 0.18, drag: 1.6, alpha: 0.32 });
    const sparks = Particles(110, { color: 0xffd36a, gravity: -9, drag: 0.6, additive: true });
    scene.add(dust.obj); scene.add(sparks.obj);
    function puff(x, y, z, n, spread) {
      for (let i = 0; i < n; i++) dust.spawn(x + (rand() - 0.5) * spread, y + rand() * 0.2, z + (rand() - 0.5) * spread,
        (rand() - 0.5) * 0.6, 0.15 + rand() * 0.35, (rand() - 0.5) * 0.6, 1.0 + rand() * 1.0, 0.08 + rand() * 0.12);
    }
    function burst(x, y, z, n) {
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, s = 1 + rand() * 2.5;
        sparks.spawn(x, y, z, Math.cos(a) * s, 1 + rand() * 2.5, Math.sin(a) * s, 0.35 + rand() * 0.45, 0.05 + rand() * 0.05);
      }
    }
    // Auslöser beim Überschreiten einer Position (nur vorwärts, live)
    const triggers = [];
    function trigger(p, fn) { triggers.push({ p, fn }); }

    /* =========================================================
       Wände
       ========================================================= */
    const WALLS = {
      front: { pos: [0, 0, 4], rot: 0, gable: false },
      back: { pos: [0, 0, -4], rot: Math.PI, gable: false },
      left: { pos: [-5, 0, 0], rot: -Math.PI / 2, gable: true },
      right: { pos: [5, 0, 0], rot: Math.PI / 2, gable: true }
    };
    const OPEN = {
      front: [[-4.0, -2.6, 0.9, 2.2], [-0.3, 0.8, 0, 2.25], [1.8, 4.2, 0.3, 2.3], [-3.6, -2.4, 3.25, 4.0], [2.2, 3.4, 3.25, 4.0]],
      back: [[-4.2, -2.0, 0.3, 2.3], [1.7, 3.1, 1.15, 2.2], [-1.0, 0.6, 3.25, 4.0]],
      left: [[-1.5, 0.0, 0.9, 2.2], [-0.6, 0.6, 4.4, 5.6]],
      right: [[-1.0, 0.6, 0.9, 2.2], [-0.6, 0.6, 4.4, 5.6]]
    };
    for (const k in WALLS) {
      const w = WALLS[k], g = new T.Group();
      g.position.fromArray(w.pos); g.rotation.y = w.rot;
      house.add(g); w.group = g;
    }
    const gableTop = (u) => EH + (4 - Math.abs(u)) * SLOPE;
    const rect = (a, b, c, e) => { const s = new T.Shape(); s.moveTo(a, c); s.lineTo(b, c); s.lineTo(b, e); s.lineTo(a, e); s.closePath(); return s; };

    function holePath(o, y0) {
      const h = new T.Path(), v0 = Math.max(o[2], y0 + 0.001);
      h.moveTo(o[0], v0); h.lineTo(o[0], o[3]); h.lineTo(o[1], o[3]); h.lineTo(o[1], v0); h.closePath();
      return h;
    }
    function extrude(shape, depth, z0, bevel) {
      const b = bevel || 0;
      const g = new T.ExtrudeGeometry(shape, b
        ? { depth: Math.max(0.002, depth - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1 }
        : { depth, bevelEnabled: false });
      g.translate(0, 0, z0 + b);
      return worldUV(g);
    }
    function wallGeo(wall, u0, u1, y0, z0, depth, extend, bevel) {
      const doors = OPEN[wall].filter((o) => o[2] <= y0 + 0.001);
      const shapes = [];
      if (!doors.length) {
        const s = new T.Shape();
        s.moveTo(u0, y0); s.lineTo(u1, y0);
        if (WALLS[wall].gable) { s.lineTo(u1, gableTop(u1) + extend * 0.2); s.lineTo(0, RH + extend * 0.6); s.lineTo(u0, gableTop(u0) + extend * 0.2); }
        else { s.lineTo(u1, EH); s.lineTo(u0, EH); }
        s.closePath();
        OPEN[wall].forEach((o) => s.holes.push(holePath(o, y0)));
        shapes.push(s);
      } else {
        const d = doors[0];
        const left = rect(u0, d[0], y0, EH), right = rect(d[1], u1, y0, EH), top = rect(d[0], d[1], d[3], EH);
        OPEN[wall].forEach((o) => { if (o === d) return; (o[1] <= d[0] ? left : right).holes.push(holePath(o, y0)); });
        shapes.push(left, right, top);
      }
      return shapes.map((s) => extrude(s, depth, z0, bevel));
    }
    function wallMeshes(wall, u0, u1, y0, z0, depth, material, extend, bevel) {
      return wallGeo(wall, u0, u1, y0, z0, depth, extend || 0, bevel).map((g) => mesh(g, material, WALLS[wall].group));
    }
    function innerWall(x, y0, yTop, door, thick, material) {
      const g = new T.Group(); g.position.set(x + thick / 2, 0, 0); g.rotation.y = -Math.PI / 2; house.add(g);
      const shapes = [];
      if (yTop === 'roof') {
        const s = new T.Shape();
        s.moveTo(-3.7, y0); s.lineTo(3.7, y0); s.lineTo(3.7, gableTop(3.7) - 0.3); s.lineTo(0, RH - 0.3); s.lineTo(-3.7, gableTop(-3.7) - 0.3); s.closePath();
        shapes.push(s);
      } else if (door) {
        shapes.push(rect(-3.7, door[0], y0, yTop), rect(door[1], 3.7, y0, yTop), rect(door[0], door[1], y0 + door[2], yTop));
      }
      return shapes.map((sh) => mesh(extrude(sh, thick, 0), material, g));
    }

    /* =========================================================
       Bauplatz: Bauprofile
       ========================================================= */
    const profiles = new T.Group(); scene.add(profiles);
    [[-5, -4], [5, -4], [-5, 4], [5, 4]].forEach(([x, z]) => {
      const h = RH + FL + 0.4;
      const pole = new T.Mesh(rbox(0.08, h, 0.08, 0.01), M.profile); pole.position.set(x, h / 2, z); pole.castShadow = true; profiles.add(pole);
      for (let i = 0; i < 3; i++) { const band = new T.Mesh(rbox(0.09, 0.3, 0.09, 0.01), M.profileRed); band.position.set(x, 1 + i * 2.2, z); profiles.add(band); }
    });
    [-5.4, 5.4].forEach((x) => {
      const h = RH + FL + 0.6;
      const g = new T.Mesh(rbox(0.08, h, 0.08, 0.01), M.profileRed); g.position.set(x, h / 2, 0); g.castShadow = true; profiles.add(g);
      [-1, 1].forEach((sgn) => { const l = new T.Mesh(new T.BoxGeometry(0.05, 0.05, 6.4), M.profile); l.position.set(x, FL + EH + 1.65, sgn * 2.2); l.rotation.x = sgn * ANG; profiles.add(l); });
    });
    at(0.02, 0.12, (t) => { profiles.position.y = -easeInOut(t) * 9; profiles.visible = t < 1; });

    /* =========================================================
       Etappe 1: Rohbau
       ========================================================= */
    box(10.4, 0.6, 8.4, M.concrete, 0, -0.31, 0, house, { r: 0.03 });
    box(10.0, 0.25, 8.0, M.concrete, 0, -0.125, 0, house, { r: 0.02 });
    uniformTo(R.found, ...S(1, 0.04, 0.18), 0, 1);
    trigger(0.06, () => puff(0, FL, 0, 18, 9));
    trigger(0.12, () => puff(-3, FL, 2, 12, 6));

    wallMeshes('front', -5, 5, 0, -T_W, T_W, M.brickF, 0, 0.012);
    wallMeshes('back', -5, 5, 0, -T_W, T_W, M.brick, 0, 0.012);
    wallMeshes('left', -3.7, 3.7, 0, -T_W, T_W, M.brick, 0, 0.012);
    wallMeshes('right', -3.7, 3.7, 0, -T_W, T_W, M.brick, 0, 0.012);
    innerWall(-1, 0, 2.8, [1.2, 2.1, 2.1], 0.15, M.brick);
    // Kamin (läuft durchs Dach)
    const chimH = RH + 1.15 - 2.8;
    box(0.6, chimH, 0.6, M.chimney, 2.4, 2.8 + chimH / 2, -1.9, house, { r: 0.015 });
    // Mauern: zuerst bis zur Decke, dann (nach dem Absetzen der Deckenelemente) bis zum First
    const toSlab = 2.8 / brickCfg.step / brickCfg.count;
    at(...S(1, 0.16, 0.92), (t) => {
      const p = lerp(0.16, 0.92, t);
      const v = p < 0.42 ? lerp(0, toSlab, (p - 0.16) / 0.26) : (p < 0.64 ? toSlab : lerp(toSlab, 1, (p - 0.64) / 0.28));
      R.brick.set(v); R.brickF.set(v); R.chimney.set(v);
    });

    // Geschossdecke aus 4 Fertigteil-Elementen (der Kran setzt sie ab)
    const slabParts = [];
    function slabShape(pts) { const s = new T.Shape(); s.moveTo(pts[0][0], -pts[0][1]); pts.slice(1).forEach((q) => s.lineTo(q[0], -q[1])); s.closePath(); return s; }
    [
      [[-4.7, -3.7], [-2.35, -3.7], [-2.35, 3.7], [-4.7, 3.7]],
      [[-2.35, -3.7], [0, -3.7], [0, 3.7], [-2.35, 3.7]],
      [[0, -3.7], [2.35, -3.7], [2.35, 3.7], [0, 3.7]],
      [[2.35, -3.7], [4.7, -3.7], [4.7, -2.65], [3.58, -2.65], [3.58, 1.0], [4.7, 1.0], [4.7, 3.7], [2.35, 3.7]]
    ].forEach((pts) => {
      const g = new T.ExtrudeGeometry(slabShape(pts), { depth: 0.19, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelOffset: -0.005, bevelSegments: 1 });
      g.rotateX(-Math.PI / 2);
      const cx = (pts[0][0] + pts[1][0]) / 2;
      g.translate(-cx, 0, 0);
      worldUV(g);
      const m = mesh(g, M.concreteSlab, scene);
      m.userData.final = new T.Vector3(cx, FL + 2.8, 0);
      slabParts.push(m);
    });

    /* ---------- Baukran ---------- */
    const crane = new T.Group(); crane.position.set(-12.5, 0, -9.5); scene.add(crane);
    const MAST_H = 17.5, JIB = 21, CJIB = 7;
    (function () {
      const lat = [];
      const add = (g, x, y, z, rx, ry, rz) => { g.rotateX(rx || 0); g.rotateY(ry || 0); g.rotateZ(rz || 0); g.translate(x, y, z); lat.push(g); };
      const s = 0.8;
      [[-s, -s], [s, -s], [-s, s], [s, s]].forEach(([x, z]) => add(new T.BoxGeometry(0.12, MAST_H, 0.12), x, MAST_H / 2, z));
      const da = Math.atan2(2 * s, 1.6), dl = Math.hypot(2 * s, 1.6);
      for (let y = 0.5; y < MAST_H; y += 1.6) {
        add(new T.BoxGeometry(2 * s, 0.07, 0.07), 0, y, -s); add(new T.BoxGeometry(2 * s, 0.07, 0.07), 0, y, s);
        add(new T.BoxGeometry(0.07, 0.07, 2 * s), -s, y, 0); add(new T.BoxGeometry(0.07, 0.07, 2 * s), s, y, 0);
        add(new T.BoxGeometry(0.05, dl, 0.05), 0, y + 0.8, -s, 0, 0, da);
        add(new T.BoxGeometry(0.05, dl, 0.05), 0, y + 0.8, s, 0, 0, -da);
        add(new T.BoxGeometry(0.05, dl, 0.05), -s, y + 0.8, 0, da, 0, 0);
        add(new T.BoxGeometry(0.05, dl, 0.05), s, y + 0.8, 0, -da, 0, 0);
      }
      const mast = new T.Mesh(mergeGeos(lat), M.crane); mast.castShadow = true; crane.add(mast);
      const base = new T.Mesh(rbox(3.4, 0.9, 3.4, 0.05), M.concretePlain); base.position.y = 0.45; base.castShadow = base.receiveShadow = true; crane.add(base);
    })();
    const slew = new T.Group(); slew.position.y = MAST_H; crane.add(slew);
    (function () {
      const lat = [];
      const add = (g, x, y, z, rx, ry, rz) => { g.rotateX(rx || 0); g.rotateY(ry || 0); g.rotateZ(rz || 0); g.translate(x, y, z); lat.push(g); };
      const hw = 0.45, hh = 0.9;
      [-hw, hw].forEach((z) => add(new T.BoxGeometry(JIB + CJIB, 0.1, 0.1), (JIB - CJIB) / 2, 0.4, z));
      add(new T.BoxGeometry(JIB, 0.1, 0.1), JIB / 2, 0.4 + hh, 0);
      const dl = Math.hypot(hw, hh), da = Math.atan2(hw, hh);
      for (let x = 0.5; x < JIB; x += 1.2) {
        add(new T.BoxGeometry(0.05, 0.05, 2 * hw), x, 0.4, 0);
        add(new T.BoxGeometry(0.05, dl, 0.05), x + 0.6, 0.4 + hh / 2, -hw / 2, da, 0, 0);
        add(new T.BoxGeometry(0.05, dl, 0.05), x + 0.6, 0.4 + hh / 2, hw / 2, -da, 0, 0);
      }
      add(new T.BoxGeometry(0.12, 4, 0.12), 0, 2.4, -0.45); add(new T.BoxGeometry(0.12, 4, 0.12), 0, 2.4, 0.45);
      const jib = new T.Mesh(mergeGeos(lat), M.crane); jib.castShadow = true; slew.add(jib);
      const cab = new T.Mesh(rbox(1.6, 1.6, 1.4, 0.08), M.crane); cab.position.set(1.0, -0.6, 1.3); cab.castShadow = true; slew.add(cab);
      const win = new T.Mesh(new T.PlaneGeometry(1.2, 0.9), new T.MeshPhysicalMaterial(glassParams)); win.position.set(1.81, -0.5, 1.3); win.rotation.y = Math.PI / 2; slew.add(win);
      const ballast = new T.Mesh(rbox(2.2, 1.6, 1.4, 0.04), M.concretePlain); ballast.position.set(-CJIB + 1.4, -0.3, 0); ballast.castShadow = true; slew.add(ballast);
      // Abspannseile von der Turmspitze
      [12, -CJIB + 0.5].forEach((x) => {
        const dx = x, dy = 0.4 + hh - 4.4, L = Math.hypot(dx, dy);
        const c = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, L, 4), M.cable);
        c.position.set(dx / 2, 4.4 + dy / 2, 0); c.rotation.z = Math.atan2(-dx, dy); slew.add(c);
      });
    })();
    const trolley = new T.Mesh(rbox(0.9, 0.35, 0.9, 0.04), M.craneDark); trolley.position.y = 0.2; slew.add(trolley);
    const cableGeo = new T.CylinderGeometry(0.02, 0.02, 1, 4); cableGeo.translate(0, -0.5, 0);
    const craneCable = new T.Mesh(cableGeo, M.cable); slew.add(craneCable);
    const hook = new T.Group(); scene.add(hook);
    const hookBlock = new T.Mesh(rbox(0.45, 0.55, 0.3, 0.05), M.warn); hookBlock.castShadow = true; hook.add(hookBlock);
    const hookHang = new T.Mesh(new T.TorusGeometry(0.12, 0.03, 6, 12, Math.PI * 1.4), M.metal); hookHang.position.y = -0.4; hook.add(hookHang);
    // Anschlagseile zur Last (nur sichtbar beim Tragen)
    const slings = new T.Group(); hook.add(slings);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
      const L = Math.hypot(0.9, 1.0);
      const c = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, L, 3), M.cable);
      const v = new T.Vector3(sx * 0.9, -0.95, sz * 0.9);
      c.position.copy(v).multiplyScalar(0.5).add(new T.Vector3(0, -0.45, 0));
      c.quaternion.setFromUnitVectors(Yv, v.clone().normalize());
      slings.add(c);
    });

    // Kranbewegung über Schlüsselbilder: Winkel, Laufkatze, Hakenhöhe
    const craneKeys = [];
    const cb = crane.position;
    function aim(x, z) { const dx = x - cb.x, dz = z - cb.z; return { th: Math.atan2(-dz, dx), r: Math.hypot(dx, dz) }; }
    function craneMove(t0, t1, from, to) {
      const d = t1 - t0, A = aim(from.x, from.z), B = aim(to.x, to.z), hi = Math.max(from.y, to.y) + 3.5;
      craneKeys.push({ p: t0, th: A.th, r: A.r, y: hi });
      craneKeys.push({ p: t0 + d * 0.16, th: A.th, r: A.r, y: from.y });
      craneKeys.push({ p: t0 + d * 0.34, th: A.th, r: A.r, y: hi });
      craneKeys.push({ p: t0 + d * 0.66, th: B.th, r: B.r, y: hi });
      craneKeys.push({ p: t0 + d * 0.84, th: B.th, r: B.r, y: to.y });
      craneKeys.push({ p: t1, th: B.th, r: B.r, y: hi - 1 });
      return [t0 + d * 0.16, t0 + d * 0.84];
    }
    const HANG = 1.1;
    const pickup = new T.Vector3(-11.5, 0, 2.5);
    const loads = [];
    slabParts.forEach((m, i) => {
      m.userData.start = new T.Vector3(pickup.x, 0.15 + (3 - i) * 0.22, pickup.z);
      m.position.copy(m.userData.start);
      const [t0, t1] = S(1, 0.42 + i * 0.055, 0.42 + (i + 1) * 0.055);
      m.userData.window = craneMove(t0, t1,
        { x: m.userData.start.x, y: m.userData.start.y + HANG, z: m.userData.start.z },
        { x: m.userData.final.x, y: m.userData.final.y + HANG, z: m.userData.final.z });
      trigger(m.userData.window[1], () => puff(m.userData.final.x, m.userData.final.y + 0.2, 0, 14, 3));
      loads.push(m);
    });
    // Firstpfette (Etappe 3) mit dem Kran
    const ridgeBeam = box(11.2, 0.24, 0.22, M.timberFree, 0, 0, 0, scene, { r: 0.02 });
    ridgeBeam.userData.start = new T.Vector3(-10.5, 0.62, 5.5);
    ridgeBeam.userData.final = new T.Vector3(0, FL + RH + 0.05, 0);
    ridgeBeam.position.copy(ridgeBeam.userData.start);
    ridgeBeam.userData.window = craneMove(...S(3, 0.02, 0.2), { x: -10.5, y: 0.62 + HANG, z: 5.5 }, { x: 0, y: FL + RH + 0.05 + HANG, z: 0 });
    trigger(ridgeBeam.userData.window[1], () => puff(0, FL + RH + 0.1, 0, 10, 4));
    loads.push(ridgeBeam);
    const timberPile = new T.Group(); scene.add(timberPile); timberPile.position.set(-10.5, 0, 5.5);
    for (let i = 0; i < 3; i++) box(5.5, 0.18, 0.2, M.timberFree, 0, 0.09 + i * 0.18, -0.4 + (i % 2) * 0.25, timberPile, { r: 0.015 });
    craneKeys.sort((a, b) => a.p - b.p);
    craneKeys.unshift({ p: 0, th: aim(-6, 2).th, r: 9, y: 9 });
    function craneState(p) {
      let i = 0;
      while (i < craneKeys.length - 1 && p > craneKeys[i + 1].p) i++;
      const a = craneKeys[i], b = craneKeys[Math.min(i + 1, craneKeys.length - 1)];
      const t = b.p > a.p ? easeInOut(clamp((p - a.p) / (b.p - a.p), 0, 1)) : 0;
      let dth = b.th - a.th; while (dth > Math.PI) dth -= Math.PI * 2; while (dth < -Math.PI) dth += Math.PI * 2;
      return { th: a.th + dth * t, r: lerp(a.r, b.r, t), y: lerp(a.y, b.y, t) };
    }
    function updateCrane(p) {
      const s = craneState(Math.min(p, 2.3));
      slew.rotation.y = s.th;
      trolley.position.x = s.r;
      const hx = cb.x + Math.cos(s.th) * s.r, hz = cb.z - Math.sin(s.th) * s.r;
      let carrying = false;
      loads.forEach((m) => {
        const [w0, w1] = m.userData.window;
        if (p < w0) m.position.copy(m.userData.start);
        else if (p > w1) m.position.copy(m.userData.final);
        else { m.position.set(hx, s.y - HANG, hz); carrying = true; }
      });
      hook.position.set(hx, s.y, hz);
      slings.visible = carrying;
      craneCable.position.set(s.r, 0.05, 0);
      craneCable.scale.y = Math.max(0.1, MAST_H + 0.05 - s.y - 0.3);
      // Kran fährt nach dem Dach weg (Beginn Etappe 4)
      const away = smooth(clamp((p - 3.0) / 0.25, 0, 1));
      crane.position.x = -12.5 - away * 45;
      crane.visible = hook.visible = away < 1;
      timberPile.visible = p < 3.2;
    }

    // Gerüst: wird mit dem Mauerwerk aufgebaut, nach dem Verputz abgebaut
    const scaffold = [];
    const scafGroup = new T.Group(); house.add(scafGroup);
    function sPart(geo, mat, x, y, z, level) { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; scafGroup.add(m); m.userData.level = level; scaffold.push(m); return m; }
    const poleGeo = new T.CylinderGeometry(0.03, 0.03, 4.9, 6); poleGeo.translate(0, 2.45, 0);
    const poleGeoL = new T.CylinderGeometry(0.03, 0.03, 6.8, 6); poleGeoL.translate(0, 3.4, 0);
    [-5.9, -3.9, -1.9, 0.1, 2.1, 4.1, 5.9].forEach((x) => [4.95, 5.6].forEach((z) => sPart(poleGeo, M.steel, x, -FL, z, 0)));
    [-3.2, -1.2, 0.8, 2.8].forEach((z) => [-5.95, -6.6].forEach((x) => sPart(poleGeoL, M.steel, x, -FL, z, 0)));
    [1.4, 2.9, 4.4].forEach((y, li) => {
      sPart(rbox(11.8, 0.05, 0.6, 0.01), M.board, 0, y, 5.28, li + 1);
      sPart(new T.BoxGeometry(11.8, 0.04, 0.04), M.steel, 0, y + 1, 5.62, li + 1);
      sPart(new T.BoxGeometry(11.8, 0.14, 0.02), M.warn, 0, y + 0.08, 5.6, li + 1);
      sPart(rbox(0.6, 0.05, 7.0, 0.01), M.board, -6.28, y, 0, li + 1);
      sPart(new T.BoxGeometry(0.04, 0.04, 7.0), M.steel, -6.62, y + 1, 0, li + 1);
    });
    scaffold.forEach((m, i) => {
      const lvl = m.userData.level;
      const a = lvl === 0 ? 0.1 + (i % 22) * 0.008 : 0.2 + lvl * 0.07;
      const b = a + (lvl === 0 ? 0.08 : 0.06);
      const [t0, t1] = S(1, a, b);
      const off = (3 - lvl) * 0.03 + (i % 5) * 0.004;
      const [r0, r1] = S(2, 0.84 + off, 0.9 + off);
      const y0 = m.position.y;
      m.visible = false;
      at(t0, r1, (t) => {
        const p = lerp(t0, r1, t);
        const up = clamp((p - t0) / (t1 - t0), 0, 1), down = clamp((p - r0) / (r1 - r0), 0, 1);
        const s = Math.max(0.0001, easeOut(up) * (1 - easeInOut(down)));
        if (lvl === 0) m.scale.y = s; else { m.scale.setScalar(s); m.position.y = y0 + down * 0.8; }
        m.visible = up > 0 && down < 1;
      });
    });

    // Palette mit Backsteinen
    const pallet = new T.Group(); scene.add(pallet); pallet.position.set(-8.4, 0, 6.6);
    box(1.2, 0.14, 1.0, M.oakDark, 0, 0.07, 0, pallet);
    box(1.1, 0.8, 0.9, pbr('backstein', {}, 1, 1.2), 0, 0.55, 0, pallet, { r: 0.01 });
    box(0.7, 0.18, 0.45, M.fabricLight, 1.2, 0.09, 0.2, pallet, { r: 0.06 });
    at(...S(2, 0.9, 0.98), (t) => { pallet.position.y = -t * 2; pallet.visible = t < 1; });

    /* =========================================================
       Etappe 2: Fassade
       ========================================================= */
    wallMeshes('front', -5 - INS, 5 + INS, -0.05, 0, INS, M.insF);
    wallMeshes('back', -5 - INS, 5 + INS, -0.05, 0, INS, M.ins);
    wallMeshes('left', -4 - INS, 4 + INS, -0.05, 0, INS, M.ins, INS);
    wallMeshes('right', -4 - INS, 4 + INS, -0.05, 0, INS, M.ins, INS);
    uniformTo(R.ins, ...S(2, 0.03, 0.3), 0, 1); uniformTo(R.insF, ...S(2, 0.03, 0.3), 0, 1);
    const pe = INS + PL;
    wallMeshes('front', -5 - pe, 5 + pe, 0.35, INS, PL, M.plasF);
    wallMeshes('back', -5 - pe, 5 + pe, 0.35, INS, PL, M.plas);
    wallMeshes('left', -4 - pe, 4 + pe, 0.35, INS, PL, M.plas, pe);
    wallMeshes('right', -4 - pe, 4 + pe, 0.35, INS, PL, M.plas, pe);
    uniformTo(R.plas, ...S(2, 0.32, 0.62), 0, 1); uniformTo(R.plasF, ...S(2, 0.32, 0.62), 0, 1);
    colorTo(M.plas.color, ...S(2, 0.62, 0.74), 0xd6d0c4, 0xf3eee5);
    colorTo(M.plasF.color, ...S(2, 0.62, 0.74), 0xd6d0c4, 0xf3eee5);
    for (const k in WALLS) {
      const w = WALLS[k], L = w.gable ? 4 + pe : 5 + pe;
      const doors = OPEN[k].filter((o) => o[2] === 0);
      const parts = doors.length ? [[-L, doors[0][0]], [doors[0][1], L]] : [[-L, L]];
      parts.forEach(([a, b]) => {
        const m = box(b - a, 0.68, 0.045, k === 'front' ? M.plinthF : M.plinth, (a + b) / 2, 0.04, INS + 0.022, w.group, { r: 0.012 });
        slide(m, 2, 0.62, 0.74, 0, -0.7, 0);
      });
    }
    // Fenster: Rahmen, spiegelndes Glas, Fensterbank
    const windowsList = [], windowGlass = [];
    for (const k in WALLS) {
      const w = WALLS[k], isF = k === 'front';
      OPEN[k].forEach((o) => {
        if (o[2] === 0) return;
        const g = new T.Group(); w.group.add(g);
        const [u0, u1, v0, v1] = o, cw = u1 - u0, ch = v1 - v0;
        g.position.set((u0 + u1) / 2, (v0 + v1) / 2, -0.03);
        const fm = isF ? M.frameF : M.frame;
        const f = 0.075, d = 0.11;
        box(cw, f, d, fm, 0, ch / 2 - f / 2, 0, g, { r: 0.012, uv: false });
        box(cw, f, d, fm, 0, -ch / 2 + f / 2, 0, g, { r: 0.012, uv: false });
        box(f, ch, d, fm, -cw / 2 + f / 2, 0, 0, g, { r: 0.012, uv: false });
        box(f, ch, d, fm, cw / 2 - f / 2, 0, 0, g, { r: 0.012, uv: false });
        if (cw > 1.5) box(f * 0.9, ch, d * 0.8, fm, 0, 0, 0, g, { r: 0.01, uv: false });
        const gm = new T.MeshPhysicalMaterial(Object.assign({}, glassParams, isF ? { clippingPlanes: [planes.front] } : {}));
        const gl = new T.Mesh(new T.PlaneGeometry(cw - f, ch - f), gm); gl.position.z = 0.01; g.add(gl);
        windowGlass.push(gm);
        box(cw + 0.12, 0.035, INS + PL + 0.1, isF ? M.sillF : M.sill, 0, -ch / 2 - 0.02, (INS + PL) / 2 + 0.05, g, { r: 0.008, uv: false });
        windowsList.push(g);
      });
    }
    stagger(windowsList, 2, 0.62, 0.9, (o, k, a, b) => pop(o, k, a, b, spring), 2.5);

    /* =========================================================
       Etappe 3: Zimmermann / Dach
       ========================================================= */
    const rafterH = 0.24, over = 0.6;
    const yTopAt = (z) => RH + 0.32 - SLOPE * Math.abs(z);
    const slopeLen = (4 + over) / Math.cos(ANG);
    // Balken schweben einzeln an ihren Platz
    function floatIn(obj, k, a, b, from) {
      const [t0, t1] = S(k, a, b);
      const p0 = obj.position.clone(), r0 = obj.rotation.clone();
      obj.visible = false;
      at(t0, t1, (t) => {
        const e = easeInOut(t), inv = 1 - e;
        obj.position.set(p0.x + from.x * inv, p0.y + from.y * inv + Math.sin(e * Math.PI) * 0.3, p0.z + from.z * inv);
        obj.rotation.set(r0.x + (from.rx || 0) * inv, r0.y + (from.ry || 0) * inv, r0.z + (from.rz || 0) * inv);
        obj.visible = t > 0;
      });
      trigger(t1 - 0.004, () => { const wp = obj.getWorldPosition(tmpV); puff(wp.x, wp.y, wp.z, 4, 1.2); });
    }
    [-1, 1].forEach((sgn, i) => {
      const fp = box(10.2, 0.16, 0.2, M.timber, 0, EH + 0.08, sgn * 3.85, house, { r: 0.02 });
      floatIn(fp, 3, 0.16 + i * 0.03, 0.26 + i * 0.03, { x: -3, y: 4, z: sgn * 2, ry: 0.4 });
      const mp = box(11.2, 0.2, 0.16, M.timber, 0, yTopAt(2) - 0.3, sgn * 2, house, { r: 0.02 });
      floatIn(mp, 3, 0.2 + i * 0.03, 0.3 + i * 0.03, { x: 3, y: 4, z: sgn * 2, ry: -0.4 });
    });
    const rafters = [];
    for (let i = 0; i <= 12; i++) {
      const x = -5.4 + i * 0.9;
      [-1, 1].forEach((sgn) => {
        const r = mesh(rbox(0.1, rafterH, slopeLen, 0.015), M.timber);
        const zc = sgn * (4 + over) / 2;
        r.position.set(x, yTopAt(zc) - rafterH / 2 / Math.cos(ANG), zc);
        r.rotation.x = sgn * ANG;
        rafters.push(r);
      });
    }
    stagger(rafters, 3, 0.24, 0.58, (o, k, a, b, i) => floatIn(o, k, a, b,
      { x: (i % 2 ? 1 : -1) * 1.5, y: 3.5 + (i % 3) * 0.4, z: (o.position.z > 0 ? 3 : -3), rx: (o.position.z > 0 ? -0.5 : 0.5), rz: 0.25 }), 4);
    // Schalung + Ziegel (Reihe für Reihe)
    [-1, 1].forEach((sgn) => {
      const zc = sgn * (4 + over) / 2;
      const dk = mesh(worldUV(new T.BoxGeometry(11.0, 0.03, slopeLen)), M.deck);
      dk.position.set(0, yTopAt(zc) + 0.015 / Math.cos(ANG), zc); dk.rotation.x = sgn * ANG;
      const t = mesh(worldUV(new T.BoxGeometry(11.0, 0.07, slopeLen + 0.05)), M.tiles);
      t.position.set(0, yTopAt(zc) + 0.07 / Math.cos(ANG), zc); t.rotation.x = sgn * ANG;
      [-5.52, 5.52].forEach((x) => { const v = box(0.04, 0.3, slopeLen + 0.05, M.verge, x, yTopAt(zc) - 0.05, zc); v.rotation.x = sgn * ANG; growY(v, 3, 0.86, 0.92); });
    });
    uniformTo(R.deck, ...S(3, 0.5, 0.66), 0, 1);
    uniformTo(R.tiles, ...S(3, 0.62, 0.9), 0, 1);
    // Firstziegel + Kaminabdeckung
    const ridge = new T.Mesh(new T.CylinderGeometry(0.17, 0.17, 11.1, 14, 1, false, 0, Math.PI), M.ridge);
    ridge.rotation.set(0, 0, Math.PI / 2); ridge.position.set(0, RH + 0.4, 0); ridge.castShadow = true; house.add(ridge);
    pop(ridge, 3, 0.88, 0.95, spring);
    const chimCap = new T.Group(); chimCap.position.set(2.4, RH + 1.15, -1.9); house.add(chimCap);
    box(0.78, 0.08, 0.78, M.concretePlain, 0, 0.04, 0, chimCap, { r: 0.01 });
    box(0.5, 0.06, 0.5, M.metal, 0, 0.32, 0, chimCap, { r: 0.01, uv: false });
    [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].forEach(([x, z]) => box(0.04, 0.24, 0.04, M.metal, x, 0.18, z, chimCap, { uv: false }));
    pop(chimCap, 3, 0.9, 0.97, spring);
    // Dachrinnen + Fallrohre
    [-1, 1].forEach((sgn) => {
      const z = sgn * (4 + over - 0.02);
      const gu = new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 11.1, 12, 1, true, 0, Math.PI), M.gutter);
      gu.rotation.set(0, 0, -Math.PI / 2); gu.position.set(0, yTopAt(z) - 0.12, z + sgn * 0.04); gu.castShadow = true; house.add(gu);
      slide(gu, 3, 0.88, 0.96, 0, -0.6, 0);
      const dpH = yTopAt(z) - 0.3 + FL;
      const dpg = new T.CylinderGeometry(0.05, 0.05, dpH, 10); dpg.translate(0, dpH / 2 + 0.15, 0);
      const dp = new T.Mesh(dpg, M.gutter); dp.position.set(-5.3, -FL, z + sgn * 0.04); dp.castShadow = true; house.add(dp);
      const shoe = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.3, 10), M.gutter); shoe.position.set(0, 0.12, sgn * 0.1); shoe.rotation.x = sgn * 1.0; dp.add(shoe);
      growY(dp, 3, 0.9, 0.98);
      for (let x = -5; x <= 5; x += 1.25) { const hk = box(0.03, 0.03, 0.2, M.gutter, x, yTopAt(z) - 0.16, z + sgn * 0.02, house, { uv: false }); slide(hk, 3, 0.86, 0.94, 0, -0.6, 0); }
    });
    // Holzschalung der Giebelfelder
    ['left', 'right'].forEach((k) => {
      const s = new T.Shape(), e = pe + 0.03;
      s.moveTo(-4 - e, EH); s.lineTo(4 + e, EH); s.lineTo(0, RH + 0.1); s.closePath();
      const o = OPEN[k][1], h = new T.Path();
      h.moveTo(o[0] - 0.05, o[2] - 0.05); h.lineTo(o[0] - 0.05, o[3] + 0.05); h.lineTo(o[1] + 0.05, o[3] + 0.05); h.lineTo(o[1] + 0.05, o[2] - 0.05); h.closePath();
      s.holes.push(h);
      mesh(extrude(s, 0.04, pe), M.clad, WALLS[k].group);
    });
    uniformTo(R.clad, ...S(3, 0.66, 0.9), 0, 1);

    /* =========================================================
       Etappe 4: Elektrik
       ========================================================= */
    const wires = [];
    const wireRoot = new T.Group(); house.add(wireRoot);
    const wireU = { uTime: { value: 0 }, uFade: { value: 1 } };
    function wireMat(len) {
      return new T.ShaderMaterial({
        uniforms: { uTime: wireU.uTime, uFade: wireU.uFade, uLen: { value: len }, uGrow: { value: 0 } },
        vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform float uTime, uFade, uLen, uGrow; varying float vY;
          void main(){ float s = vY * uLen;
            float pulse = pow(0.5 + 0.5 * sin(s * 3.0 - uTime * 9.0), 8.0);
            float tip = smoothstep(0.82, 1.0, vY) * (1.0 - step(0.999, uGrow));
            vec3 c = vec3(1.0, 0.78, 0.12) * (1.2 + pulse * 2.2) + vec3(1.0) * tip * 3.0;
            gl_FragColor = vec4(c, uFade);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true
      });
    }
    const glowMat = new T.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false });
    function wire(a, b) {
      const va = new T.Vector3().fromArray(a), vb = new T.Vector3().fromArray(b);
      const dir = vb.clone().sub(va), len = dir.length();
      const g1 = new T.CylinderGeometry(0.02, 0.02, 1, 6); g1.translate(0, 0.5, 0);
      const g2 = new T.CylinderGeometry(0.06, 0.06, 1, 8); g2.translate(0, 0.5, 0);
      const grp = new T.Group(); grp.position.copy(va); grp.quaternion.setFromUnitVectors(Yv, dir.clone().normalize());
      const mat = wireMat(len);
      grp.add(new T.Mesh(g1, mat)); grp.add(new T.Mesh(g2, glowMat));
      grp.userData = { len, mat, a: va, dir: dir.normalize(), growing: false };
      grp.scale.y = 0.0001; grp.visible = false;
      wireRoot.add(grp); wires.push(grp);
    }
    const zb = -3.7 + 0.03, yc = 2.77;
    const fuse = box(0.5, 0.65, 0.12, M.fuse, -0.4, 1.55, zb + 0.04, house, { r: 0.02, uv: false });
    pop(fuse, 4, 0.16, 0.24, spring);
    [
      [[-0.4, 1.88, zb], [-0.4, 2.55, zb]], [[-0.4, 2.55, zb], [-4.4, 2.55, zb]], [[-2.3, 2.55, zb], [-2.3, 1.1, zb]],
      [[-4.4, 2.55, zb], [-4.4, 1.1, zb]], [[-0.4, 2.55, zb], [4.5, 2.55, zb]], [[1.2, 2.55, zb], [1.2, 0.3, zb]],
      [[4.5, 2.55, zb], [4.5, 0.3, zb]], [[-0.4, 2.55, zb], [-0.4, yc, zb]], [[-0.4, yc, zb], [-0.4, yc, -1.0]],
      [[-0.4, yc, -1.0], [-2.8, yc, -1.0]], [[-0.4, yc, -1.0], [2.0, yc, -1.0]], [[2.0, yc, -1.0], [2.0, yc, 0.4]],
      [[-0.4, yc, -1.0], [-0.4, yc, 2.6]], [[-0.4, yc, 2.6], [-0.85, yc, 2.6]], [[-0.85, yc, 2.6], [-0.85, 1.1, 2.6]],
      [[-0.15, 1.88, zb], [-0.15, 3.45, zb]], [[-0.15, 3.45, zb], [-4.4, 3.45, zb]], [[-0.15, 3.45, zb], [3.0, 3.45, zb]],
      [[2.6, 3.45, zb], [2.6, 4.2, zb]], [[2.6, 4.2, zb], [2.6, 4.2 + SLOPE * 2.6, -1.1]], [[-4.4, 3.45, zb], [-4.4, 3.3, zb]]
    ].forEach((s) => wire(s[0], s[1]));
    wires.forEach((wg, i) => {
      const a = 0.24 + 0.46 * (i / wires.length), b = a + 0.1;
      at(...S(4, a, b), (t) => {
        wg.scale.y = Math.max(0.0001, wg.userData.len * easeOut(t)); wg.visible = t > 0;
        wg.userData.mat.uniforms.uGrow.value = t;
        wg.userData.growing = t > 0 && t < 1;
      });
    });
    at(...S(5, 0.06, 0.34), (t) => { wireU.uFade.value = 1 - t; glowMat.opacity = 0.22 * (1 - t); wireRoot.visible = t < 1; });

    // Lampen (flackern beim Einschalten)
    const lamps = [];
    [[-2.8, 2.78, -1.0, 0.7], [2.0, 2.78, 0.4, 0.7], [2.6, 4.2 + SLOPE * 2.6 - 0.05, -1.1, 0.6]].forEach(([x, y, z, dr]) => {
      const g = new T.Group(); g.position.set(x, y, z); house.add(g);
      const cord = new T.Mesh(new T.CylinderGeometry(0.008, 0.008, dr, 4), M.lampShade); cord.position.y = -dr / 2; g.add(cord);
      const shade = new T.Mesh(new T.ConeGeometry(0.22, 0.24, 24, 1, true), M.lampShade); shade.position.y = -dr; shade.castShadow = true; g.add(shade);
      const bulbMat = M.bulb.clone();
      const bulb = new T.Mesh(new T.SphereGeometry(0.07, 14, 10), bulbMat); bulb.position.y = -dr - 0.08; g.add(bulb);
      const light = new T.PointLight(0xffc678, 0, 10, 1.7); light.position.y = -dr - 0.18; g.add(light);
      lamps.push({ g, light, bulbMat, flick: null });
      slide(g, 4, 0.6, 0.72, 0, 0.6, 0, spring);
    });
    const LAMP_ON = 3.78;
    trigger(LAMP_ON, () => { lamps.forEach((l, i) => { l.flick = -i * 0.18; const wp = l.g.getWorldPosition(tmpV); burst(wp.x, wp.y - 0.75, wp.z, 14); }); });
    const FLICK = [[0, 1], [0.05, 0], [0.1, 0.9], [0.16, 0], [0.3, 1], [0.36, 0.25], [0.44, 1], [0.5, 0.6], [0.56, 1]];
    function lampLevel(l, p) {
      if (p < LAMP_ON) return 0;
      if (l.flick !== null) {
        if (l.flick < 0) return 0;
        let v = 0; for (const f of FLICK) if (l.flick >= f[0]) v = f[1]; return v;
      }
      return 1;
    }

    /* =========================================================
       Etappe 5: Innenausbau & Maler
       ========================================================= */
    wallMeshes('back', -4.7, 4.7, 0, -T_W - 0.02, 0.02, M.intp);
    wallMeshes('left', -3.7, 3.7, 0, -T_W - 0.02, 0.02, M.intp);
    wallMeshes('right', -3.7, 3.7, 0, -T_W - 0.02, 0.02, M.intp);
    innerWall(-1, 0, 2.79, [1.2, 2.1, 2.1], 0.19, M.intp);
    innerWall(0.6, 3.0, 'roof', null, 0.12, M.intp); // Leichtbauwand OG
    box(9.4, 0.02, 7.4, M.intp, 0, 2.785, 0, house, { r: 0 });
    [-1, 1].forEach((sgn) => {
      const c = mesh(worldUV(new T.BoxGeometry(9.4, 0.02, 3.7 / Math.cos(ANG))), M.intpRoof);
      c.position.set(0, yTopAt(sgn * 1.85) - rafterH / Math.cos(ANG) - 0.03, sgn * 1.85); c.rotation.x = sgn * ANG;
    });
    planes.intp.constant = FL - 0.05;
    at(...S(5, 0.04, 0.34), (t) => { planes.intp.constant = lerp(FL - 0.05, FL + RH + 0.5, smooth(t)); });
    at(...S(5, 0.34, 0.6), (t) => { R.paint.set(t); R.paintRoof.set(t); });
    box(9.4, 0.03, 7.4, M.parquet, 0, 0.015, 0, house, { r: 0 });
    const upFloor = rect(-4.7, 4.7, -3.7, 3.7);
    const hole = new T.Path(); hole.moveTo(3.58, -1.0); hole.lineTo(3.58, 2.65); hole.lineTo(4.69, 2.65); hole.lineTo(4.69, -1.0); hole.closePath();
    upFloor.holes.push(hole);
    const ufg = new T.ExtrudeGeometry(upFloor, { depth: 0.03, bevelEnabled: false }); ufg.rotateX(-Math.PI / 2); ufg.translate(0, 3.0, 0);
    mesh(worldUV(ufg), M.parquet);
    uniformTo(R.floor, ...S(5, 0.58, 0.9), 0, 1);
    [[-2.3, 1.1, zb + 0.025], [-4.4, 1.1, zb + 0.025], [1.2, 0.3, zb + 0.025], [4.5, 0.3, zb + 0.025], [-0.4, 1.1, zb + 0.025], [-0.9, 1.1, 2.6, 1]].forEach(([x, y, z, side]) => {
      const p = box(side ? 0.02 : 0.09, 0.09, side ? 0.09 : 0.02, M.white, side ? -0.88 : x, y, z, house, { uv: false, shadow: false, r: 0.005 });
      pop(p, 5, 0.88, 0.95, spring);
    });

    /* =========================================================
       Etappe 6: Schreiner (fährt mit leichtem Federn ein)
       ========================================================= */
    for (let i = 0; i < 4; i++) {
      const g = new T.Group(); g.position.set(-4.35 + i * 0.66, 0, -3.38); house.add(g);
      box(0.62, 0.82, 0.6, M.cabinet, 0, 0.45, 0, g, { r: 0.015 });
      box(0.58, 0.74, 0.02, M.oak, 0, 0.47, 0.31, g, { r: 0.006 });
      box(0.3, 0.02, 0.02, M.metal, 0, 0.78, 0.33, g, { uv: false, r: 0.005 });
      slide(g, 6, 0.04 + i * 0.035, 0.24 + i * 0.035, 0, 0, 1.8, spring);
    }
    slide(box(2.66, 0.04, 0.64, M.counter, -3.34, 0.88, -3.36, house, { uv: false, r: 0.01 }), 6, 0.22, 0.34, 0, 1.2, 0, spring);
    [0, 1].forEach((i) => slide(box(0.62, 0.72, 0.36, M.oak, -4.35 + i * 0.66, 1.85, -3.5, house, { r: 0.012 }), 6, 0.26 + i * 0.04, 0.42 + i * 0.04, 0, 0.8, 0, spring));
    slide(box(0.62, 2.2, 0.6, M.oak, -1.45, 1.11, -3.38, house, { r: 0.015 }), 6, 0.3, 0.46, 0, 0, 1.5, spring);
    const island = new T.Group(); island.position.set(-3.0, 0, -1.1); house.add(island);
    box(1.8, 0.9, 0.8, M.cabinet, 0, 0.46, 0, island, { r: 0.02 });
    box(1.9, 0.04, 0.9, M.counter, 0, 0.93, 0, island, { uv: false, r: 0.01 });
    box(1.8, 0.86, 0.02, M.oak, 0, 0.46, 0.41, island, { r: 0.005 });
    slide(island, 6, 0.34, 0.52, 0, 0, 2.2, spring);
    const table = new T.Group(); table.position.set(-3.0, 0, 1.6); house.add(table);
    box(1.8, 0.05, 0.9, M.oak, 0, 0.75, 0, table, { r: 0.015 });
    [[-0.8, -0.38], [0.8, -0.38], [-0.8, 0.38], [0.8, 0.38]].forEach(([x, z]) => box(0.06, 0.72, 0.06, M.oak, x, 0.36, z, table, { r: 0.01 }));
    pop(table, 6, 0.5, 0.64, spring);
    const steps = [];
    for (let i = 0; i < 14; i++) {
      const g = new T.Group(); g.position.set(4.15, 0.2 * (i + 1), 2.0 - i * 0.33); house.add(g);
      box(1.0, 0.05, 0.34, M.oak, 0, 0, 0, g, { r: 0.012 });
      box(1.0, 0.2, 0.02, M.oakDark, 0, -0.1, 0.16, g, { r: 0.004 });
      steps.push(g);
    }
    stagger(steps, 6, 0.36, 0.62, (o, k, a, b) => slide(o, k, a, b, 0, 1.2, 0, spring), 3);
    const stringer = mesh(rbox(0.06, 0.3, 5.4, 0.015), M.oakDark);
    stringer.rotation.x = Math.atan(0.2 / 0.33); stringer.position.set(3.62, 1.35, -0.15);
    pop(stringer, 6, 0.6, 0.66);
    const doorPivot = new T.Group(); doorPivot.position.set(-1.0, 0, 1.2); house.add(doorPivot);
    box(0.04, 2.08, 0.9, M.oak, 0, 1.04, 0.45, doorPivot, { r: 0.01 });
    box(0.06, 0.03, 0.12, M.metal, 0.04, 1.05, 0.8, doorPivot, { uv: false });
    at(...S(6, 0.6, 0.78), (t) => { doorPivot.visible = t > 0; doorPivot.scale.y = Math.max(0.0001, spring(Math.min(1, t * 2))); doorPivot.rotation.y = -smooth(clamp(t * 1.4 - 0.4, 0, 1)) * 1.2; });
    const wardrobe = new T.Group(); wardrobe.position.set(-4.35, 3.0, -0.6); house.add(wardrobe);
    box(0.6, 2.1, 2.4, M.white, 0, 1.05, 0, wardrobe, { r: 0.015, uv: false });
    [-0.8, 0, 0.8].forEach((z) => box(0.02, 2.0, 0.76, M.oak, 0.31, 1.05, z, wardrobe, { r: 0.005 }));
    slide(wardrobe, 6, 0.62, 0.8, 1.6, 0, 0, spring);
    const doorO = OPEN.front[1];
    const fd = box(doorO[1] - doorO[0] - 0.04, doorO[3] - 0.02, 0.07, M.door, (doorO[0] + doorO[1]) / 2, doorO[3] / 2, -0.06, WALLS.front.group, { r: 0.012 });
    box(0.04, 0.6, 0.04, M.frameF, doorO[0] + 0.15, 1.1, 0.0, WALLS.front.group, { uv: false, r: 0.01 });
    pop(fd, 6, 0.82, 0.92, spring);
    slide(box(2.0, 0.09, 1.1, M.frameF, (doorO[0] + doorO[1]) / 2, 2.55, 0.55 + pe, WALLS.front.group, { uv: false, r: 0.02 }), 6, 0.86, 0.96, 0, 0, 1.5, spring);

    /* =========================================================
       Etappe 7: Garten & Umgebung
       ========================================================= */
    const groundGeo = new T.PlaneGeometry(240, 240, 1, 1); groundGeo.rotateX(-Math.PI / 2);
    const guv = groundGeo.attributes.uv.array; for (let i = 0; i < guv.length; i++) guv[i] *= 240;
    const ground = new T.Mesh(groundGeo, M.ground); ground.receiveShadow = true; scene.add(ground);
    // Fake-Schatten: weiche dunkle Fläche unter dem Haus (statt echter Schatten)
    const fsCanvas = document.createElement('canvas'); fsCanvas.width = fsCanvas.height = 128;
    const fsg = fsCanvas.getContext('2d');
    const fsGrad = fsg.createRadialGradient(64, 64, 10, 64, 64, 64);
    fsGrad.addColorStop(0, 'rgba(0,0,0,0.55)'); fsGrad.addColorStop(0.6, 'rgba(0,0,0,0.35)'); fsGrad.addColorStop(1, 'rgba(0,0,0,0)');
    fsg.fillStyle = fsGrad; fsg.fillRect(0, 0, 128, 128);
    const fakeShadow = new T.Mesh(new T.PlaneGeometry(17, 15), new T.MeshBasicMaterial({ map: new T.CanvasTexture(fsCanvas), transparent: true, depthWrite: false }));
    fakeShadow.rotation.x = -Math.PI / 2; fakeShadow.position.set(0.6, 0.06, 0.4); fakeShadow.renderOrder = 1;
    scene.add(fakeShadow);
    at(...S(7, 0.04, 0.5), (t) => { grassU.uGrass.value = t; });
    const gravel = new T.Mesh(rbox(11.4, 0.05, 9.4, 0.02), new T.MeshStandardMaterial({ map: tex('stein', 'color', 3), normalMap: tex('stein', 'normal', 3), color: 0xd8d2c4, roughness: 1 }));
    worldUV(gravel.geometry); gravel.position.y = 0.025; gravel.receiveShadow = true; scene.add(gravel);
    pop(gravel, 7, 0.08, 0.2, easeOut);
    const doorX = (doorO[0] + doorO[1]) / 2;
    const entrance = new T.Group(); scene.add(entrance); entrance.position.set(doorX, 0, 4.3 + pe);
    box(1.8, 0.15, 0.9, M.concretePlain, 0, 0.075, 0.25, entrance, { r: 0.015 });
    box(1.8, 0.15, 0.6, M.concretePlain, 0, 0.225, 0.1, entrance, { r: 0.015 });
    pop(entrance, 7, 0.14, 0.24, spring);
    const slabs = [];
    for (let i = 0; i < 6; i++) slabs.push(box(1.2, 0.06, 0.7, M.stone, doorX, 0.04, 5.6 + i * 0.85, scene, { r: 0.02 }));
    stagger(slabs, 7, 0.18, 0.46, (o, k, a, b) => slide(o, k, a, b, 0, 0.8, 0, spring), 2.5);
    const deck = new T.Group(); deck.position.set(7.3, 0, -0.5); scene.add(deck);
    const deckBoards = [];
    for (let i = 0; i < 12; i++) deckBoards.push(box(3.6, 0.08, 0.36, M.oak, 0, 0.25, -2.6 + i * 0.4, deck, { r: 0.01 }));
    const deckBase = box(3.6, 0.2, 4.8, M.concretePlain, 0, 0.1, -0.4, deck, { r: 0.01 });
    pop(deckBase, 7, 0.2, 0.26, easeOut);
    stagger(deckBoards, 7, 0.24, 0.48, (o, k, a, b) => slide(o, k, a, b, 0, 0.6, 0, spring), 3);

    // Graspolster wachsen aus dem Boden (Instanzen, Anzahl je nach Leistung)
    const GRASS_MAX = 1300;
    const bladeGeo = (function () {
      const g = new T.BufferGeometry(), pos = [], col = [];
      for (let b = 0; b < 5; b++) {
        const a = (b / 5) * Math.PI * 2 + rand(), r = 0.06, h = 0.18 + rand() * 0.16, lean = 0.06;
        const x = Math.cos(a) * r, z = Math.sin(a) * r, tx = Math.cos(a + 1.57) * 0.025, tz = Math.sin(a + 1.57) * 0.025;
        pos.push(x - tx, 0, z - tz, x + tx, 0, z + tz, x + Math.cos(a) * lean, h, z + Math.sin(a) * lean);
        col.push(0.12, 0.22, 0.06, 0.12, 0.22, 0.06, 0.45, 0.62, 0.22);
      }
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      return g;
    })();
    const grassMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: T.DoubleSide });
    const tuftU = { uGrow: { value: 0 } };
    grassMat.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, tuftU);
      s.vertexShader = 'attribute float aDelay; uniform float uGrow;\n' + s.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n float gg = clamp(uGrow * 1.5 - aDelay, 0.0, 1.0); transformed.y *= gg; transformed.xz *= mix(0.3, 1.0, gg);');
    };
    grassMat.customProgramCacheKey = () => 'tufts';
    const tufts = new T.InstancedMesh(bladeGeo, grassMat, GRASS_MAX);
    const delays = new Float32Array(GRASS_MAX);
    const mtx = new T.Matrix4(), q = new T.Quaternion(), p3 = new T.Vector3(), s3 = new T.Vector3();
    let placed = 0;
    while (placed < GRASS_MAX) {
      const x = (rand() - 0.5) * 34, z = (rand() - 0.5) * 30 + 2;
      if (Math.abs(x) < 6 && Math.abs(z) < 5) continue;
      if (Math.abs(x - doorX) < 0.9 && z > 4 && z < 10.6) continue;
      if (x > 5.3 && x < 9.3 && z > -3.2 && z < 2.2) continue;
      if (z > 10.4) continue;
      const s = 0.8 + rand() * 0.9;
      mtx.compose(p3.set(x, 0, z), q.setFromAxisAngle(Yv, rand() * 6.28), s3.set(s, s, s));
      tufts.setMatrixAt(placed, mtx);
      delays[placed] = Math.hypot(x, z - 3) / 20 + rand() * 0.15;
      placed++;
    }
    bladeGeo.setAttribute('aDelay', new T.InstancedBufferAttribute(delays, 1));
    tufts.receiveShadow = true; tufts.frustumCulled = false; tufts.visible = false;
    scene.add(tufts);
    at(...S(7, 0.08, 0.6), (t) => { tuftU.uGrow.value = t; tufts.visible = t > 0; });

    // Bäume wachsen aus dem Boden
    function crownGeo(r, detail, seed) {
      const g = new T.IcosahedronGeometry(r, detail);
      const p = g.attributes.position, col = new Float32Array(p.count * 3), nor = g.attributes.normal;
      const v = new T.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        tmpV.copy(v).normalize(); nor.setXYZ(i, tmpV.x, tmpV.y, tmpV.z); // weiche Normalen
        const n = Math.sin(v.x * 2.1 + seed) * Math.cos(v.y * 1.7 + seed * 2) * Math.sin(v.z * 2.3 + seed * 3);
        v.multiplyScalar(1 + n * 0.16 + Math.sin(v.x * 7 + v.z * 5 + seed) * 0.04);
        p.setXYZ(i, v.x, v.y, v.z);
        const shade = 0.55 + 0.45 * clamp((v.y / r + 1) / 2, 0, 1);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      return g;
    }
    const leafMats = [0x4f7a3a, 0x3f6a34, 0x6b8f3e, 0x557f3a].map((c) => new T.MeshStandardMaterial({ color: c, vertexColors: true, roughness: 0.85 }));
    const trees = [];
    function tree(x, z, s, conifer, mi) {
      const g = new T.Group(); g.position.set(x, 0, z); scene.add(g);
      const trunkG = new T.CylinderGeometry(0.1 * s, 0.2 * s, 2.6 * s, 9); trunkG.translate(0, 1.3 * s, 0);
      const tr = new T.Mesh(trunkG, M.trunk); tr.castShadow = true; g.add(tr);
      const crowns = new T.Group(); crowns.position.y = (conifer ? 1.4 : 2.6) * s; g.add(crowns);
      if (conifer) {
        for (let i = 0; i < 4; i++) {
          const c = new T.Mesh(new T.ConeGeometry((1.7 - i * 0.36) * s, 1.9 * s, 12, 3), leafMats[1]);
          c.position.y = (0.6 + i * 0.95) * s; c.castShadow = true; crowns.add(c);
        }
      } else {
        [[0, 0.6, 0, 1.45], [0.75, 0.2, 0.3, 1.0], [-0.7, 0.3, -0.2, 1.05], [0.1, 1.3, -0.3, 0.95], [-0.2, 0.1, 0.8, 0.9]].forEach(([cx, cy, cz, r], i) => {
          const c = new T.Mesh(crownGeo(r * s, 2, i + x), leafMats[(mi + i) % 4]); c.position.set(cx * s, cy * s, cz * s); c.castShadow = true; c.receiveShadow = true; crowns.add(c);
        });
      }
      g.userData = { tr, crowns, y0: crowns.position.y };
      trees.push(g);
    }
    tree(-9, 3.5, 1.15, false, 0); tree(-11, -9, 1.3, true, 0); tree(9.5, 5.5, 1.0, false, 1);
    stagger(trees, 7, 0.28, 0.8, (o, k, a, b) => {
      const [t0, t1] = S(k, a, b); o.visible = false;
      at(t0, t1, (t) => {
        o.visible = t > 0;
        const up = easeOut(clamp(t * 1.6, 0, 1));
        o.userData.tr.scale.set(Math.max(0.3, t), Math.max(0.0001, up), Math.max(0.3, t));
        o.userData.crowns.scale.setScalar(Math.max(0.0001, spring(clamp((t - 0.3) / 0.7, 0, 1))));
        o.userData.crowns.position.y = o.userData.y0 * Math.max(0.0001, up);
      });
    }, 2);
    const bushes = [];
    [[-6.6, 4.8], [-6.2, 5.8], [-3.5, 5.4], [3.2, 5.3], [4.3, 5.6], [6.6, 3.2], [-6.8, -2], [-6.8, -3.4], [6.4, -4.2]].forEach(([x, z], i) => {
      const b = new T.Mesh(crownGeo(0.55 + (i % 3) * 0.12, 2, i * 3.1), leafMats[i % 4]);
      b.position.set(x, 0.38, z); b.scale.y = 0.78; b.castShadow = true; b.receiveShadow = true; scene.add(b); bushes.push(b);
    });
    stagger(bushes, 7, 0.42, 0.74, (o, k, a, b) => pop(o, k, a, b, spring), 2);
    const fence = [];
    const fenceGeo = rbox(0.1, 1.1, 0.04, 0.012); fenceGeo.translate(0, 0.55, 0); worldUV(fenceGeo);
    for (let x = -11; x <= 11.01; x += 0.5) {
      if (Math.abs(x - doorX) < 0.8) continue;
      const p = new T.Mesh(fenceGeo, M.fence); p.position.set(x, 0, 10.6); p.castShadow = true; scene.add(p); fence.push(p);
    }
    stagger(fence, 7, 0.55, 0.88, (o, k, a, b) => growY(o, k, a, b, spring), 4);
    [0.3, 0.85].forEach((y) => {
      [[-11, doorX - 0.7], [doorX + 0.7, 11]].forEach(([a, b]) => {
        const r = box(b - a, 0.08, 0.04, M.fence, (a + b) / 2, y, 10.56, scene, { r: 0.01 });
        r.visible = false;
        at(...S(7, 0.82, 0.92), (t) => { r.scale.x = Math.max(0.0001, easeOut(t)); r.visible = t > 0; });
      });
    });
    const bollards = [];
    [-1, 1].forEach((s) => [6.4, 8.6].forEach((z) => {
      const b = new T.Group(); b.position.set(doorX + s * 0.95, 0, z); scene.add(b);
      const post = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 0.6, 10), M.frame); post.position.y = 0.3; post.castShadow = true; b.add(post);
      const head = new T.Mesh(new T.CylinderGeometry(0.075, 0.075, 0.08, 10), M.glow); head.position.y = 0.64; b.add(head);
      bollards.push(b);
    }));
    stagger(bollards, 7, 0.88, 0.97, (o, k, a, b) => pop(o, k, a, b, spring), 2);

    /* =========================================================
       Etappe 8: Möbel, Licht, Abendstimmung
       ========================================================= */
    const sofa = new T.Group(); sofa.position.set(1.6, 0, -1.6); house.add(sofa);
    box(2.4, 0.42, 0.95, M.fabric, 0, 0.25, 0, sofa, { r: 0.06 }); box(2.4, 0.45, 0.22, M.fabric, 0, 0.65, -0.37, sofa, { r: 0.06 });
    box(0.22, 0.3, 0.95, M.fabric, -1.1, 0.55, 0, sofa, { r: 0.06 }); box(0.22, 0.3, 0.95, M.fabric, 1.1, 0.55, 0, sofa, { r: 0.06 });
    const rug = box(3.0, 0.012, 2.0, M.fabricLight, 1.6, 0.04, -0.3, house, { r: 0.004 });
    const bed = new T.Group(); bed.position.set(2.6, 3.0, -0.2); house.add(bed);
    box(1.7, 0.4, 2.1, M.oak, 0, 0.2, 0, bed, { r: 0.02 }); box(1.6, 0.18, 2.0, M.white, 0, 0.48, 0, bed, { r: 0.06, uv: false }); box(1.6, 0.06, 1.2, M.fabric, 0, 0.6, 0.4, bed, { r: 0.02 });
    [sofa, bed, rug].forEach((f) => pop(f, 6, 0.9, 0.99, spring));
    pop(box(0.12, 0.25, 0.1, M.glowF, doorO[1] + 0.3, 2.1, pe + 0.05, WALLS.front.group, { uv: false, r: 0.02 }), 6, 0.9, 0.98);
    const porch = new T.PointLight(0xffb870, 0, 7, 1.8); porch.position.set(doorX, FL + 2.3, 4 + pe + 0.6); scene.add(porch);
    const winOrder = windowGlass.map((m) => ({ m, k: rand() })).sort((a, b) => a.k - b.k);

    /* =========================================================
       Tageslicht: Morgen → Mittag → Abend
       ========================================================= */
    const TOD = [
      { p: 0.0, el: 9, az: -78, sun: '#ffbe86', si: 2.2, env: 0.55, top: '#7f9ec4', hor: '#f4d3b2', gnd: '#6f6253', exp: 1.0 },
      { p: 1.6, el: 26, az: -55, sun: '#ffe0bb', si: 2.8, env: 0.75, top: '#6b9ad5', hor: '#e8e3d8', gnd: '#6f6658', exp: 1.0 },
      { p: 3.6, el: 58, az: -12, sun: '#fff6ec', si: 3.2, env: 1.0, top: '#4b86d1', hor: '#dde8ee', gnd: '#6f6a60', exp: 1.0 },
      { p: 5.6, el: 44, az: 32, sun: '#fff0dc', si: 3.0, env: 0.95, top: '#5a8fd2', hor: '#e2e6e3', gnd: '#6f6a60', exp: 1.0 },
      { p: 6.9, el: 22, az: 58, sun: '#ffd29a', si: 2.7, env: 0.75, top: '#6688bb', hor: '#f1d5b2', gnd: '#655a4e', exp: 1.0 },
      { p: 7.5, el: 6, az: 74, sun: '#ff9a52', si: 1.7, env: 0.42, top: '#3b4e7f', hor: '#f0a270', gnd: '#3e3532', exp: 1.05 },
      { p: 8.0, el: -3, az: 82, sun: '#ff7a3a', si: 0.25, env: 0.16, top: '#111a33', hor: '#6e4b5d', gnd: '#1c1a1c', exp: 1.18 }
    ].map((k) => Object.assign(k, { sunC: new T.Color(k.sun), topC: new T.Color(k.top), horC: new T.Color(k.hor), gndC: new T.Color(k.gnd) }));
    const sunDir = new T.Vector3();
    function applyTOD(p) {
      let i = 0; while (i < TOD.length - 2 && p > TOD[i + 1].p) i++;
      const a = TOD[i], b = TOD[i + 1], t = smooth(clamp((p - a.p) / (b.p - a.p), 0, 1));
      const el = lerp(a.el, b.el, t) * Math.PI / 180, az = lerp(a.az, b.az, t) * Math.PI / 180;
      sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      sun.position.copy(sunDir).multiplyScalar(40);
      sun.color.copy(a.sunC).lerp(b.sunC, t);
      sun.intensity = lerp(a.si, b.si, t) * clamp(sunDir.y * 6 + 0.3, 0.1, 1);
      scene.environmentIntensity = lerp(a.env, b.env, t);
      skyU.uTop.value.copy(a.topC).lerp(b.topC, t);
      skyU.uHor.value.copy(a.horC).lerp(b.horC, t);
      skyU.uGnd.value.copy(a.gndC).lerp(b.gndC, t);
      skyU.uSunDir.value.copy(sunDir);
      skyU.uSunCol.value.copy(sun.color).multiplyScalar(clamp(sunDir.y * 4 + 0.6, 0, 1));
      fog.color.copy(skyU.uHor.value).lerp(skyU.uGnd.value, 0.25);
      renderer.toneMappingExposure = lerp(a.exp, b.exp, t);
      const night = smooth(clamp((p - 7.35) / 0.6, 0, 1));
      ambient.intensity = night * 0.5;
      M.glow.emissiveIntensity = M.glowF.emissiveIntensity = night * 6;
      porch.intensity = night * 4;
      winOrder.forEach((w, j) => {
        const on = smooth(clamp((p - (7.45 + j * 0.022)) / 0.05, 0, 1));
        w.m.emissiveIntensity = on * 1.7;
        w.m.opacity = lerp(0.38, 0.88, on);
      });
    }

    /* =========================================================
       Kamerafahrten
       ========================================================= */
    const V = (x, y, z) => new T.Vector3(x, y, z);
    const CAM = [
      { pos: V(-18, 12, 22), tgt: V(-1, 2, 0) },             // Bauplatz
      { pos: V(-16.5, 10.5, 18.5), tgt: V(-2, 3.4, -1) },    // 1 Rohbau (mit Kran)
      { pos: V(-11.5, 5.8, 17), tgt: V(0, 3.0, 0) },         // 2 Fassade
      { pos: V(13, 12.5, 14.5), tgt: V(0, 4.6, 0) },         // 3 Dach
      { pos: V(1.0, 4.7, 16.5), tgt: V(0.2, 3.3, -1) },      // 4 Elektrik (Schnitt)
      { pos: V(-3.0, 4.4, 15), tgt: V(0, 3.1, -1.2) },       // 5 Innenausbau
      { pos: V(-4.6, 3.4, 10.5), tgt: V(-1.6, 1.8, -1.6) },  // 6 Schreiner (Küche)
      { pos: V(-16.5, 8.5, 21.5), tgt: V(0, 2.2, 2.5) }      // 7 Garten
    ];
    const ORBIT_C = V(0, 3.0, 0.6);
    const camPos = new T.Vector3(), camTgt = new T.Vector3();
    let aspect = 1.6;
    function cameraAt(p) {
      if (p >= 7) {
        // Etappe 8: einmal langsam ums Haus
        const f = clamp(p - 7, 0, 1), from = CAM[7];
        const rel = from.pos.clone().sub(ORBIT_C);
        const a0 = Math.atan2(rel.x, rel.z);
        const tIn = easeInOut(clamp(f / 0.18, 0, 1));
        const orbitT = easeInOut(clamp((f - 0.1) / 0.85, 0, 1));
        const ang = a0 + orbitT * Math.PI * 2;
        const rad = lerp(Math.hypot(rel.x, rel.z), 21.5, tIn);
        const y = lerp(from.pos.y, 4.4 + Math.sin(orbitT * Math.PI) * 3.6, tIn);
        camPos.set(ORBIT_C.x + Math.sin(ang) * rad, y, ORBIT_C.z + Math.cos(ang) * rad);
        camTgt.copy(from.tgt).lerp(ORBIT_C, tIn);
      } else {
        const k = Math.floor(p), f = p - k;
        const a = CAM[k], b = CAM[Math.min(k + 1, 7)];
        const t = easeInOut(clamp(f / 0.38, 0, 1));
        camPos.lerpVectors(a.pos, b.pos, t);
        camTgt.lerpVectors(a.tgt, b.tgt, t);
        const drift = smooth(clamp((f - 0.38) / 0.6, 0, 1)) * 0.05; // sanftes Weiterdriften
        camPos.sub(camTgt).applyAxisAngle(Yv, drift).add(camTgt);
      }
      const fac = (aspect < 1.35 ? Math.pow(1.35 / aspect, 0.85) : 1) * (options.distance || 1);
      if (fac !== 1) camPos.sub(camTgt).multiplyScalar(fac).add(camTgt);
      camera.position.copy(camPos); camera.lookAt(camTgt);
    }

    /* =========================================================
       Leistungsstufen + Ambient Occlusion (GTAO)
       ========================================================= */
    let composer = null, gtao = null, width = 0, height = 0, useAO = false;
    let target = 0, current = 0, dirty = true, running = false, ready = false, firstApply = true;
    function buildComposer() {
      if (composer) return;
      const dt = new T.DepthTexture(1, 1); dt.type = T.UnsignedIntType;
      const rt = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: 4, depthTexture: dt });
      composer = new T.EffectComposer(renderer, rt);
      composer.addPass(new T.RenderPass(scene, camera));
      // Tiefe aus dem echten Bild → Schnitte und Aufbau-Shader werden respektiert
      gtao = new T.GTAOPass(scene, camera, 1, 1, { depthTexture: composer.renderTarget2.depthTexture });
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      gtao.blendIntensity = 0.85;
      composer.addPass(gtao);
      composer.addPass(new T.OutputPass());
    }
    const TIERS = {
      high: { pr: 1, shadow: 0, ao: false, grass: 1300, parts: 1 },
      medium: { pr: 1, shadow: 0, ao: false, grass: 650, parts: 0.7 },
      low: { pr: 1, shadow: 0, ao: false, grass: 225, parts: 0.4 }
    };
    function applyTier(name) {
      tier = name; const c = TIERS[name];
      renderer.setPixelRatio(1); // fest auf 1
      const sh = false; // Schatten ganz aus (Fake-Schatten unter dem Haus)
      if (renderer.shadowMap.enabled !== sh) {
        renderer.shadowMap.enabled = sh;
        scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
      }
      sun.castShadow = sh;
      if (sh && sun.shadow.mapSize.x !== c.shadow) { sun.shadow.mapSize.set(c.shadow, c.shadow); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
      useAO = false; // Ambient Occlusion / Post-Processing komplett aus
      tufts.count = c.grass;
      dust.setLimit(Math.round(130 * c.parts)); sparks.setLimit(Math.round(110 * c.parts));
      width = 0; dirty = true;
      if (options.onTier) options.onTier(name);
    }

    /* ---------- Update ---------- */
    function apply(p) {
      for (let i = 0; i < anims.length; i++) {
        const a = anims[i];
        const t = clamp((p - a.t0) / (a.t1 - a.t0), 0, 1);
        if (t !== a.last) { a.last = t; a.fn(t); }
      }
      // Schnitt: Front + vordere Dachhälfte zwischen Etappe 4 und 6 offen
      let open = 0;
      if (p > 3.0 && p < 6.2) open = p < 3.2 ? smooth((p - 3.0) / 0.2) : (p > 6.0 ? 1 - smooth((p - 6.0) / 0.2) : 1);
      planes.front.constant = open <= 0 ? 50 : lerp(FL + EH + 0.6, FL - 0.6, open);
      planes.roofCut.constant = open <= 0 ? 50 : lerp(5.2, 0.06, open);
      updateCrane(p);
      applyTOD(p);
      lamps.forEach((l) => { const v = lampLevel(l, p); l.light.intensity = v * 9; l.bulbMat.emissiveIntensity = v * 4; });
      cameraAt(p);
    }

    // Partikel beim Vorwärts-Scrollen
    const perim = (u) => {
      const d = u * 36;
      if (d < 10) return [-5 + d, 4]; if (d < 18) return [5, 4 - (d - 10)]; if (d < 28) return [5 - (d - 18), -4]; return [-5, -4 + (d - 28)];
    };
    function emit(prev, p) {
      for (const tr of triggers) if (prev < tr.p && p >= tr.p) tr.fn();
      const dp = p - prev;
      if (p > 0.16 && p < 0.92 && !(p > 0.42 && p < 0.64)) {
        const y = FL + R.brick.U.uRev.value * brickCfg.count * brickCfg.step;
        const n = Math.min(6, Math.ceil(dp * 120));
        for (let i = 0; i < n; i++) { const [x, z] = perim(rand()); puff(x, y, z, 1, 0.4); }
      }
      if (p > 3.2 && p < 3.75) wires.forEach((w) => {
        if (!w.userData.growing) return;
        const tip = w.userData.a.clone().addScaledVector(w.userData.dir, w.scale.y);
        house.localToWorld(tip);
        burst(tip.x, tip.y, tip.z, 2);
      });
      if (p > 4.58 && p < 4.9) puff(-4.75 + R.floor.U.uRev.value * 76 * 0.125, FL + 0.05, (rand() - 0.5) * 7, 2, 0.3);
      if (p > 4.34 && p < 4.6 && rand() < 0.5) puff(-4.6 + rand() * 9, FL + 0.5 + rand() * 2, -3.5, 1, 0.2);
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === width && h === height) return;
      width = w; height = h; aspect = w / h;
      renderer.setSize(w, h, false);
      camera.aspect = aspect;
      const sx = options.viewShift ? options.viewShift(w, h) : 0;
      if (sx) camera.setViewOffset(w, h, sx, 0, w, h); else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      const pr = renderer.getPixelRatio();
      if (composer) { composer.setPixelRatio(pr); composer.setSize(w, h); }
      const ps = (h * pr) / (2 * Math.tan((camera.fov * Math.PI) / 360));
      dust.mat.uniforms.uScale.value = ps; sparks.mat.uniforms.uScale.value = ps;
      cameraAt(current);
      dirty = true;
    }
    function render() {
      renderer.render(scene, camera);
    }

    // Automatische Leistungsanpassung (bei < ~24 fps eine Stufe zurück)
    let perfFrames = 0, perfTime = 0, perfCooldown = 20;
    function perf(dt) {
      if (options.still || options.fixedTier) return;
      if (perfCooldown > 0) { perfCooldown--; return; }
      perfFrames++; perfTime += dt;
      if (perfFrames >= 45) {
        const avg = perfTime / perfFrames;
        perfFrames = 0; perfTime = 0;
        if (avg > 1 / 24 && tier !== 'low') { applyTier(tier === 'high' ? 'medium' : 'low'); perfCooldown = 40; }
      }
    }

    let last = 0, timeAcc = 0;
    function frame(now) {
      if (!running) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016; last = now;
      resize();
      const prev = current;
      const d = target - current;
      if (Math.abs(d) > 0.0002) {
        // weiche Glättung (Damping) + Geschwindigkeitsbegrenzung
        const step = clamp(d * (1 - Math.exp(-dt * 3.4)), -2.6 * dt, 2.6 * dt);
        current += step;
      } else current = target;
      let needs = dirty;
      const pf = window.__dhPerf, t0 = pf ? performance.now() : 0;
      if (current !== prev || firstApply) {
        apply(current); firstApply = false; needs = true;
        if (options.onFrame) options.onFrame(current);
      }
      if (current > prev) emit(prev, current);
      // zeitbasierte Effekte
      timeAcc += dt;
      let fx = false;
      if (current > 3.2 && current < 4.4) { wireU.uTime.value = timeAcc; fx = true; }
      lamps.forEach((l) => {
        if (l.flick === null) return;
        l.flick += dt; fx = true;
        if (l.flick >= 0.6) l.flick = null;
        const v = lampLevel(l, current); l.light.intensity = v * 9; l.bulbMat.emissiveIntensity = v * 4;
      });
      if (dust.update(dt)) fx = true;
      if (sparks.update(dt)) fx = true;
      const t1 = pf ? performance.now() : 0;
      if ((needs || fx) && ready) { render(); dirty = false; perf(dt); }
      if (pf) { pf.apply += t1 - t0; pf.render += performance.now() - t1; pf.frames++; pf.calls = Math.max(pf.calls, renderer.info.render.calls); pf.tris = Math.max(pf.tris, renderer.info.render.triangles); }
      requestAnimationFrame(frame);
    }

    /* ---------- Start ---------- */
    applyTier(tier);
    apply(0); firstApply = true;
    let readyResolve;
    const readyP = new Promise((r) => { readyResolve = r; });
    let hdrDone = false, texDone = false;
    function checkReady() {
      if (hdrDone && texDone && !ready) {
        ready = true; dirty = true;
        try { renderer.compile(scene, camera); } catch (e) { /* weiter */ }
        if (options.onReady) options.onReady();
        readyResolve();
      }
    }
    onTexReady = () => { texDone = true; checkReady(); };
    if (pending === 0) texDone = true;
    const pmrem = new T.PMREMGenerator(renderer);
    loadHDRI(window.DH_TEX.himmel, (t) => {
      scene.environment = pmrem.fromEquirectangular(t).texture;
      t.dispose(); pmrem.dispose();
      hdrDone = true; checkReady();
    });

    return {
      setProgress(p) { target = clamp(p, 0, 8); },
      start() { if (!running) { running = true; last = 0; requestAnimationFrame(frame); } },
      stop() { running = false; },
      renderAt(p, camP) {
        return readyP.then(() => {
          width = 0; resize(); current = target = p;
          anims.forEach((a) => { a.last = -1; });
          apply(p);
          if (camP !== undefined) cameraAt(camP);
          render();
        });
      },
      resize() { width = 0; resize(); dirty = true; },
      get progress() { return current; },
      get tier() { return tier; },
      ready: readyP
    };
  }

  window.DemoHouse = { create: createHouseScene };
})();
