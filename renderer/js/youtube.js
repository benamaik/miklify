// Управление встроенным плеером YouTube (iframe со страницей с локального сервера).
// Звук играет сам YouTube, мы только отправляем команды и получаем состояние.
const Yt = (() => {
  const panel = $('#ytPanel');
  const frame = $('#ytFrame');
  let started = false;
  let ready = false;
  const queued = [];        // команды до готовности iframe
  let listeners = {};

  // Состояния плеера YouTube: -1 не начат, 0 конец, 1 играет, 2 пауза, 3 буферизация, 5 в очереди
  const S_ENDED = 0, S_PLAYING = 1, S_BUFFERING = 3;

  function post(msg) {
    if (!ready) { queued.push(msg); return; }
    frame.contentWindow.postMessage({ miklifyYt: true, ...msg }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || !e.data || !e.data.miklifyYt) return;
    const d = e.data;
    if (d.type === 'ready') {
      ready = true;
      queued.splice(0).forEach(post);
    } else if (d.type === 'state') {
      // сначала «не играет», потом «закончился» — иначе следующий трек успеет запуститься и тут же «встанет на паузу»
      listeners.state?.(d.state === S_PLAYING || d.state === S_BUFFERING);
      if (d.state === S_ENDED) listeners.ended?.();
    } else if (d.type === 'time') {
      listeners.time?.(d.t, d.d, d.id);
    } else if (d.type === 'error') {
      listeners.error?.(d.code);
    }
  });

  // Первый запуск: узнаём порт локального сервера и грузим страницу плеера
  async function ensureStarted() {
    if (started) return;
    started = true;
    const port = await api.ytPort();
    frame.src = `http://localhost:${port}/player.html`; // именно localhost: YouTube отказывает страницам с адресом из цифр (127.0.0.1)
  }

  // ----- проверка доступности роликов -----
  // Второй плеер (отдельное окно): основной в это время может играть. Ролик «подгружается» без воспроизведения;
  // если играть его нельзя, плеер сообщает об ошибке за доли секунды.
  const probeBox = $('#ytProbe');
  const probeFrame = $('#ytProbeFrame');
  const BLOCKED_CODES = [100, 101, 150, 153];
  let probeReady = null;      // Promise: страница плеера для проверки загружена
  let probeWait = null;       // ожидание ответа по текущему ролику

  function ensureProbe() {
    if (probeReady) return probeReady;
    probeReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { probeReady = null; reject(new Error('probe timeout')); }, 10000);
      window.addEventListener('message', function onReady(e) {
        if (e.source === probeFrame.contentWindow && e.data?.miklifyYt && e.data.type === 'ready') {
          clearTimeout(timer);
          window.removeEventListener('message', onReady);
          resolve();
        }
      });
      api.ytPort().then((port) => { probeFrame.src = `http://localhost:${port}/player.html`; }).catch(reject);
    });
    return probeReady;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== probeFrame.contentWindow || !e.data?.miklifyYt || !probeWait) return;
    const d = e.data;
    if (d.type === 'error') probeWait.finish(BLOCKED_CODES.includes(d.code) ? 'blocked' : 'unknown');
    else if (d.type === 'state' && d.state === 5) probeWait.finish('ok'); // 5 — ролик подгружен, играть можно
  });

  function probeOne(id) {
    return new Promise((resolve) => {
      const finish = (result) => { clearTimeout(timer); probeWait = null; resolve(result); };
      const timer = setTimeout(() => finish('unknown'), 3000); // нет ответа — считаем, что играть можно
      probeWait = { finish };
      probeFrame.contentWindow.postMessage({ miklifyYt: true, cmd: 'load', id, autoplay: false, start: 0 }, '*');
    });
  }

  // Проверить ролики по очереди. onStep(done, total, id, result) вызывается после каждого.
  async function probe(ids, onStep, cancelled) {
    await ensureProbe();
    const blocked = [];
    for (let i = 0; i < ids.length && !cancelled(); i++) {
      const result = await probeOne(ids[i]);
      if (result === 'blocked') blocked.push(ids[i]);
      onStep(i + 1, ids.length, ids[i], result);
    }
    return blocked;
  }

  // ----- окно мини-плеера: размеры, магнитные позиции, перетаскивание -----
  const cap = $('#ytCap');
  const snapEl = $('#ytSnap');
  // 200x200 — минимальный размер видео по правилам YouTube, меньше делать нельзя
  const VIDEO = { float: { w: 356, h: 200 }, compact: { w: 200, h: 200 } };
  const CHROME_H = 38;       // полоса управления под видео
  const BORDER = 2;          // рамка панели
  const EDGE = 16;           // отступ от края окна
  const BAR = 100;           // внизу окна занято панелью плеера
  const SNAP_DIST = 180;     // с какого расстояния панель притягивается к позиции
  const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br'];

  let view = 'float';            // float | compact | full
  let lastView = 'float';        // куда вернуться из режима «на всё окно»
  let place = { anchor: 'br' };  // {anchor} — прилипла к позиции; {x, y} — стоит там, где оставили
  let drag = null;
  const api_ = {};

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const panelSize = () => ({ w: VIDEO[view].w + BORDER, h: VIDEO[view].h + CHROME_H + BORDER });

  // Координаты всех позиций для панели размером w×h
  function anchorPoints(w, h) {
    const right = innerWidth - w - EDGE, bottom = innerHeight - h - BAR;
    const cx = (innerWidth - w) / 2, cy = (EDGE + bottom) / 2;
    return {
      tl: [EDGE, EDGE], tc: [cx, EDGE], tr: [right, EDGE],
      ml: [EDGE, cy], mr: [right, cy],
      bl: [EDGE, bottom], bc: [cx, bottom], br: [right, bottom],
    };
  }

  function targetRect() {
    if (view === 'full') return { x: 8, y: 8, w: innerWidth - 16, h: innerHeight - BAR - 8 };
    const { w, h } = panelSize();
    if (place.anchor) {
      const [x, y] = anchorPoints(w, h)[place.anchor];
      return { x, y, w, h };
    }
    return { x: clamp(place.x, 0, innerWidth - w), y: clamp(place.y, 0, innerHeight - h - BAR), w, h };
  }

  // Размер и положение анимирует CSS-переход на left/top/width/height
  function applyLayout() {
    const r = targetRect();
    Object.assign(panel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    panel.classList.toggle('compact', view === 'compact');
    panel.classList.toggle('full', view === 'full');

    // Страница под панелью получает отступ, только если панель стоит у нижнего края и перекрывает контент
    const atBottom = view !== 'full' && place.anchor && place.anchor[0] === 'b';
    document.body.style.setProperty('--yt-pad', atBottom ? `${r.h + 12}px` : '0px');

    const compactBtn = $('[data-yt="compact"]', cap), fullBtn = $('[data-yt="full"]', cap);
    compactBtn.innerHTML = icon(view === 'compact' ? 'pip' : 'minimize', 16);
    compactBtn.title = view === 'compact' ? 'Обычный размер' : 'Уменьшить';
    fullBtn.innerHTML = icon(view === 'full' ? 'fullscreenExit' : 'fullscreen', 16);
    fullBtn.title = view === 'full' ? 'Свернуть из режима на всё окно (Esc)' : 'На всё окно';
    cap.title = view === 'full' ? '' : 'Потяните, чтобы переместить. Двойной клик — на всё окно';
  }

  const saveLayout = () => api_.moved?.(place, view);

  function setView(next) {
    if (next === view) return;
    if (next === 'full') lastView = view;
    view = next;
    applyLayout();
    saveLayout();
  }
  const toggleFull = () => setView(view === 'full' ? lastView : 'full');

  // Плавное перетаскивание: за курсором идёт transform (страница не перестраивается), раз в кадр
  function paintDrag() {
    drag.raf = 0;
    const { w, h } = panelSize();
    const x = clamp(drag.x + drag.cx - drag.sx, 0, innerWidth - w);
    const y = clamp(drag.y + drag.cy - drag.sy, 0, innerHeight - h - BAR);
    drag.nowX = x;
    drag.nowY = y;
    panel.style.transform = `translate3d(${x - drag.x}px, ${y - drag.y}px, 0)`;

    // Ближайшая позиция подсвечивается рамкой: отпустите — и панель прилипнет к ней
    const points = anchorPoints(w, h);
    let best = null, bestDist = SNAP_DIST;
    for (const name of ANCHORS) {
      const dist = Math.hypot(points[name][0] - x, points[name][1] - y);
      if (dist < bestDist) { best = name; bestDist = dist; }
    }
    drag.anchor = best;
    snapEl.classList.toggle('hidden', !best);
    if (best) Object.assign(snapEl.style, { left: points[best][0] + 'px', top: points[best][1] + 'px', width: w + 'px', height: h + 'px' });
  }

  cap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || view === 'full' || e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, x: r.left, y: r.top, nowX: r.left, nowY: r.top, anchor: null, raf: 0, moved: false };
    cap.setPointerCapture(e.pointerId); // события идут к полосе, даже когда курсор над видео
    panel.classList.add('dragging');
  });
  cap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    drag.moved = drag.moved || Math.hypot(drag.cx - drag.sx, drag.cy - drag.sy) > 3;
    if (drag.moved && !drag.raf) drag.raf = requestAnimationFrame(paintDrag);
  });
  const endDrag = () => {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    const d = drag;
    drag = null;
    snapEl.classList.add('hidden');
    if (!d.moved) { panel.classList.remove('dragging'); return; }
    // Закрепляем панель там, где её отпустили (переходы пока выключены), и уже оттуда она плавно доезжает до позиции
    panel.style.transform = '';
    panel.style.left = d.nowX + 'px';
    panel.style.top = d.nowY + 'px';
    void panel.offsetWidth;
    panel.classList.remove('dragging');
    place = d.anchor ? { anchor: d.anchor } : { x: d.nowX, y: d.nowY };
    applyLayout();
    saveLayout();
  };
  cap.addEventListener('pointerup', endDrag);
  cap.addEventListener('pointercancel', endDrag);

  cap.addEventListener('click', (e) => {
    const action = e.target.closest('[data-yt]')?.dataset.yt;
    if (action === 'compact') setView(view === 'compact' ? 'float' : 'compact');
    else if (action === 'full') toggleFull();
    else if (action === 'close') api_.closed?.();
  });
  cap.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleFull(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view === 'full' && !panel.classList.contains('hidden')) setView(lastView);
  });
  // При изменении размера окна панель встаёт на место сразу, без «догоняющей» анимации
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (drag) return;
    panel.classList.add('instant');
    applyLayout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => panel.classList.remove('instant'), 120);
  });

  $('[data-yt="open"]', cap).innerHTML = icon('open', 15);
  $('[data-yt="close"]', cap).innerHTML = icon('close', 16);
  applyLayout();

  // Клик по видео отдаёт клавиатурный фокус iframe, и горячие клавиши Miklify (пробел, стрелки) замолкают.
  // Сразу возвращаем фокус основному окну.
  window.addEventListener('blur', () => {
    if (document.activeElement === frame) setTimeout(() => { frame.blur(); window.focus(); }, 0);
  });

  return Object.assign(api_, {
    on(handlers) { listeners = handlers; },
    probe,
    showProbe(v) { probeBox.classList.toggle('hidden', !v); },
    // Запомненные положение и размер из настроек (на весь экран при запуске не открываем)
    restore(savedPlace, savedView) {
      const ok = savedPlace && (ANCHORS.includes(savedPlace.anchor) || (Number.isFinite(savedPlace.x) && Number.isFinite(savedPlace.y)));
      if (ok) place = ANCHORS.includes(savedPlace.anchor) ? { anchor: savedPlace.anchor } : { x: savedPlace.x, y: savedPlace.y };
      if (savedView === 'float' || savedView === 'compact') view = savedView;
      panel.classList.add('instant');
      applyLayout();
      setTimeout(() => panel.classList.remove('instant'), 120);
    },
    // Название играющего ролика в полосе под видео
    setTitle(text) { $('#ytName').textContent = text || 'YouTube'; },
    // Панель с видео обязана быть видна, пока играет YouTube (правила встраивания)
    show(v) {
      panel.classList.toggle('hidden', !v);
      document.body.classList.toggle('yt-on', !!v); // освобождаем место внизу страницы под панель
      if (v) applyLayout();
    },
    load(videoId, { autoplay = true, start = 0 } = {}) {
      ensureStarted();
      post({ cmd: 'load', id: videoId, autoplay, start });
    },
    play() { post({ cmd: 'play' }); },
    pause() { post({ cmd: 'pause' }); },
    stop() { post({ cmd: 'stop' }); },
    seek(t) { post({ cmd: 'seek', t }); },
    volume(v) { post({ cmd: 'volume', v }); },
  });
})();
