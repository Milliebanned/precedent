/* The hero: the whole record, drawn in 3D. Every line is one token on one closed-market window, running from the
   16:00 close (left) to the next open (right). Height is the move since the close in units of that token's normal
   day. Windows are stacked back in time. When an idea is tested, its precedents light up. */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const canvas = document.getElementById('scene');
const hero = document.getElementById('top');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const WIDTH = 13, GAP = 0.34, HEIGHT = 1.35, DEEP = 0x0d1f18;
const CREAM = new THREE.Color(0xf3ecdc), CLAY = new THREE.Color(0xd9805f), GOLD = new THREE.Color(0xe0a13a);

function start(D) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (e) { return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(DEEP, 13, 38);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  const world = new THREE.Group();
  scene.add(world);

  const n = D.sessions.length, U = D.unit, lines = [], byKey = new Map(), ends = [], endColors = [];
  const mat = {
    up: new THREE.LineBasicMaterial({ color: CREAM, transparent: true, opacity: 0.62 }),
    down: new THREE.LineBasicMaterial({ color: CLAY, transparent: true, opacity: 0.62 }),
    dim: new THREE.LineBasicMaterial({ color: CREAM, transparent: true, opacity: 0.1 }),
    gold: new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 1 }),
  };
  D.sessions.forEach((sess, i) => {
    const z = -(n - 1 - i) * GAP;   // the latest window is at the front
    D.tickers.forEach((tk) => {
      const p = D.paths[tk][sess.id];
      if (!p) return;
      const steps = p.c.length - 1, pts = [];
      let last = 0;
      p.c.forEach((v, j) => {
        if (v != null) last = v;
        const y = Math.max(-3.6, Math.min(3.6, last / p.vol)) * HEIGHT;
        pts.push((j / steps - 0.5) * WIDTH, y, z);
      });
      const yEnd = Math.max(-3.6, Math.min(3.6, p.x / p.vol)) * HEIGHT;
      pts.push(0.5 * WIDTH + 0.12, yEnd, z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const up = p.x >= 0, line = new THREE.Line(geo, up ? mat.up : mat.down);
      line.userData = { count: pts.length / 3, delay: (i / n) * 1.5 + Math.random() * 0.25, base: up ? mat.up : mat.down };
      geo.setDrawRange(0, still ? line.userData.count : 0);
      world.add(line); lines.push(line); byKey.set(tk + '|' + sess.id, line);
      ends.push(0.5 * WIDTH + 0.12, yEnd, z);
      const c = up ? CREAM : CLAY; endColors.push(c.r, c.g, c.b);
    });
  });

  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(ends, 3));
  dotGeo.setAttribute('color', new THREE.Float32BufferAttribute(endColors, 3));
  const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({ size: 0.075, vertexColors: true, transparent: true, opacity: still ? 0.9 : 0, sizeAttenuation: true }));
  world.add(dots);

  // the ends of the precedents of the idea being tested
  const glow = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: GOLD, size: 0.2, transparent: true, opacity: 1, sizeAttenuation: true }));
  glow.renderOrder = 3;
  world.add(glow);

  // the floor: the close, the open, and the level of "no move"
  const depth = (n - 1) * GAP, floor = [];
  [-0.5, -0.25, 0, 0.25, 0.5].forEach((f) => floor.push(f * WIDTH, 0, 0.4, f * WIDTH, 0, -depth - 0.4));
  for (let k = 0; k <= 6; k++) floor.push(-0.5 * WIDTH, 0, -depth * k / 6, 0.5 * WIDTH, 0, -depth * k / 6);
  const floorGeo = new THREE.BufferGeometry();
  floorGeo.setAttribute('position', new THREE.Float32BufferAttribute(floor, 3));
  world.add(new THREE.LineSegments(floorGeo, new THREE.LineBasicMaterial({ color: CREAM, transparent: true, opacity: 0.09 })));

  // a slow gold marker sweeping from the close to the open: "where are we in the night"
  const sweepGeo = new THREE.BufferGeometry();
  sweepGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.4, 0, 0, -depth - 0.4], 3));
  const sweep = new THREE.Line(sweepGeo, new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.55 }));
  world.add(sweep);

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    pointer.tx = (e.clientX - r.left) / r.width - 0.5; pointer.ty = (e.clientY - r.top) / r.height - 0.5;
  });

  let wide = true;
  function size() {
    const w = hero.clientWidth, h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    wide = w > 900;
    // on a wide screen the record sits to the right of the headline; on a phone it sits behind it
    world.position.set(wide ? 5.2 : 0.5, wide ? -1.6 : 1.2, wide ? -1.5 : -7);
    camera.fov = wide ? 36 : 52;
    camera.updateProjectionMatrix();
  }
  size();
  addEventListener('resize', size);

  let visible = true, t0 = performance.now(), raf = 0;
  new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible && !raf && !still) raf = requestAnimationFrame(frame); }).observe(hero);
  const ease = (x) => 1 - Math.pow(1 - x, 3);

  function frame(now) {
    raf = 0;
    const t = (now - t0) / 1000;
    if (t < 4.2) {
      lines.forEach((l) => {
        const k = ease(Math.max(0, Math.min(1, (t - l.userData.delay) / 1.7)));
        l.geometry.setDrawRange(0, Math.ceil(l.userData.count * k));
      });
      dots.material.opacity = Math.max(0, Math.min(0.9, (t - 2.6) / 1.2));
    } else if (lines[0].geometry.drawRange.count !== lines[0].userData.count || dots.material.opacity < 0.9) {
      lines.forEach((l) => l.geometry.setDrawRange(0, l.userData.count));
      dots.material.opacity = 0.9;
    }
    pointer.x += (pointer.tx - pointer.x) * 0.04; pointer.y += (pointer.ty - pointer.y) * 0.04;
    world.rotation.y = -0.62 + Math.sin(t * 0.11) * 0.07 + pointer.x * 0.16;
    world.rotation.x = 0.03 + pointer.y * 0.05;
    camera.position.set(0, 6.4 + Math.sin(t * 0.17) * 0.25 - pointer.y * 0.8, 14);
    camera.lookAt(1.6, -0.6, -5);
    sweep.position.x = ((t * 0.045) % 1 - 0.5) * WIDTH;
    renderer.render(scene, camera);
    if (visible && !document.hidden && !still) raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible && !raf && !still) raf = requestAnimationFrame(frame); });
  if (still) { frame(t0 + 10000); } else raf = requestAnimationFrame(frame);
  canvas.classList.add('on');

  // light up the precedents of the idea being tested
  addEventListener('precedent:hits', (e) => {
    const on = new Set(e.detail.ids.map((id) => e.detail.ticker + '|' + id));
    lines.forEach((l) => { l.material = on.size ? mat.dim : l.userData.base; l.renderOrder = 0; });
    on.forEach((key) => { const l = byKey.get(key); if (l) { l.material = mat.gold; l.renderOrder = 2; } });
    dots.material.opacity = on.size ? 0.25 : 0.9;
    const lit = [];
    on.forEach((key) => { const l = byKey.get(key); if (l) { const a = l.geometry.attributes.position, k = a.count - 1; lit.push(a.getX(k), a.getY(k), a.getZ(k)); } });
    glow.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lit, 3));
    if (still) frame(t0 + 10000);
  });
}

if (window.PRECEDENT) start(window.PRECEDENT); else addEventListener('precedent:data', () => start(window.PRECEDENT), { once: true });
