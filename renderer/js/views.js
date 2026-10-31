// Страницы приложения. Каждая функция возвращает HTML; события вешаются делегированием в app.js.
const albumKey = (t) => `${t.albumArtist || t.artist}||${t.album}`;
const sumDur = (ids) => ids.reduce((s, id) => s + (trackById(id)?.duration || 0), 0);

// ----- строительные блоки -----
function rowHtml(t, i, o = {}) {
  const liked = S.likes.has(t.id);
  const unavail = isYtBlocked(t); // YouTube не даёт играть: строка приглушена
  const cls = (o.queue ? 'row qrow' : 'row') + (unavail ? ' unavail' : '');
  const extra = o.queue ? ` data-qi="${i}" draggable="true"` : '';
  // У онлайн-треков нет локальных страниц исполнителя/альбома — показываем просто текст
  const artist = t.online ? `<span>${esc(t.artist)}</span>` : `<a data-go="artist" data-arg="${esc(t.artist)}">${esc(t.artist)}</a>`;
  const album = t.online ? `<span class="ralb">${sourceBadge(t)}${t.online === 'youtube' ? '' : esc(t.album)}</span>`
    : `<a class="ralb" data-go="album" data-arg="${esc(albumKey(t))}">${esc(t.album)}</a>`;
  return `<div class="${cls}" data-id="${t.id}" data-i="${i}"${extra}>
    <div class="num"><span class="n">${i + 1}</span><button class="pbtn" title="Играть / пауза"><i class="ic-play">${icon('play', 16)}</i><i class="ic-pause">${icon('pause', 16)}</i></button></div>
    <div class="rt">${coverHtml(t.cover, t.album, 'xs')}
      <div class="rtt"><b>${esc(t.title)}</b>${artist}</div></div>
    ${album}
    <button class="lk icon-btn ${liked ? 'on' : ''}" title="Нравится">${icon(liked ? 'heartFill' : 'heart', 18)}</button>
    <span class="dur">${t.live ? 'ЭФИР' : t.duration ? fmtTime(t.duration) : '—'}</span>
    <button class="mr icon-btn" title="Ещё">${icon('more', 18)}</button>
  </div>`;
}

// Метка источника у онлайн-трека
const sourceBadge = (t) => `<i class="src">${{ radio: 'РАДИО', youtube: 'YOUTUBE', jamendo: 'JAMENDO' }[t.online] || ''}</i>`;

// Список треков; запоминает показанный порядок как «текущий список» для воспроизведения
function trackList(ids, o = {}) {
  S.list = ids;
  S.listCtx = o;
  if (!ids.length) return `<div class="empty-sm">${o.emptyText || 'Здесь пока пусто'}</div>`;
  const rows = ids.map((id, i) => rowHtml(trackById(id), i, o)).join('');
  return `<div class="tl">
    <div class="row head"><div class="num">#</div><div class="rt">Название</div><div class="ralb">Альбом</div><span></span><span class="dur">Время</span><span></span></div>
    ${rows}</div>`;
}

