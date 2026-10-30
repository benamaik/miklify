// Мелкие элементы интерфейса: контекстное меню, диалоги, уведомления.
const UI = (() => {
  const ctxEl = $('#ctx');
  const modalEl = $('#modal');
  const toastEl = $('#toast');
  let toastTimer = 0;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }

  // ----- контекстное меню -----
  function closeMenu() { ctxEl.classList.add('hidden'); ctxEl.innerHTML = ''; }

  // items: [{label, fn, disabled, header, sep}]
  function menu(x, y, items) {
    ctxEl.innerHTML = '';
    for (const it of items) {
      if (it.sep) { ctxEl.insertAdjacentHTML('beforeend', '<div class="ctx-sep"></div>'); continue; }
      const b = document.createElement(it.header ? 'div' : 'button');
      b.className = it.header ? 'ctx-head' : 'ctx-item';
      b.textContent = it.label;
      if (it.disabled) b.disabled = true;
      if (!it.header && !it.disabled) b.addEventListener('click', () => { closeMenu(); it.fn(); });
      ctxEl.appendChild(b);
    }
    ctxEl.classList.remove('hidden');
    // не выходим за границы окна
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
    ctxEl.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  }

  document.addEventListener('mousedown', (e) => { if (!ctxEl.contains(e.target)) closeMenu(); });
  window.addEventListener('blur', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ----- диалоги (в Electron нет window.prompt/confirm) -----
  function dialog(html, onMount) {
    return new Promise((resolve) => {
      modalEl.innerHTML = `<div class="dlg">${html}</div>`;
      modalEl.classList.remove('hidden');
      const done = (v) => { modalEl.classList.add('hidden'); modalEl.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const input = $('input', modalEl);
      const result = () => (input ? input.value.trim() || null : true);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); done(result()); }
      };
      document.addEventListener('keydown', onKey, true);
      $('[data-r="1"]', modalEl).addEventListener('click', () => done(result()));
      $('[data-r="0"]', modalEl).addEventListener('click', () => done(null));
      modalEl.onmousedown = (e) => { if (e.target === modalEl) done(null); };
      if (input) { input.focus(); input.select(); }
      if (onMount) onMount();
    });
  }

  const ask = ({ title, value = '', placeholder = '', ok = 'ОК' }) =>
    dialog(`<h3>${esc(title)}</h3><input type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80">
      <div class="dlg-btns"><button class="btn ghost" data-r="0">Отмена</button><button class="btn" data-r="1">${esc(ok)}</button></div>`);

  const confirmBox = ({ title, text = '', ok = 'Удалить' }) =>
    dialog(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="dlg-btns"><button class="btn ghost" data-r="0">Отмена</button><button class="btn danger" data-r="1">${esc(ok)}</button></div>`)
      .then((v) => v === true);

  return { toast, menu, closeMenu, ask, confirm: confirmBox };
})();
