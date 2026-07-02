// Ambient background layer — a canvas 2D "aurora" behind the chat (issue #185 §A).
//
// The first cut was a CSS gradient wash; it proved too flat, so this is the
// issue's planned step up: a handful of large soft radial-gradient blobs
// drifting on slow Lissajous paths, with small twinkling motes rising through
// them that the mouse can drag around. Still no deps and no WebGL — the
// canvas renders at 1/4 resolution (gradients upscale smoothly) at ~30fps,
// and only while a mode enables it and the tab is visible.
//
// Contract (unchanged from the gradient version):
//   • aperio-ambient=auto|on|off maps onto data-ambient on <html>; CSS in
//     styles/ambient.css shows/hides the layer off that attribute.
//   • auto honors prefers-reduced-motion → a single static frame, no loop.
//     on is an explicit user override and keeps animating.
//   • setLevel(0..1) — voice (issue #185 §C) drives intensity: brighter and
//     faster drift. Mirrored into --ambient-level for the CSS opacity formula.
//   • Hues + blend mode come from --ambient-c1..c4 / --ambient-blend on
//     #ambient, so themes restyle the aurora from CSS alone.
(function () {
  window.Aperio = window.Aperio || {};

  const KEY = "aperio-ambient";
  const MODES = new Set(["auto", "on", "off"]);
  const root = document.documentElement;
  const host = document.getElementById("ambient");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const colorScheme = matchMedia("(prefers-color-scheme: dark)");

  function normalize(v) {
    return MODES.has(v) ? v : "auto"; // default: alive out of the box, reduced-motion safe
  }

  // ── Aurora engine ──────────────────────────────────────────────────────────
  const BLOB_COUNT = 7;
  const MOTE_COUNT = 36;
  const DRAG_RADIUS = 0.22; // pointer influence, viewport fractions
  const FRAME_MS = 1000 / 30;

  let canvas = null;
  let ctx = null;
  let palette = [];        // ["r,g,b", …] from --ambient-c1..c4
  let blend = "lighter";
  let blobs = [];
  let motes = [];
  let raf = 0;
  let last = 0;
  let clock = Math.random() * 100; // desync the pattern across page loads
  let target = 0;          // requested level (setLevel)
  let shown = 0;           // eased level actually rendered

  // Pointer-following glow: eases toward the cursor, and moving the mouse
  // "stirs" the scene (brighter glow + a small global energy kick, decaying).
  // Inactive until the first pointermove, and only drawn while the loop runs —
  // reduced-motion users never get mouse-driven motion.
  const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, lx: 0.5, ly: 0.5, active: false, stir: 0 };

  // Geometry is seeded once and kept across theme changes so a theme switch
  // recolors the blobs without making them jump.
  function seedBlobs() {
    blobs = Array.from({ length: BLOB_COUNT }, (_, i) => ({
      color: i,                          // index into palette (mod length)
      cx: 0.1 + Math.random() * 0.8,     // rest position, viewport fractions
      cy: 0.1 + Math.random() * 0.8,
      ax: 0.15 + Math.random() * 0.2,    // drift amplitude
      ay: 0.12 + Math.random() * 0.18,
      fx: 0.07 + Math.random() * 0.08,   // rad/s — full loops take ~40–90s
      fy: 0.06 + Math.random() * 0.08,
      px: Math.random() * Math.PI * 2,   // phases
      py: Math.random() * Math.PI * 2,
      r: 0.3 + Math.random() * 0.25,     // radius, fraction of max(w,h)
      fr: 0.03 + Math.random() * 0.04,   // radius "breathing"
      pr: Math.random() * Math.PI * 2,
    }));
  }

  // Small glowing motes rising through the blobs — the visible moving part.
  // Each follows a base path that is a pure function of the clock (so the
  // reduced-motion static frame shows them frozen mid-drift), plus a dragged
  // offset (ox/oy + velocity) the pointer pushes on and a weak spring returns.
  function seedMotes() {
    motes = Array.from({ length: MOTE_COUNT }, (_, i) => ({
      ox: 0, oy: 0, vx: 0, vy: 0,          // drag displacement + velocity
      color: i,                            // index into palette (mod length)
      x: Math.random(),                    // rest x, viewport fraction
      y: Math.random(),                    // start y; rises upward and wraps
      speed: 0.008 + Math.random() * 0.012, // viewport heights per second
      sway: 0.01 + Math.random() * 0.03,   // sideways wander amplitude
      sf: 0.2 + Math.random() * 0.4,       // sway frequency, rad/s
      sp: Math.random() * Math.PI * 2,
      r: 0.8 + Math.random() * 1.4,        // core radius, px at 1/4 res
      tf: 0.5 + Math.random() * 1.2,       // twinkle frequency, rad/s
      tp: Math.random() * Math.PI * 2,
    }));
  }

  // A mote's base path position (viewport fractions) at the current clock.
  function moteBase(m) {
    return [
      ((((m.x + Math.sin(clock * m.sf + m.sp) * m.sway) % 1) + 1) % 1),
      ((((m.y - clock * m.speed) % 1) + 1) % 1),
    ];
  }

  function hexToRgb(hex) {
    let s = hex.slice(1);
    if (s.length === 3) s = s.replace(/./g, (c) => c + c);
    const n = parseInt(s.slice(0, 6), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }

  function readPalette() {
    const cs = getComputedStyle(host);
    palette = ["--ambient-c1", "--ambient-c2", "--ambient-c3", "--ambient-c4", "--ambient-c5", "--ambient-c6"]
      .map((k) => cs.getPropertyValue(k).trim())
      .filter((v) => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v))
      .map(hexToRgb);
    blend = cs.getPropertyValue("--ambient-blend").trim() || "lighter";
  }

  function resize() {
    const w = Math.max(1, Math.round(innerWidth / 4));
    const h = Math.max(1, Math.round(innerHeight / 4));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw() {
    if (!palette.length) return;
    const w = canvas.width;
    const h = canvas.height;
    const m = Math.max(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = blend;
    const breathe = 0.5 + 0.5 * Math.sin(clock * 0.12); // subtle idle pulse
    const energy = 0.55 + breathe * 0.1 + shown * 0.35 + pointer.stir * 0.15;
    for (const b of blobs) {
      const rgb = palette[b.color % palette.length];
      const x = (b.cx + Math.sin(clock * b.fx + b.px) * b.ax) * w;
      const y = (b.cy + Math.sin(clock * b.fy + b.py) * b.ay) * h;
      const r = (b.r + Math.sin(clock * b.fr + b.pr) * 0.08) * m;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${(0.5 * energy).toFixed(3)})`);
      g.addColorStop(0.6, `rgba(${rgb},${(0.18 * energy).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (pointer.active && raf) {
      const rgb = palette[0];
      const x = pointer.x * w;
      const y = pointer.y * h;
      const r = (0.18 + pointer.stir * 0.1) * m;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const a = (0.3 + pointer.stir * 0.45) * energy;
      g.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`);
      g.addColorStop(0.6, `rgba(${rgb},${(a * 0.35).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    for (const b of motes) {
      const rgb = palette[b.color % palette.length];
      const [bx, by] = moteBase(b);
      const x = (bx + b.ox) * w;
      const y = (by + b.oy) * h;
      const tw = 0.5 + 0.5 * Math.sin(clock * b.tf + b.tp);
      const a = (0.3 + 0.7 * tw * tw) * (0.55 + shown * 0.45); // twinkle, brighter with level
      const glow = b.r * 3;
      const g = ctx.createRadialGradient(x, y, 0, x, y, glow);
      g.addColorStop(0, `rgba(${rgb},${a.toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - glow, y - glow, glow * 2, glow * 2);
    }
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < FRAME_MS) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    shown += (target - shown) * Math.min(1, dt * 3);
    clock += dt * (1 + shown * 2); // level speeds the drift up to 3×
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 4); // trail, don't stick
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 4);
    pointer.stir *= Math.exp(-dt * 1.5);
    // Drag physics: motes near the pointer inherit some of its velocity, then
    // damping bleeds it off and a weak spring eases them back onto their path.
    const pvx = (pointer.x - pointer.lx) / dt;
    const pvy = (pointer.y - pointer.ly) / dt;
    pointer.lx = pointer.x;
    pointer.ly = pointer.y;
    for (const m of motes) {
      if (pointer.active) {
        const [bx, by] = moteBase(m);
        const d = Math.hypot(bx + m.ox - pointer.x, by + m.oy - pointer.y);
        if (d < DRAG_RADIUS) {
          const fall = (1 - d / DRAG_RADIUS) ** 2;
          m.vx += pvx * fall * 10 * dt;
          m.vy += pvy * fall * 10 * dt;
        }
      }
      m.vx = (m.vx - m.ox * 1.2 * dt) * Math.exp(-2.5 * dt);
      m.vy = (m.vy - m.oy * 1.2 * dt) * Math.exp(-2.5 * dt);
      m.ox = Math.max(-0.3, Math.min(0.3, m.ox + m.vx * dt));
      m.oy = Math.max(-0.3, Math.min(0.3, m.oy + m.vy * dt));
    }
    draw();
  }

  function animating() {
    const mode = root.dataset.ambient;
    return mode === "on" || (mode === "auto" && !reduceMotion.matches);
  }

  // Reconcile the loop with mode / reduced-motion / tab visibility.
  function sync() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (!ctx || root.dataset.ambient === "off") return;
    resize();
    if (animating() && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } else {
      draw(); // reduced-motion (or hidden tab): a single static frame
    }
  }

  // ── Setting plumbing (unchanged) ───────────────────────────────────────────
  function apply(mode) {
    root.dataset.ambient = normalize(mode);
    sync();
  }

  // Public: set the ambient intensity, 0..1. Voice calls this with mic level.
  function setLevel(level) {
    const n = Math.max(0, Math.min(1, Number(level) || 0));
    target = n;
    host?.style.setProperty("--ambient-level", String(n));
  }

  function set(mode) {
    const m = normalize(mode);
    window.Aperio.settings?.set(KEY, m); // write-through: localStorage + DB
    apply(m);
  }

  function get() {
    return normalize(window.Aperio.settings?.get(KEY, "auto"));
  }

  if (host) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d");
    host.appendChild(canvas);
    seedBlobs();
    seedMotes();
    readPalette();
    // Recolor on theme changes; the running loop picks the palette up on the
    // next frame, a static frame needs an explicit repaint.
    const recolor = () => {
      readPalette();
      if (!raf) sync();
    };
    new MutationObserver(recolor).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    colorScheme.addEventListener("change", recolor);
    reduceMotion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    // Repaint synchronously: setting canvas dimensions wipes the bitmap, and
    // waiting for the next rAF tick leaves a blank flicker while resizing.
    window.addEventListener("resize", () => {
      resize();
      draw();
    });
    window.addEventListener("pointermove", (e) => {
      const nx = e.clientX / innerWidth;
      const ny = e.clientY / innerHeight;
      if (pointer.active) {
        pointer.stir = Math.min(1, pointer.stir + Math.hypot(nx - pointer.tx, ny - pointer.ty) * 6);
      } else {
        pointer.x = nx; // first sighting: appear at the cursor, don't glide in
        pointer.y = ny;
        pointer.active = true;
      }
      pointer.tx = nx;
      pointer.ty = ny;
    }, { passive: true });
  }

  // Apply the local value immediately (no boot flash); settings.init() may adopt
  // a server value afterward via the registered hook below.
  apply(get());

  window.Aperio.ambient = { set, get, setLevel };

  window.Aperio.settings?.register(KEY, (val) => apply(val));
})();
