// Обмен треками напрямую между двумя Miklify (WebRTC), без сервера.
// Друзья сами передают друг другу короткие коды соединения (в любом мессенджере), дальше файл идёт от компьютера к компьютеру.
const Share = (() => {
  const CHUNK = 16 * 1024;              // размер кусочка в канале
  const READ = 256 * 1024;              // сколько читаем с диска за раз
  const MAX_SIZE = 200 * 1024 * 1024;   // больше принимать не будем
  const AUDIO = /\.(mp3|flac|wav|ogg|m4a)$/i;
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }]; // публичный STUN нужен только чтобы узнать внешний адрес

  let pc = null, ch = null, role = null;
  let file = null;                      // что отправляем: {path, name, size}
  let incoming = null;                  // что принимаем: {name, size, got, parts}
  let finished = false;
  const ui = { file: 'не выбран', offer: '', recvOut: '', text: 'Ожидание', progress: 0 };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtMb = (n) => (n / 1048576).toFixed(1) + ' МБ';

  // ----- коды соединения: описание подключения → короткая строка и обратно -----
  async function encode(desc) {
    const raw = new Blob([new TextEncoder().encode(JSON.stringify({ type: desc.type, sdp: desc.sdp }))]);
    const bytes = new Uint8Array(await new Response(raw.stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return 'MK1:' + btoa(bin);
  }

  async function decode(code, expected) {
    code = String(code || '').trim();
    if (!code.startsWith('MK1:') || code.length > 20000) throw new Error('Это не код Miklify');
    const bytes = Uint8Array.from(atob(code.slice(4)), (c) => c.charCodeAt(0));
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    const d = JSON.parse(text);
    if (d.type !== expected || typeof d.sdp !== 'string') throw new Error(expected === 'offer' ? 'Это ответ, а нужен код друга' : 'Это код друга, а нужен ответ');
    return d;
  }

  // Ждём, пока соберутся адреса для соединения (не дольше 6 секунд)
  const gathered = (conn) => new Promise((resolve) => {
    if (conn.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 6000);
    conn.addEventListener('icegatheringstatechange', () => {
      if (conn.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });

  function status(text, progress) {
    ui.text = text;
    if (progress !== undefined) ui.progress = progress;
    refresh();
  }

  function reset() {
    try { ch?.close(); pc?.close(); } catch { /* уже закрыто */ }
    pc = ch = incoming = null;
    finished = false;
    ui.progress = 0;
  }

  function newConnection() {
    pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onconnectionstatechange = () => {
      if (pc && ['failed', 'disconnected'].includes(pc.connectionState) && !finished) {
        status('Соединение потеряно. Попробуйте ещё раз с новым кодом', 0);
      }
    };
  }

  // ----- канал передачи -----
  function wire() {
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
      if (role === 'send') {
        ch.send(JSON.stringify({ t: 'meta', name: file.name, size: file.size }));
        status(`Соединено. Ждём, пока друг примет «${file.name}»…`);
      } else {
        status('Соединено. Ждём предложение трека…');
      }
    };
    ch.onclose = () => { if (!finished) status('Соединение закрыто', 0); };
    ch.onmessage = (e) => (typeof e.data === 'string' ? onControl(JSON.parse(e.data)) : onChunk(new Uint8Array(e.data)));
  }

  async function onControl(msg) {
    if (role === 'send') {
      if (msg.t === 'accept') await stream();
      else if (msg.t === 'decline') { finished = true; status('Друг отказался принимать трек', 0); }
    } else if (msg.t === 'meta') {
      // имя и размер приходят от другого человека — проверяем до того, как что-то принимать
      const name = String(msg.name || '').slice(0, 200);
      const size = Number(msg.size);
      if (!AUDIO.test(name) || !(size > 0) || size > MAX_SIZE) {
        ch.send(JSON.stringify({ t: 'decline' }));
        status('Друг прислал неподходящий файл — отклонено', 0);
        return;
      }
      const ok = await UI.confirm({ title: 'Принять трек?', text: `«${name}», ${fmtMb(size)}. Файл сохранится в «Музыка\\Miklify».`, ok: 'Принять' });
      if (!ok) { ch.send(JSON.stringify({ t: 'decline' })); status('Вы отклонили трек', 0); return; }
      incoming = { name, size, got: 0, parts: [] };
      ch.send(JSON.stringify({ t: 'accept' }));
      status(`Получаю «${name}»…`, 0);
    } else if (msg.t === 'end') {
      await save();
    }
  }

  function onChunk(bytes) {
    if (role !== 'recv' || !incoming) return;
    incoming.got += bytes.length;
    if (incoming.got > incoming.size) { status('Пришло больше данных, чем заявлено — остановлено', 0); incoming = null; ch.close(); return; }
    incoming.parts.push(bytes);
    status(`Получаю «${incoming.name}»: ${fmtMb(incoming.got)} из ${fmtMb(incoming.size)}`, incoming.got / incoming.size);
  }

  async function stream() {
    let offset = 0;
    status(`Отправляю «${file.name}»…`, 0);
    while (offset < file.size) {
      const block = await api.shareRead(file.path, offset, READ);
      if (!block.length) break;
      for (let i = 0; i < block.length; i += CHUNK) {
        while (ch.bufferedAmount > 1048576) await wait(15); // не заваливаем канал
        ch.send(block.subarray(i, i + CHUNK));
      }
      offset += block.length;
      status(`Отправляю «${file.name}»: ${fmtMb(offset)} из ${fmtMb(file.size)}`, offset / file.size);
    }
    ch.send(JSON.stringify({ t: 'end' }));
    finished = true;
    status(`«${file.name}» отправлен`, 1);
  }

  async function save() {
    const { name, size, got, parts } = incoming;
    if (got !== size) { status('Файл пришёл не полностью — не сохранён', 0); return; }
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    finished = true;
    try {
      const res = await api.shareSave(name, all);
      S.set.folders = res.folders;
      status(`«${name}» получен и добавлен в библиотеку`, 1);
      UI.toast('Трек получен и добавлен в библиотеку');
    } catch (e) {
      status('Не удалось сохранить: ' + cleanErr(e), 0);
    }
    incoming = null;
  }

  // ----- действия со страницы -----
  async function pick() {
    const f = await api.sharePick();
    if (f) preselect(f);
  }

  function preselect(f) {
    // из библиотеки приходит трек с полем path, из окна выбора файла — готовое имя
    const name = f.name || String(f.path).split(/[\\/]/).pop();
    file = { path: f.path, name, size: f.size };
    ui.file = `${name} · ${fmtMb(f.size)}`;
    refresh();
  }

  async function createOffer() {
    if (!file) { UI.toast('Сначала выберите трек'); return; }
    reset();
    role = 'send';
    status('Создаю код…', 0);
    newConnection();
    ch = pc.createDataChannel('file');
    wire();
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    ui.offer = await encode(pc.localDescription);
    status('Код готов. Отправьте его другу и дождитесь его ответа');
  }

  async function connect(answerCode) {
    if (role !== 'send' || !pc) { UI.toast('Сначала создайте код'); return; }
    try {
      await pc.setRemoteDescription(await decode(answerCode, 'answer'));
      status('Соединяюсь…');
    } catch (e) {
      UI.toast(cleanErr(e));
    }
  }

  async function createAnswer(offerCode) {
    try {
      const offer = await decode(offerCode, 'offer');
      reset();
      role = 'recv';
      newConnection();
      pc.ondatachannel = (e) => { ch = e.channel; wire(); };
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      ui.recvOut = await encode(pc.localDescription);
      status('Ответ готов. Отправьте его другу, дальше он запустит передачу');
    } catch (e) {
      UI.toast(cleanErr(e));
    }
  }

  // Подставить сохранённое состояние в поля страницы
  function refresh() {
    const el = (id) => document.getElementById(id);
    if (!el('shText')) return;
    el('shFile').textContent = ui.file;
    el('shOffer').value = ui.offer;
    el('shRecvOut').value = ui.recvOut;
    el('shText').textContent = ui.text;
    el('shBar').style.width = Math.round(ui.progress * 100) + '%';
  }

  async function act(name, arg) {
    if (name === 'sharePick') await pick();
    else if (name === 'shareOffer') await createOffer();
    else if (name === 'shareConnect') await connect(document.getElementById('shAnswerIn').value);
    else if (name === 'shareAnswer') await createAnswer(document.getElementById('shRecvIn').value);
    else if (name === 'shareCopy') {
      const v = document.getElementById(arg).value;
      if (!v) { UI.toast('Пока нечего копировать'); return; }
      await navigator.clipboard.writeText(v);
      UI.toast('Скопировано');
    }
  }

  return { act, preselect, refresh, _state: () => ({ role, ui, hasChannel: !!ch }) };
})();
