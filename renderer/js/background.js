// Анимированные фоны на canvas. Цвет подстраивается под обложку, а «энергия» — под музыку.
const Bg = (() => {
  const STYLES = [
    { id: 'waves', name: 'Волны' },
    { id: 'aurora', name: 'Аврора' },
    { id: 'particles', name: 'Частицы' },
    { id: 'stars', name: 'Звёзды' },
    { id: 'off', name: 'Выкл' },
  ];
  // Масштаб внутреннего разрешения: мягкие фоны рисуем дешевле
  const SCALE = { aurora: 0.5, particles: 1, waves: 0.75, stars: 1, off: 0.25 };

  const cv = $('#bg');
  const ctx = cv.getContext('2d');
  let style = 'waves';
  let light = false;
  let W = 0, H = 0, t = 0, last = 0, raf = 0;
  let color = [139, 92, 246];   // текущий (плавно меняется)
  let target = [139, 92, 246];  // целевой (цвет обложки)
  let energyFn = () => 0;
  let energy = 0;
  let dots = [], stars = [];

  // ----- цветовые помощники -----
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, s * 100, l * 100];
  }
  // Монохром: оттенок и насыщенность игнорируются, остаётся только яркость серого.
  // Прозрачность приглушена, чтобы фон оставался фоном.
  const hsla = (h, s, l, a) => `hsla(0,0%,${l}%,${(a * (light ? 0.55 : 0.5)).toFixed(3)})`;
  // Базовый оттенок: насыщенный, чтобы фон не был серым даже у блёклых обложек
  const baseHue = () => rgbToHsl(color)[0];

  // ----- инициализация размеров -----
  function resize() {
    const s = SCALE[style] || 1;
    W = cv.width = Math.max(2, Math.ceil(innerWidth * s));
    H = cv.height = Math.max(2, Math.ceil(innerHeight * s));
    dots = Array.from({ length: 70 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.35, vy: -0.1 - Math.random() * 0.35,
      r: 1 + Math.random() * 2.2, k: Math.random(),
    }));
    stars = Array.from({ length: 220 }, () => ({
      x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random(), k: Math.random(),
    }));
  }

  const clear = () => {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = light ? '#e8e8e5' : '#0b0b0b';
    ctx.fillRect(0, 0, W, H);
  };

  // ----- стили -----
  function aurora() {
    clear();
    const hue = baseHue();
    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
    for (let i = 0; i < 5; i++) {
      const x = W * (0.5 + 0.4 * Math.sin(t * 0.13 * (1 + i * 0.3) + i * 1.7));
      const y = H * (0.5 + 0.38 * Math.cos(t * 0.1 * (1 + i * 0.23) + i * 2.3));
      const r = Math.max(W, H) * (0.38 + 0.08 * Math.sin(t * 0.2 + i)) * (1 + energy * 0.35);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const h = hue + (i - 2) * 30;
      g.addColorStop(0, hsla(h, 80, light ? 70 : 50, light ? 0.55 : 0.5));
      g.addColorStop(1, hsla(h, 80, light ? 70 : 50, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function particles() {
    clear();
    const hue = baseHue();
    const glow = ctx.createLinearGradient(0, H, 0, 0);
    glow.addColorStop(0, hsla(hue, 70, light ? 75 : 35, light ? 0.5 : 0.45));
    glow.addColorStop(0.7, hsla(hue, 70, 40, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const boost = 1 + energy * 2.5;
    const link = 130;
    for (const p of dots) {
      p.x += p.vx * boost; p.y += p.vy * boost;
      if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
      if (p.x < -10) p.x = W + 10; else if (p.x > W + 10) p.x = -10;
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
        const d = dx * dx + dy * dy;
        if (d < link * link) {
          ctx.strokeStyle = hsla(hue + 30, 80, light ? 40 : 70, (1 - Math.sqrt(d) / link) * 0.35);
          ctx.beginPath(); ctx.moveTo(dots[i].x, dots[i].y); ctx.lineTo(dots[j].x, dots[j].y); ctx.stroke();
        }
      }
    }
    for (const p of dots) {
      ctx.fillStyle = hsla(hue + p.k * 60, 85, light ? 45 : 72, 0.8);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + energy * 0.8), 0, Math.PI * 2); ctx.fill();
    }
  }

  function waves() {
    clear();
    const hue = baseHue();
    for (let i = 0; i < 4; i++) {
      const y0 = H * (0.52 + i * 0.1);
      const amp = H * (0.05 + i * 0.012) * (1 + energy * 1.2);
      const f = 0.004 + i * 0.0012;
      const sp = 0.5 + i * 0.22;
      const g = ctx.createLinearGradient(0, y0 - amp, 0, H);
      g.addColorStop(0, hsla(hue + i * 25, 80, light ? 60 : 55, light ? 0.5 : 0.38));
      g.addColorStop(1, hsla(hue + i * 25, 80, light ? 80 : 25, 0.05));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W + 8; x += 8) {
        const y = y0 + Math.sin(x * f + t * sp + i * 2) * amp + Math.sin(x * f * 2.3 - t * sp * 0.7) * amp * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
  }

  function starfield(dt) {
    clear();
    const hue = baseHue();
    // Лёгкая туманность в цвете обложки
    const neb = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    neb.addColorStop(0, hsla(hue, 70, light ? 75 : 30, light ? 0.45 : 0.4));
    neb.addColorStop(1, hsla(hue, 70, 20, 0));
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, W, H);

    const speed = dt * 0.00004 * (1 + energy * 6);
    for (const s of stars) {
      s.z -= speed * (0.5 + s.k);
      if (s.z <= 0.02) { s.z = 1; s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; }
      const sx = W / 2 + (s.x / s.z) * W * 0.35;
      const sy = H / 2 + (s.y / s.z) * H * 0.35;
      if (sx < 0 || sx > W || sy < 0 || sy > H) { s.z = 1; continue; }
      const size = (1 - s.z) * 2.4 + 0.4;
      ctx.fillStyle = hsla(hue + s.k * 80, 70, light ? 35 : 88, Math.min(1, (1 - s.z) * 1.4));
      ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ----- цикл анимации -----
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = now - last;
    if (dt < 28) return; // ~35 кадров/с — достаточно для мягкого фона
    last = now;
    t += dt / 1000;
    // Плавный переход к цвету обложки и сглаженная энергия звука
    for (let i = 0; i < 3; i++) color[i] += (target[i] - color[i]) * 0.04;
    energy += (energyFn() - energy) * 0.2;
    ({ aurora, particles, waves, stars: () => starfield(dt) }[style] || clear)();
  }

  function start() {
    cancelAnimationFrame(raf);
    resize();
    if (style === 'off') {
      // Статичный градиент без анимации
      clear();
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, hsla(baseHue(), 60, light ? 85 : 14, 1));
      g.addColorStop(1, light ? '#e8e8e5' : '#0b0b0b');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { resize(); if (style === 'off') start(); });

  return {
    STYLES,
    init(opts) { style = opts.style; light = opts.light; start(); },
    setStyle(s) { style = s; start(); },
    setLight(v) { light = v; if (style === 'off') start(); },
    // Цвет обложки; null — вернуть фирменный фиолетовый
    setColor(rgb) { target = rgb ? tune(rgb) : [139, 92, 246]; if (style === 'off') { color = [...target]; start(); } },
    setEnergySource(fn) { energyFn = fn; },
    tune,
    get style() { return style; },
  };

  // Подтянуть тусклый/слишком тёмный цвет обложки до приятной яркости
  function tune(rgb) {
    const [h, s, l] = rgbToHsl(rgb);
    const s2 = Math.max(s, 55), l2 = Math.min(Math.max(l, 45), 62);
    const c = (1 - Math.abs(2 * (l2 / 100) - 1)) * (s2 / 100);
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l2 / 100 - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
})();
