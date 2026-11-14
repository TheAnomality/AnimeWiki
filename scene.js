/*
 * Anime Hub Dictionary - WebGL background.
 *
 * A fixed full-page Three.js scene: sakura petals drifting through 3D space, a star field and a
 * neon wireframe "gem" floating behind the page title. It reacts to the pointer (parallax), to
 * scrolling, and speeds up while the app is loading data.
 *
 * Three.js ships with the site (lib/) and is loaded on demand. If it cannot load, or WebGL is
 * missing, the page simply keeps its CSS background - nothing else depends on this file.
 */
(function () {
  "use strict";

  const AW = (window.AnimeWiki = window.AnimeWiki || {});
  const THREE_LOCAL = "lib/three.module.min.js";
  const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js";

  const FIELD = { width: 20, height: 12, near: 7, far: -12 }; // volume the petals live in
  const GEM_Z = -6;
  const PETAL_COLORS = [0xffc2d1, 0xff9ab5, 0xff6584, 0xffe3ea, 0xffde59];

  const state = {
    enabled: true,
    loading: null,
    ready: false,
    running: false,
    failed: false,
    busy: false,
    pulse: 0,
    speed: 1,
    time: 0,
    last: 0,
    raf: 0,
    frames: 0,
    quality: 2,
    frozen: false,
    pixelRatio: 1,
    pointerX: 0,
    pointerY: 0,
    scrollY: 0,
    gemBaseY: 4,
    unitsPerPx: 0.02,
    sampleTime: 0,
    sampleFrames: 0,
    fps: 0
  };

  let THREE, renderer, scene, camera, canvas;
  let petals, petalData, petalCount, stars, gem, core, cage, shell, ringA, ringB, dummy;

  function webglAvailable() {
    try {
      const probe = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (probe.getContext("webgl2") || probe.getContext("webgl")));
    } catch (err) {
      return false;
    }
  }

  const rand = (min, max) => min + Math.random() * (max - min);

  /**
   * The bundled copy is used whenever the site is served over http(s). Browsers refuse to
   * load JavaScript modules from file://, so a page opened straight from disk uses the same
   * version from a CDN instead.
   */
  function loadThree() {
    if (location.protocol === "file:") return import(THREE_CDN);
    return import(new URL(THREE_LOCAL, document.baseURI).href).catch(() => import(THREE_CDN));
  }

  /* ------------------------------------------------------------------ */
  /* Scene construction                                                  */
  /* ------------------------------------------------------------------ */

  function makeGlowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.25, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  /** A sakura petal: teardrop outline with the characteristic notch, slightly cupped. */
  function makePetalGeometry() {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.42, 0.12, 0.62, 0.72, 0.2, 1.0);
    shape.lineTo(0, 0.86);
    shape.lineTo(-0.2, 1.0);
    shape.bezierCurveTo(-0.62, 0.72, -0.42, 0.12, 0, 0);
    const geometry = new THREE.ShapeGeometry(shape, 10);
    geometry.translate(0, -0.5, 0);
    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      position.setZ(i, 0.9 * x * x - 0.12 * Math.cos(y * Math.PI));
    }
    geometry.computeVertexNormals();
    return geometry;
  }

  function buildStars(glow, count) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      // Random direction on the half of a sphere that sits in front of the camera.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = rand(30, 70);
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = r * s * Math.cos(theta);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = -Math.abs(r * s * Math.sin(theta)) - 4;
      const roll = Math.random();
      tint.setHex(roll < 0.12 ? 0xffde59 : roll < 0.24 ? 0xff8fab : 0xffffff);
      tint.multiplyScalar(rand(0.45, 1));
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.5,
      map: glow,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });
    return new THREE.Points(geometry, material);
  }

  function buildPetals(count) {
    const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(makePetalGeometry(), material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    // x, y, z, fall speed, sway amplitude, sway frequency, phase, scale, rotation xyz, spin xyz
    petalData = new Float32Array(count * 14);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const o = i * 14;
      petalData[o] = rand(-FIELD.width, FIELD.width);
      petalData[o + 1] = rand(-FIELD.height, FIELD.height);
      petalData[o + 2] = rand(FIELD.far, FIELD.near);
      petalData[o + 3] = rand(0.5, 1.4);
      petalData[o + 4] = rand(0.25, 0.9);
      petalData[o + 5] = rand(0.4, 1.1);
      petalData[o + 6] = rand(0, Math.PI * 2);
      petalData[o + 7] = rand(0.16, 0.36);
      petalData[o + 8] = rand(0, Math.PI * 2);
      petalData[o + 9] = rand(0, Math.PI * 2);
      petalData[o + 10] = rand(0, Math.PI * 2);
      petalData[o + 11] = rand(-1.6, 1.6);
      petalData[o + 12] = rand(-1.2, 1.2);
      petalData[o + 13] = rand(-0.9, 0.9);
      color.setHex(PETAL_COLORS[Math.floor(Math.random() * PETAL_COLORS.length)]);
      mesh.setColorAt(i, color);
    }
    mesh.instanceColor.needsUpdate = true;
    return mesh;
  }

  function buildGem(glow) {
    const group = new THREE.Group();

    core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.25, 0),
      new THREE.MeshStandardMaterial({
        color: 0x2a1436,
        emissive: 0xff6584,
        emissiveIntensity: 0.35,
        metalness: 0.35,
        roughness: 0.3,
        flatShading: true
      })
    );
    group.add(core);

    cage = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.25, 1)),
      new THREE.LineBasicMaterial({ color: 0xffde59, transparent: true, opacity: 0.55 })
    );
    group.add(cage);

    shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(3.1, 0)),
      new THREE.LineBasicMaterial({ color: 0xff6584, transparent: true, opacity: 0.4 })
    );
    group.add(shell);

    const ringGeometry = new THREE.TorusGeometry(3.8, 0.018, 6, 160);
    ringA = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: 0xffde59, transparent: true, opacity: 0.6 }));
    ringA.rotation.x = Math.PI / 2.4;
    ringB = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: 0xff6584, transparent: true, opacity: 0.5 }));
    ringB.rotation.set(Math.PI / 1.7, 0.6, 0);
    group.add(ringA, ringB);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: 0xff6584,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false
      })
    );
    halo.scale.setScalar(13);
    group.add(halo);

    group.position.set(0, state.gemBaseY, GEM_Z);
    return group;
  }

  function build() {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    state.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0f, 14, 36); // distant petals melt into the page background

    camera = new THREE.PerspectiveCamera(55, 1, 0.1, 140);
    camera.position.set(0, 0, 14);

    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xfff1c9, 2.2);
    key.position.set(4, 8, 10);
    scene.add(key);
    const rim = new THREE.PointLight(0xff6584, 140, 0, 2);
    rim.position.set(-6, 4, 3);
    scene.add(rim);

    const small = Math.min(window.innerWidth, window.innerHeight) < 700;
    const glow = makeGlowTexture();
    dummy = new THREE.Object3D();

    stars = buildStars(glow, small ? 500 : 1100);
    scene.add(stars);

    petalCount = small ? 110 : 260;
    petals = buildPetals(petalCount);
    scene.add(petals);

    gem = buildGem(glow);
    scene.add(gem);

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      pause();
    });
    canvas.addEventListener("webglcontextrestored", resume);

    window.addEventListener("resize", layout);
    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType === "touch") return;
        state.pointerX = (event.clientX / window.innerWidth) * 2 - 1;
        state.pointerY = (event.clientY / window.innerHeight) * 2 - 1;
      },
      { passive: true }
    );
    window.addEventListener("scroll", () => (state.scrollY = window.scrollY), { passive: true });
    document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));

    state.scrollY = window.scrollY;
    layout();
    updatePetals(0);
  }

  /* ------------------------------------------------------------------ */
  /* Layout: keep the gem behind the page title                          */
  /* ------------------------------------------------------------------ */

  function measureAnchor() {
    const h = window.innerHeight;
    const anchor = document.querySelector("[data-scene-anchor]");
    let centerY = h * 0.2;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      if (rect.height > 0) centerY = rect.top + window.scrollY + rect.height / 2;
    }
    state.gemBaseY = (h / 2 - centerY) * state.unitsPerPx;
  }

  function layout() {
    if (!renderer) return;
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    renderer.setPixelRatio(state.pixelRatio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const depth = camera.position.z - GEM_Z;
    state.unitsPerPx = (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / h;
    gem.scale.setScalar(w < 720 ? 0.6 : 1);
    measureAnchor();
    if (!state.running) renderOnce();
  }

  /* ------------------------------------------------------------------ */
  /* Animation                                                           */
  /* ------------------------------------------------------------------ */

  function updatePetals(dt) {
    const speed = state.speed;
    const drift = 0.6 + 0.4 * speed;
    const time = state.time;
    const n = petals.count;
    for (let i = 0; i < n; i++) {
      const o = i * 14;
      let x = petalData[o];
      let y = petalData[o + 1];
      y -= petalData[o + 3] * dt * speed;
      x += (Math.sin(time * petalData[o + 5] + petalData[o + 6]) * petalData[o + 4] + 0.18) * dt * drift;
      if (y < -FIELD.height) {
        y = FIELD.height;
        x = rand(-FIELD.width, FIELD.width);
      }
      if (x > FIELD.width) x = -FIELD.width;
      petalData[o] = x;
      petalData[o + 1] = y;
      petalData[o + 8] += petalData[o + 11] * dt * speed;
      petalData[o + 9] += petalData[o + 12] * dt * speed;
      petalData[o + 10] += petalData[o + 13] * dt * speed;

      dummy.position.set(x, y, petalData[o + 2]);
      dummy.rotation.set(petalData[o + 8], petalData[o + 9], petalData[o + 10]);
      dummy.scale.setScalar(petalData[o + 7]);
      dummy.updateMatrix();
      petals.setMatrixAt(i, dummy.matrix);
    }
    petals.instanceMatrix.needsUpdate = true;
  }

  function update(dt) {
    state.time += dt;
    const targetSpeed = (state.busy ? 3.2 : 1) + state.pulse;
    state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 3);
    state.pulse *= Math.pow(0.1, dt);

    updatePetals(dt);

    const spin = dt * (0.4 + 0.6 * state.speed);
    core.rotation.x += spin * 0.5;
    core.rotation.y += spin * 0.7;
    cage.rotation.y -= spin * 0.22;
    cage.rotation.x += spin * 0.1;
    shell.rotation.y += spin * 0.14;
    shell.rotation.z -= spin * 0.08;
    ringA.rotation.z += spin * 0.3;
    ringB.rotation.z -= spin * 0.24;

    // The gem scrolls away a little slower than the page: cheap, convincing depth.
    gem.position.y = state.gemBaseY + state.scrollY * state.unitsPerPx * 0.75 + Math.sin(state.time * 0.6) * 0.25;
    stars.rotation.y = state.time * 0.004 + state.pointerX * 0.02;
    stars.position.y = state.scrollY * 0.003;

    const ease = Math.min(1, dt * 2.5);
    camera.position.x += (state.pointerX * 1.3 - camera.position.x) * ease;
    camera.position.y += (-state.pointerY * 0.8 - camera.position.y) * ease;
    camera.lookAt(0, 0, 0);
  }

  function renderOnce() {
    if (renderer && scene) renderer.render(scene, camera);
  }

  /** If the device cannot keep up, shed petals and resolution instead of stuttering. */
  function monitor(elapsed) {
    if (elapsed > 1) {
      // The tab was stalled or throttled - that says nothing about rendering speed.
      state.sampleTime = 0;
      state.sampleFrames = 0;
      return;
    }
    state.sampleTime += elapsed;
    state.sampleFrames += 1;
    if (state.sampleTime < 3) return;
    state.fps = state.sampleFrames / state.sampleTime;
    state.sampleTime = 0;
    state.sampleFrames = 0;
    if (state.fps >= 26) return;
    if (state.quality > 0) {
      state.quality -= 1;
      petals.count = Math.max(40, Math.floor(petals.count / 2));
      state.pixelRatio = 1;
      layout();
    } else if (state.fps < 12) {
      // Still crawling at the lowest quality: keep the last frame as a still picture
      // rather than burning the battery.
      state.frozen = true;
      pause();
    }
  }

  function frame(now) {
    if (!state.running) return;
    state.raf = requestAnimationFrame(frame);
    const elapsed = Math.max(0, (now - state.last) / 1000);
    state.last = now;
    state.frames += 1;
    if (state.frames % 45 === 0) measureAnchor();
    update(Math.min(0.05, elapsed));
    renderOnce();
    monitor(elapsed);
  }

  function resume() {
    if (!state.ready || state.running || !state.enabled || state.frozen || document.hidden) return;
    state.running = true;
    state.last = performance.now();
    state.sampleTime = 0;
    state.sampleFrames = 0;
    state.raf = requestAnimationFrame(frame);
  }

  function pause() {
    state.running = false;
    cancelAnimationFrame(state.raf);
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  /** Loads Three.js and starts the scene. Resolves to true when it is running. */
  function start(targetCanvas) {
    if (state.ready) {
      resume();
      return Promise.resolve(true);
    }
    if (state.failed) return Promise.resolve(false);
    if (state.loading) return state.loading;
    canvas = targetCanvas || canvas;
    if (!canvas || !webglAvailable()) {
      state.failed = true;
      document.documentElement.classList.add("no-scene");
      return Promise.resolve(false);
    }
    state.loading = loadThree()
      .then((module) => {
        THREE = module;
        build();
        state.ready = true;
        document.documentElement.classList.add("has-scene");
        resume();
        return true;
      })
      .catch((err) => {
        console.warn("3D background unavailable:", err);
        state.failed = true;
        document.documentElement.classList.add("no-scene");
        return false;
      })
      .then((ok) => {
        state.loading = null;
        return ok;
      });
    return state.loading;
  }

  function setEnabled(enabled, targetCanvas) {
    state.enabled = !!enabled;
    if (!state.enabled) {
      pause();
      return Promise.resolve(false);
    }
    return start(targetCanvas);
  }

  AW.scene = {
    start,
    setEnabled,
    /** Petals rush while data is loading. */
    setBusy(busy) {
      state.busy = !!busy;
    },
    /** A short gust, e.g. when results arrive. */
    pulse(strength) {
      state.pulse = Math.min(5, state.pulse + (strength || 2.5));
    },
    info() {
      return {
        ready: state.ready,
        running: state.running,
        failed: state.failed,
        frozen: state.frozen,
        fps: Math.round(state.fps),
        petals: petals ? petals.count : 0,
        quality: state.quality
      };
    }
  };
})();
