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
    frame.src = `http://127.0.0.1:${port}/player.html`;
  }

  // ----- перетаскивание панели за нижнюю полосу -----
  const cap = $('#ytCap');
  let pos = null;            // {x, y} — левый верхний угол в пикселях; null — положение по умолчанию (справа внизу)
  let drag = null;
  const api_ = {};

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  // Поставить панель на pos, не выпуская за границы окна
  function applyPos() {
    if (!pos) {
      Object.assign(panel.style, { left: '', top: '', right: '', bottom: '' });
      return;
    }
    const w = panel.offsetWidth || 356, h = panel.offsetHeight || 234;
    pos = { x: clamp(pos.x, 0, innerWidth - w), y: clamp(pos.y, 0, innerHeight - h) };
    Object.assign(panel.style, { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' });
  }

  cap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('a')) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    cap.setPointerCapture(e.pointerId); // события идут к полосе, даже когда курсор над видео
    panel.classList.add('dragging');
  });
  cap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    applyPos();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('dragging');
    api_.moved?.(pos);
  };
  cap.addEventListener('pointerup', endDrag);
  cap.addEventListener('pointercancel', endDrag);
  // Двойной клик по полосе — вернуть панель на место
  cap.addEventListener('dblclick', (e) => {
    if (e.target.closest('a')) return;
    pos = null;
    applyPos();
    api_.moved?.(null);
  });
  window.addEventListener('resize', () => { if (pos) applyPos(); });

  // Клик по видео отдаёт клавиатурный фокус iframe, и горячие клавиши Miklify (пробел, стрелки) замолкают.
  // Сразу возвращаем фокус основному окну.
  window.addEventListener('blur', () => {
    if (document.activeElement === frame) setTimeout(() => { frame.blur(); window.focus(); }, 0);
  });

  return Object.assign(api_, {
    on(handlers) { listeners = handlers; },
    // Запомненное положение из настроек
    setPos(p) { pos = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null; applyPos(); },
    // Панель с видео обязана быть видна, пока играет YouTube (правила встраивания)
    show(v) {
      panel.classList.toggle('hidden', !v);
      document.body.classList.toggle('yt-on', !!v); // освобождаем место внизу страницы под панель
      if (v) applyPos(); // размер панели известен только когда она показана
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