function card(kind, key, title, sub, cover, seed, round = false) {
  return `<div class="card" data-go="${kind}" data-arg="${esc(key)}">
    <div class="card-cv ${round ? 'round' : ''}">${coverHtml(cover, seed)}
      <button class="cplay" data-playkind="${kind}" data-arg="${esc(key)}" title="Играть">${icon('play', 24)}</button></div>
    <b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
}

const albumCard = (a) => card('album', a.key, a.name, `${a.year ? a.year + ' · ' : ''}${a.artist}`, a.cover, a.name);
const artistCard = (a) => card('artist', a.name, a.name, `${a.tracks.length} ${plural(a.tracks.length, 'трек', 'трека', 'треков')}`, a.cover, a.name, true);

function pageHead({ cover, kicker, title, meta, actions = '', round = false }) {
  return `<div class="phead">
    <div class="phead-cv ${round ? 'round' : ''}">${cover}</div>
    <div class="phead-t"><span class="kicker">${kicker}</span><h1>${esc(title)}</h1><div class="meta">${meta}</div><div class="actions">${actions}</div></div>
  </div>`;
}

const playBtn = (kind, arg = '') =>
  `<button class="btn big" data-playkind="${kind}" data-arg="${esc(arg)}">${icon('play', 20)} Играть</button>`;

function emptyLibrary() {
  return `<div class="empty">
    <div class="empty-ic">${icon('folder', 56)}</div>
    <h2>Добавьте свою музыку</h2>
    <p>Выберите папки с mp3, flac, wav, ogg или m4a — Miklify просканирует их вместе с подпапками.</p>
    <button class="btn big" data-act="addFolders">${icon('plus', 20)} Выбрать папки</button>
  </div>`;
}

// Какие id треков соответствуют кнопке «Играть» у карточки/страницы
function idsFor(kind, arg) {
  switch (kind) {
    case 'all': case 'library': return S.tracks.map((t) => t.id);
    case 'liked': return [...S.set.likes].filter((id) => !!trackById(id));
    case 'playlist': {
      if (arg === 'liked') return idsFor('liked');
      const p = S.set.playlists.find((x) => x.id === arg);
      return p ? p.tracks.filter((id) => !!trackById(id)) : [];
    }
    case 'artist': return S.artists.get(arg)?.tracks.map((t) => t.id) || [];
    case 'album': return S.albums.get(arg)?.tracks.map((t) => t.id) || [];
    default: return [];
  }
}

// ----- страницы -----
const Views = {
  home() {
    if (!S.tracks.length) return emptyLibrary();
    const h = new Date().getHours();
    const hello = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
    const quick = [`<div class="quick-tile" data-go="playlist" data-arg="liked">
        <div class="qcv liked">${icon('heartFill', 26)}</div><b>Любимые треки</b>
        <button class="cplay" data-playkind="playlist" data-arg="liked">${icon('play', 22)}</button></div>`]
      .concat(S.set.playlists.slice(0, 5).map((p) => `<div class="quick-tile" data-go="playlist" data-arg="${p.id}">
        <div class="qcv">${coverHtml(plCover(p), p.name, 'xs')}</div><b>${esc(p.name)}</b>
        <button class="cplay" data-playkind="playlist" data-arg="${p.id}">${icon('play', 22)}</button></div>`)).join('');
    const recent = [...S.albums.values()].sort((a, b) => b.added - a.added).slice(0, 12);
    const artists = [...S.artists.values()].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 12);
    return `<h1 class="greet">${hello}</h1>
      <div class="quick">${quick}</div>
      <h2 class="sec">Недавно добавлено</h2><div class="grid">${recent.map(albumCard).join('')}</div>
      <h2 class="sec">Исполнители</h2><div class="grid">${artists.map(artistCard).join('')}</div>`;
  },

  search() {
    return `<div class="search-box">${icon('search', 22)}
        <input id="q" type="text" placeholder="Название, исполнитель или альбом" value="${esc(S.q)}" autocomplete="off">
      </div><div id="results">${searchResults(S.q)}</div>`;
  },

  library() {
    const ids = S.tracks.map((t) => t.id);
    const folders = foldersHtml();
    return `<div class="lib-head"><div><h1>Библиотека</h1>
        <div class="meta">${ids.length} ${plural(ids.length, 'трек', 'трека', 'треков')} · ${fmtTotal(sumDur(ids))}</div></div>
        <div class="actions">
          <button class="btn" data-act="addFolders">${icon('plus', 18)} Добавить папку</button>
          <button class="btn ghost" data-act="rescan">${icon('refresh', 18)} Обновить</button>
        </div></div>
      <div class="chips">${folders}</div>
      ${trackList(ids, { emptyText: 'Библиотека пуста — добавьте папку с музыкой' })}`;
  },

  online() {
    const tab = S.onlineTab;
    const meta = { yt: 'Любая песня с YouTube: поиск, плейлисты, очередь', music: 'Свободная музыка независимых авторов (Jamendo, Creative Commons)', radio: 'Тысячи интернет-радиостанций со всего мира' }[tab];
    const hint = { yt: 'Песня или исполнитель — нажмите Enter', music: 'Трек, исполнитель или жанр', radio: 'Название станции или жанр: jazz, rock, news…' }[tab];
    const tabBtn = (id, ic, label) => `<button data-act="onlineTab" data-arg="${id}" class="${tab === id ? 'active' : ''}">${icon(ic, 16)} ${label}</button>`;
    return `<div class="lib-head"><div><h1>Онлайн</h1>
        <div class="meta">${meta}</div></div>
        <div class="seg">${tabBtn('yt', 'play', 'YouTube')}${tabBtn('music', 'note', 'Свободная музыка')}${tabBtn('radio', 'radio', 'Радио')}</div></div>
      <div class="search-box">${icon('search', 22)}
        <input id="oq" type="text" autocomplete="off" value="${esc(S.oq[tab] || '')}" placeholder="${hint}">
      </div>
      <div id="oresults"><div class="empty-sm">Загрузка…</div></div>`;
  },

  share() {
    const copy = (id) => `<button class="btn ghost" data-act="shareCopy" data-arg="${id}">${icon('copy', 16)} Скопировать</button>`;
    return `<div class="lib-head"><div><h1>Обмен</h1>
        <div class="meta">Отправьте трек другу напрямую: файл идёт от компьютера к компьютеру, никуда не загружается</div></div></div>
      <div class="share-grid">
        <section class="set-sec"><h2>Отправить</h2>
          <ol class="share-steps">
            <li>Выберите трек: <button class="btn ghost" data-act="sharePick">Выбрать файл…</button> <span id="shFile" class="muted">не выбран</span><br>
              <span class="muted">Или правый клик по своему треку → «Отправить другу»</span></li>
            <li><button class="btn" data-act="shareOffer">Создать код</button> и отправьте его другу в любом мессенджере
              <textarea id="shOffer" class="code" readonly placeholder="Здесь появится ваш код"></textarea>${copy('shOffer')}</li>
            <li>Вставьте ответ друга
              <textarea id="shAnswerIn" class="code" placeholder="Ответ друга"></textarea>
              <button class="btn" data-act="shareConnect">Соединить и отправить</button></li>
          </ol></section>
        <section class="set-sec"><h2>Получить</h2>
          <ol class="share-steps">
            <li>Вставьте код друга
              <textarea id="shRecvIn" class="code" placeholder="Код друга, начинается с MK1:"></textarea>
              <button class="btn" data-act="shareAnswer">Создать ответ</button></li>
            <li>Отправьте ответ другу
              <textarea id="shRecvOut" class="code" readonly placeholder="Здесь появится ответ"></textarea>${copy('shRecvOut')}</li>
            <li>Когда друг нажмёт «Соединить», вам предложат принять трек</li>
          </ol></section>
      </div>
      <div class="share-status"><span id="shText">Ожидание</span><div class="bar"><i id="shBar"></i></div></div>
      <p class="attrib">Отправляйте только то, на что у вас есть права. Для соединения используется публичный сервер Google (STUN): он видит только IP-адреса, файл через него не идёт. Принятый трек сохраняется в «Музыка\\Miklify» и появляется в библиотеке.</p>`;
  },

  // Текст совпадает с PRIVACY.md в корне проекта
  legal() {
    const link = (url, text) => `<a class="ext" data-act="openUrl" data-arg="${url}">${text}</a>`;
    return `<div class="legal"><h1>Конфиденциальность и условия</h1>
      <p>Miklify — бесплатный плеер с открытым исходным кодом. У него нет сервера и аккаунтов, разработчик не получает ваших данных и не показывает рекламу от себя.</p>
      <h2>Что хранится на компьютере</h2>
      <p>Настройки, плейлисты, лайки, очередь, кэш библиотеки и обложек, введённые ключи. Всё лежит в папке приложения и никуда не отправляется.</p>
      <h2>YouTube</h2>
      <p>Miklify использует сервисы YouTube API. Пользуясь функциями YouTube в Miklify, вы соглашаетесь с ${link('https://www.youtube.com/t/terms', 'Условиями использования YouTube')}. Ваши данные на YouTube и в Google обрабатываются по ${link('https://policies.google.com/privacy', 'Политике конфиденциальности Google')}.</p>
      <p>Поисковые запросы и страна из языка системы уходят в YouTube Data API. Встроенный плеер YouTube загружается с серверов YouTube, может показывать рекламу и сохранять на компьютере файлы cookie и похожие данные.</p>
      <p>Чтобы показывать только ролики, которые можно проиграть, после поиска встроенный плеер YouTube кратковременно загружает каждый результат без воспроизведения (окно с проверкой видно на экране). Проверку можно выключить в настройках. Список роликов, которые плеер отказался играть, хранится на компьютере 30 дней.</p>
      <p>Данные о роликах (название, канал, обложка, длительность) хранятся локально не дольше 30 дней: потом они обновляются или удаляются. Удалить их сразу можно в разделе «Настройки» → «Данные YouTube». Ролики не скачиваются, а пока окно скрыто или свёрнуто, они не играют.</p>
      <h2>Обмен треками</h2>
      <p>Раздел «Обмен» отправляет файл напрямую на компьютер друга (WebRTC), на сервер Miklify он не загружается, потому что сервера нет. Коды соединения друзья передают друг другу сами. Для соединения используется публичный сервер STUN компании Google: он видит IP-адреса участников, но не файл. Принятые треки сохраняются в «Музыка\\Miklify\\От друзей». Отправляйте только то, на что у вас есть права.</p>
      <h2>Другие сервисы</h2>
      <p>Интернет-радио (Radio Browser) и его станции, Jamendo, а при запуске распознавания AcoustID и Cover Art Archive получают ваш IP-адрес, запросы и, для распознавания, отпечаток звука. Сами файлы не отправляются. Логотипы станций и обложки загружаются с серверов этих сервисов.</p>
      <h2>Вопросы</h2>
      <p>Вопросы и просьбы об удалении данных принимаются в <a class="ext" data-act="openUrl" data-arg="https://github.com/benamaik/miklify/issues">разделе Issues на GitHub</a>.</p></div>`;
  },

  settings() {
    const seg =(act, items, cur) => `<div class="seg wrap">${items.map(([id, name]) =>
      `<button data-act="${act}" data-arg="${id}" class="${id === cur ? 'active' : ''}">${name}</button>`).join('')}</div>`;
    const sw = (attr, on) => `<label class="switch"><input type="checkbox" ${attr} ${on ? 'checked' : ''}><i></i></label>`;
    const eq = Player.eq;
    const bands = Player.EQ_FREQS.map((f, i) => `<div class="eq-band">
        <span class="eq-val">${fmtDb(eq.gains[i])}</span>
        <div class="eq-slot"><input type="range" min="-12" max="12" step="1" value="${eq.gains[i]}" data-band="${i}"></div>
        <span class="eq-f">${f >= 1000 ? f / 1000 + 'k' : f}</span></div>`).join('');
    const keys = [
      ['Пробел', 'Играть / пауза'], ['Ctrl + → / ←', 'Следующий / предыдущий'], ['→ / ←', 'Перемотка ±5 сек'],
      ['Ctrl + ↑ / ↓', 'Громкость'], ['M', 'Выключить звук'], ['L', 'Лайк текущего трека'], ['Ctrl + F', 'Поиск'],
      ['Медиаклавиши', 'Работают, даже когда окно свёрнуто'],
    ];
    return `<h1>Настройки</h1>
      <section class="set-sec"><h2>Внешний вид</h2>
        <div class="set-row"><div class="set-t"><b>Тема</b></div>${seg('theme', [['dark', 'Тёмная'], ['light', 'Светлая']], S.set.theme)}</div>
        <div class="set-row"><div class="set-t"><b>Анимированный фон</b><span>Цвет подстраивается под обложку трека</span></div>
          ${seg('bg', Bg.STYLES.map((s) => [s.id, s.name]), S.set.bg)}</div>
        <div class="set-row"><div class="set-t"><b>Фон реагирует на музыку</b><span>Пульсирует в такт низким частотам</span></div>${sw('data-toggle="bgReact"', S.set.bgReact !== false)}</div>
      </section>

      <section class="set-sec" id="eqSec">
        <div class="set-row"><div class="set-t"><h2>Эквалайзер</h2><span>Поднимайте или убирайте низкие, средние и высокие частоты (−12…+12 дБ). Действует на свою музыку, радио и Jamendo, но не на видео YouTube</span></div>${sw('id="eqOn"', eq.on)}</div>
        <div class="eq-presets">${seg('eqPreset', Object.entries(EQ_PRESETS).map(([id, p]) => [id, p.name]), eq.preset)}</div>
        <div class="eq ${eq.on ? '' : 'off'}">
          <div class="eq-scale"><span>+12</span><span>0</span><span>−12</span></div>${bands}
        </div>
        <div class="eq-legend"><span>← Низкие (бас)</span><span>Средние</span><span>Высокие →</span></div>
      </section>

      <section class="set-sec"><h2>Библиотека</h2>
        <div class="chips">${foldersHtml()}</div>
        <div class="actions">
          <button class="btn" data-act="addFolders">${icon('plus', 18)} Добавить папку</button>
          <button class="btn ghost" data-act="rescan">${icon('refresh', 18)} Пересканировать</button>
        </div>
      </section>

      <section class="set-sec" id="recSec"><h2>Распознавание исполнителей</h2>
        <p class="set-note">Для треков без тегов Miklify снимает «отпечаток» звука и ищет его в базе AcoustID / MusicBrainz:
          так находятся исполнитель, название, альбом и обложка. В интернет уходит только отпечаток — сама музыка остаётся на диске.</p>
        <div class="set-row"><div class="set-t"><b id="keyLabel">Ключ AcoustID</b><span id="keyHint"></span></div>
          <div class="key-row"><input id="acoustidKey" class="field" type="text" spellcheck="false" placeholder="ключ приложения" value="${esc(S.set.acoustidKey || '')}">
            <button class="btn ghost" data-act="getKey">Получить ключ</button></div></div>
        <div class="set-row"><div class="set-t"><b>Без исполнителя: <span id="recCount">${unknownTracks().length}</span></b><span id="recStatus">Проверяю…</span></div>
          <div class="key-row">
            <button class="btn ghost" data-act="recRetry" title="Ещё раз проверить треки, которые не нашлись">Повторить не найденные</button>
            <button class="btn" id="recBtn" data-act="recognize">${S.recognizing ? 'Остановить' : 'Распознать'}</button></div></div>
        <div id="recProg" class="rec-prog hidden"><div class="bar"><i></i></div><span></span></div>
      </section>

      <section class="set-sec"><h2>Данные YouTube</h2>
        <div class="set-row"><div class="set-t"><b>Сохранённые данные о роликах</b><span>Хранятся не дольше 30 дней. Удаление уберёт ролики из лайков, плейлистов и очереди</span></div>
          <button class="btn ghost" data-act="deleteYoutubeData">Удалить</button></div>
        <div class="set-row"><div class="set-t"><b>Проверять, что результаты можно проиграть</b><span>После поиска плеер YouTube на несколько секунд подгружает каждый ролик без воспроизведения и убирает те, которые не играет. Окно проверки видно на экране</span></div>${sw('data-toggle="ytProbe"', S.set.ytProbe !== false)}</div>
        <div class="set-row"><div class="set-t"><b>Конфиденциальность и условия</b><span>Какие данные использует Miklify и условия YouTube</span></div>
          <button class="btn ghost" data-go="legal">Открыть</button></div>
      </section>

      <section class="set-sec"><h2>Поведение</h2>
        <div class="set-row"><div class="set-t"><b>Сворачивать в трей при закрытии</b><span>Музыка продолжит играть; выход — через значок в трее</span></div>${sw('data-toggle="closeToTray"', S.set.closeToTray !== false)}</div>
      </section>

      <section class="set-sec"><h2>Горячие клавиши</h2>
        <div class="keys">${keys.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div>
      </section>`;
  },

  artists() {
    const list = [...S.artists.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return `<h1>Исполнители</h1>` + (list.length ? `<div class="grid">${list.map(artistCard).join('')}</div>` : emptyLibrary());
  },

  albums() {
    const list = [...S.albums.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return `<h1>Альбомы</h1>` + (list.length ? `<div class="grid">${list.map(albumCard).join('')}</div>` : emptyLibrary());
  },

  artist(name) {
    const a = S.artists.get(name);
    if (!a) return '<div class="empty-sm">Исполнитель не найден</div>';
    const albums = [...a.albums].map((k) => S.albums.get(k)).filter(Boolean);
    const ids = a.tracks.map((t) => t.id);
    return pageHead({
      cover: coverHtml(a.cover, a.name), round: true, kicker: 'Исполнитель', title: a.name,
      meta: `${ids.length} ${plural(ids.length, 'трек', 'трека', 'треков')} · ${albums.length} ${plural(albums.length, 'альбом', 'альбома', 'альбомов')}`,
      actions: playBtn('artist', a.name),
    }) + `<h2 class="sec">Альбомы</h2><div class="grid">${albums.map(albumCard).join('')}</div>
      <h2 class="sec">Все треки</h2>${trackList(ids)}`;
  },

  album(key) {
    const a = S.albums.get(key);
    if (!a) return '<div class="empty-sm">Альбом не найден</div>';
    const ids = a.tracks.map((t) => t.id);
    return pageHead({
      cover: coverHtml(a.cover, a.name), kicker: 'Альбом', title: a.name,
      meta: `<a data-go="artist" data-arg="${esc(a.artist)}">${esc(a.artist)}</a>${a.year ? ' · ' + a.year : ''} · ${ids.length} ${plural(ids.length, 'трек', 'трека', 'треков')} · ${fmtTotal(sumDur(ids))}`,
      actions: playBtn('album', a.key),
    }) + trackList(ids);
  },

  playlists() {
    const liked = idsFor('liked');
    const cards = [card('playlist', 'liked', 'Любимые треки', `${liked.length} ${plural(liked.length, 'трек', 'трека', 'треков')}`, null, 'liked-songs')]
      .concat(S.set.playlists.map((p) => card('playlist', p.id, p.name, `${p.tracks.length} ${plural(p.tracks.length, 'трек', 'трека', 'треков')}`, plCover(p), p.name)));
    return `<div class="lib-head"><h1>Плейлисты</h1>
        <div class="actions"><button class="btn" data-act="newPlaylist">${icon('plus', 18)} Новый плейлист</button></div></div>
      <div class="grid">${cards.join('')}</div>`;
  },

  playlist(id) {
    const isLiked = id === 'liked';
    const p = isLiked ? { id, name: 'Любимые треки' } : S.set.playlists.find((x) => x.id === id);
    if (!p) return '<div class="empty-sm">Плейлист не найден</div>';
    const ids = idsFor('playlist', id);
    const cover = isLiked ? `<div class="cover liked-cv">${icon('heartFill', 64)}</div>` : coverHtml(plCover(p), p.name);
    const actions = playBtn('playlist', id) + (isLiked ? '' : `
      <button class="btn ghost" data-act="renamePlaylist" data-arg="${id}">${icon('edit', 18)} Переименовать</button>
      <button class="btn ghost" data-act="deletePlaylist" data-arg="${id}">${icon('trash', 18)} Удалить</button>`);
    return pageHead({
      cover, kicker: 'Плейлист', title: p.name,
      meta: `${ids.length} ${plural(ids.length, 'трек', 'трека', 'треков')} · ${fmtTotal(sumDur(ids))}`, actions,
    }) + trackList(ids, { playlist: id, emptyText: isLiked ? 'Нажмите ♥ у трека, чтобы он появился здесь' : 'Добавляйте треки через контекстное меню (правая кнопка мыши)' });
  },

  queue() {
    const q = Player.queue;
    const cur = Player.index;
    const head = `<div class="lib-head"><div><h1>Очередь</h1><div class="meta">${q.length} ${plural(q.length, 'трек', 'трека', 'треков')} · перетащите строку, чтобы изменить порядок</div></div>
      <div class="actions"><button class="btn ghost" data-act="clearQueue">${icon('trash', 18)} Очистить следующие</button></div></div>`;
    if (!q.length) return head + '<div class="empty-sm">Очередь пуста — запустите любой трек</div>';
    S.list = q;
    S.listCtx = { queue: true };
    const rows = q.map((id, i) => rowHtml(trackById(id), i, { queue: true }).replace('class="row qrow"', `class="row qrow${i === cur ? ' current' : ''}"`)).join('');
    return head + `<div class="tl">${rows}</div>`;
  },
};

// ----- результаты онлайн-поиска -----
function stationCard(t) {
  const fav = S.set.radioFav.includes(t.id);
  const cv = t.cover ? `<div class="cover"><img src="${esc(t.cover)}" alt="" loading="lazy"></div>`
    : `<div class="cover ph" style="--l:${13 + (hashStr(t.title) % 10)}%">${icon('radio', 30)}</div>`;
  return `<div class="card station" data-station="${t.id}">
    <div class="card-cv">${cv}
      <button class="cplay" data-station-play="${t.id}" title="Слушать">${icon('play', 24)}</button></div>
    <div class="st-t"><div><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
      <button class="icon-btn ${fav ? 'on' : ''}" data-act="radioFav" data-arg="${t.id}" title="В избранное">${icon(fav ? 'heartFill' : 'heart', 18)}</button></div>
  </div>`;
}

// Форма подключения Jamendo прямо во вкладке «Онлайн»
function jamendoKeyForm(bad) {
  return `<div class="jm-key">
    <h2>Подключите Jamendo</h2>
    <p>Jamendo — полные треки независимых музыкантов, бесплатно и легально. Нужен ключ приложения (Client ID):</p>
    <ol>
      <li>Откройте devportal.jamendo.com и войдите (можно через Google).</li>
      <li>В разделе <b>My Apps</b> создайте приложение с любым названием, например Miklify.</li>
      <li>Скопируйте <b>Client ID</b> и вставьте сюда.</li>
    </ol>
    <div class="key-row">
      <input id="jmKey" class="field" type="text" spellcheck="false" autocomplete="off" placeholder="Client ID, например 1a2b3c4d" value="${esc(S.set.jamendoKey || '')}">
      <button class="btn" data-act="saveJamendoKey">Подключить</button>
      <button class="btn ghost" data-act="openUrl" data-arg="https://devportal.jamendo.com">Где взять ключ</button>
    </div>
    ${bad ? '<p class="err">Jamendo не принял этот ключ. Проверьте, что скопирован именно Client ID, без пробелов.</p>' : ''}
    <p class="muted-note">Ключ хранится только на этом компьютере. Пока его нет, работает вкладка «Радио».</p>
  </div>`;
}

// Согласие перед первым использованием функций YouTube
function youtubeConsent() {
  return `<div class="jm-key">
    <h2>Перед началом</h2>
    <p>Поиск и воспроизведение работают через сервисы YouTube API. Продолжая, вы принимаете <a class="ext" data-go="legal">политику конфиденциальности Miklify</a>,
      <a class="ext" data-act="openUrl" data-arg="https://www.youtube.com/t/terms">Условия использования YouTube</a> и соглашаетесь с тем, что ваши данные у Google обрабатываются по его
      <a class="ext" data-act="openUrl" data-arg="https://policies.google.com/privacy">Политике конфиденциальности</a>.</p>
    <div class="key-row"><button class="btn" data-act="ytConsent">Принимаю</button></div>
  </div>`;
}

// Форма подключения поиска YouTube прямо во вкладке «Онлайн»
const YT_ERRORS = {
  BAD_KEY: 'YouTube не принял этот ключ. Проверьте, что он скопирован целиком, без пробелов.',
  NOT_ENABLED: 'Ключ верный, но в вашем проекте не включён YouTube Data API v3. Откройте «APIs & Services → Library», найдите его и нажмите Enable.',
};
function youtubeKeyForm(errorCode) {
  return `<div class="jm-key">
    <h2>Подключите поиск YouTube</h2>
    <p>Miklify ищет по каталогу YouTube через его официальный API, а играет трек встроенным плеером YouTube. Нужен бесплатный ключ (это делается один раз, около 3 минут):</p>
    <ol>
      <li>Откройте Google Cloud Console и войдите в аккаунт Google. Создайте проект с любым названием.</li>
      <li>В <b>APIs &amp; Services → Library</b> найдите <b>YouTube Data API v3</b> и нажмите <b>Enable</b>.</li>
      <li>В <b>APIs &amp; Services → Credentials</b> выберите <b>Create credentials → API key</b>, скопируйте ключ и вставьте сюда.</li>
    </ol>
    <div class="key-row">
      <input id="ytKey" class="field" type="text" spellcheck="false" autocomplete="off" placeholder="Ключ API, начинается с AIza…" value="${esc(S.set.youtubeKey || '')}">
      <button class="btn" data-act="saveYoutubeKey">Подключить</button>
      <button class="btn ghost" data-act="openUrl" data-arg="https://console.cloud.google.com/apis/library/youtube.googleapis.com">Открыть Google Cloud</button>
    </div>
    ${YT_ERRORS[errorCode] ? `<p class="err">${YT_ERRORS[errorCode]}</p>` : ''}
    <p class="muted-note">Ключ хранится только на этом компьютере. Бесплатной квоты хватает примерно на 100 поисков в день.</p>
  </div>`;
}

function onlineResults(tab, q, items, error) {
  if (tab === 'yt') {
    if (['NO_KEY', 'BAD_KEY', 'NOT_ENABLED'].includes(error)) return youtubeKeyForm(error);
    if (error === 'QUOTA') {
      return `<div class="empty-sm">Дневной лимит поиска YouTube исчерпан (около 100 запросов). Он сбросится завтра, а пока работают свои треки и радио.
        · <a data-act="changeYoutubeKey">Сменить ключ</a></div>`;
    }
    if (error) return `<div class="empty-sm">Не удалось загрузить: ${esc(error)}</div>`;
    // Ролики, которые плеер YouTube уже отказался играть, не показываем
    const playable = items.filter((t) => !isYtBlocked(t));
    return `<h2 class="sec">${q ? 'Результаты' : 'Популярное сейчас'}</h2>`
      + trackList(playable.map((t) => t.id), { online: true, emptyText: `Ничего не найдено по запросу «${esc(q)}»` })
      + `<p class="attrib">Видео воспроизводится встроенным плеером YouTube (с рекламой, если она есть у ролика); эквалайзер на нём не действует. · <a data-act="changeYoutubeKey">Сменить ключ</a> · <a data-go="legal">Условия</a></p>`;
  }
  if (tab === 'music') {
    if (error === 'NO_KEY' || error === 'BAD_KEY') return jamendoKeyForm(error === 'BAD_KEY');
    if (error) return `<div class="empty-sm">Не удалось загрузить: ${esc(error)}</div>`;
    return `<h2 class="sec">${q ? 'Результаты' : 'Популярное за неделю'}</h2>`
      + trackList(items.map((t) => t.id), { online: true, emptyText: `Ничего не найдено по запросу «${esc(q)}»` })
      + `<p class="attrib">Музыка с Jamendo под лицензиями Creative Commons. Лицензия трека — в меню «⋯». · <a data-act="changeJamendoKey">Сменить ключ Jamendo</a></p>`;
  }
  if (error) return `<div class="empty-sm">Не удалось загрузить станции: ${esc(error)}</div>`;
  const favs = S.set.radioFav.map((id) => trackById(id)).filter(Boolean);
  return (favs.length && !q ? `<h2 class="sec">Избранные станции</h2><div class="grid">${favs.map(stationCard).join('')}</div>` : '')
    + `<h2 class="sec">${q ? 'Станции' : 'Популярные станции'}</h2>`
    + (items.length ? `<div class="grid">${items.map(stationCard).join('')}</div>` : `<div class="empty-sm">Ничего не найдено по запросу «${esc(q)}»</div>`);
}

// Пресеты эквалайзера (дБ для полос 32 Гц … 16 кГц)
const EQ_PRESETS = {
  flat: { name: 'Ровный', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Больше баса', gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  treble: { name: 'Больше высоких', gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
  vocal: { name: 'Вокал', gains: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  rock: { name: 'Рок', gains: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5] },
  electro: { name: 'Электроника', gains: [6, 5, 2, 0, -2, 1, 0, 2, 4, 5] },
  classic: { name: 'Классика', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  custom: { name: 'Свой', gains: null },
};

// Треки, у которых в тегах нет исполнителя и которые ещё не распознаны
const unknownTracks = () => S.tracks.filter((t) => (t.unknown ?? t.artist === 'Неизвестный исполнитель') && !t.recognized);

const fmtDb = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);

function foldersHtml() {
  return S.set.folders.map((f) => `<span class="chip" title="${esc(f)}">${icon('folder', 16)}<span>${esc(f)}</span>
      <button data-act="removeFolder" data-arg="${esc(f)}" title="Убрать папку">${icon('close', 14)}</button></span>`).join('')
    || '<span class="muted">Папки не выбраны</span>';
}

// Обложка плейлиста — обложка первого трека с картинкой
function plCover(p) {
  for (const id of p.tracks) { const t = trackById(id); if (t && t.cover) return t.cover; }
  return null;
}

// Результаты поиска (в реальном времени)
function searchResults(q) {
  q = q.trim().toLowerCase();
  if (!q) return `<div class="empty-sm">Начните вводить — результаты появятся сразу</div>`;
  const has = (s) => s.toLowerCase().includes(q);
  const tracks = S.tracks.filter((t) => has(t.title) || has(t.artist) || has(t.album)).map((t) => t.id);
  const artists = [...S.artists.values()].filter((a) => has(a.name)).slice(0, 8);
  const albums = [...S.albums.values()].filter((a) => has(a.name)).slice(0, 8);
  if (!tracks.length && !artists.length && !albums.length) return `<div class="empty-sm">Ничего не найдено по запросу «${esc(q)}»</div>`;
  const shown = tracks.slice(0, 300);
  return (artists.length ? `<h2 class="sec">Исполнители</h2><div class="grid">${artists.map(artistCard).join('')}</div>` : '')
    + (albums.length ? `<h2 class="sec">Альбомы</h2><div class="grid">${albums.map(albumCard).join('')}</div>` : '')
    + (tracks.length ? `<h2 class="sec">Треки</h2>${trackList(shown)}` : '');
}
