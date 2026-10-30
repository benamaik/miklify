// Главный модуль интерфейса: состояние, навигация, события, плеер-бар.
const S = {
  tracks: [], byId: new Map(), artists: new Map(), albums: new Map(),
  set: {},            // настройки из main (громкость, плейлисты, лайки...)
  likes: new Set(),
  view: { name: 'home', arg: null },
  hist: [], hi: -1,
  list: [], listCtx: {}, // треки, показанные на текущей странице
  q: '',
  online: new Map(),  // онлайн-треки и станции (Jamendo, радио): id → трек
  onlineTab: 'yt',
  oq: { yt: '', music: '', radio: '' }, // запросы на вкладках «Онлайн»
  oRes: {},                     // последние результаты по вкладкам
};

const viewEl = $('#view');
let dragFrom = -1;

// ----- сохранение настроек -----
function saveSet(patch) {
  Object.assign(S.set, patch);
  api.setState(patch);
}

// Трек по id: сначала локальная библиотека, потом онлайн
function trackById(id) {
  return S.byId.get(id) || S.online.get(id);
}

// Онлайн-треки, попавшие в очередь, лайки или плейлисты, сохраняем — иначе после перезапуска их не найти
function rememberOnline(ids) {
  const store = S.set.onlineTracks || (S.set.onlineTracks = {});
  let changed = false;
  for (const id of ids) {
    const t = S.online.get(id);
    if (t && !store[id]) { store[id] = t; changed = true; }
  }
  if (changed) saveSet({ onlineTracks: store });
}

// ----- ролики, которые YouTube не разрешает играть -----
// Плеер YouTube сам сообщает об отказе (запрещено встраивание, ролик закрыт). Запоминаем это: такие треки
// пропадают из результатов поиска, в списках выглядят приглушёнными, а очередь проходит мимо них.
function isYtBlocked(t) {
  const b = t && t.videoId && S.set.ytBlocked?.[t.videoId];
  return !!b && Date.now() - b.at < YT_MAX_DAYS * DAY_MS;
}

function markYtBlocked(t, code, { quiet = false } = {}) {
  if (!t.videoId) return;
  const blocked = S.set.ytBlocked || (S.set.ytBlocked = {});
  blocked[t.videoId] = { at: Date.now(), code };
  saveSet({ ytBlocked: blocked });
  // списки: приглушаем строки на месте, чтобы не сбрасывать прокрутку
  $$(`.row[data-id="${t.id}"]`).forEach((r) => r.classList.add('unavail'));
  // поиск YouTube: убираем ролик из результатов (при проверке — один раз в конце, чтобы список не мигал)
  if (!quiet && S.view.name === 'online' && S.onlineTab === 'yt') runOnlineSearch();
}

// Проверка результатов поиска заранее: API YouTube про многие ролики говорит «встраивать можно», а плеер
// всё равно отказывается (права, страна, возраст), и узнать это можно только у самого плеера.
S.ytOk = new Set(); // ролики, которые плеер уже принял в этом запуске
async function probeYoutubeResults(items, token) {
  const todo = items.filter((t) => t.videoId && !isYtBlocked(t) && !S.ytOk.has(t.videoId));
  if (!todo.length || S.set.ytProbe === false) return;
  const cap = $('#ytProbeCap'), bar = $('#ytProbeBar');
  const cancelled = () => token !== S.oToken || S.view.name !== 'online' || S.onlineTab !== 'yt';
  Yt.showProbe(true);
  let found = 0;
  try {
    await Yt.probe(todo.map((t) => t.videoId), (done, total, id, result) => {
      if (result === 'ok') S.ytOk.add(id);
      if (result === 'blocked') { found++; markYtBlocked(todo[done - 1], 150, { quiet: true }); }
      cap.textContent = `Проверяю, что можно проиграть: ${done} / ${total}${found ? ` · недоступно ${found}` : ''}`;
      bar.style.width = (done / total) * 100 + '%';
    }, cancelled);
  } catch {
    // плеер для проверки не загрузился (нет сети) — показываем результаты как есть
  } finally {
    Yt.showProbe(false);
    bar.style.width = '0';
  }
  if (found && !cancelled()) runOnlineSearch(); // перерисовать список без недоступных
}

// Данные, которым больше 30 дней, не храним: через месяц ролик можно проверить заново
function expireYtBlocked() {
  const blocked = S.set.ytBlocked || {};
  let changed = false;
  for (const [id, b] of Object.entries(blocked)) {
    if (Date.now() - b.at >= YT_MAX_DAYS * DAY_MS) { delete blocked[id]; changed = true; }
  }
  if (changed) saveSet({ ytBlocked: blocked });
}

// ----- данные YouTube: правила разрешают хранить их не дольше 30 дней -----
const DAY_MS = 24 * 3600 * 1000;
const YT_REFRESH_DAYS = 25; // обновляем заранее, чтобы успеть до срока
const YT_MAX_DAYS = 30;

// Удалить ролики отовсюду: сохранённые данные, лайки, плейлисты, очередь
function removeYoutubeData(ids) {
  if (!ids.length) return;
  const gone = new Set(ids);
  const store = S.set.onlineTracks || {};
  for (const id of ids) { delete store[id]; S.online.delete(id); S.likes.delete(id); }
  for (const p of S.set.playlists) p.tracks = p.tracks.filter((id) => !gone.has(id));
  saveSet({ onlineTracks: store, likes: [...S.likes], playlists: S.set.playlists });
  Player.prune();
}

async function refreshYoutubeData() {
  expireYtBlocked();
  const store = S.set.onlineTracks || {};
  const now = Date.now();
  const all = Object.values(store).filter((t) => t.online === 'youtube');
  let changed = false;
  for (const t of all) if (!t.fetchedAt) { t.fetchedAt = now; changed = true; } // записи, сделанные до появления даты

  // Ролики, которые нигде не используются, не обновляем, а просто убираем
  const used = new Set([...S.likes, ...S.set.playlists.flatMap((p) => p.tracks), ...Player.queue]);
  const stale = all.filter((t) => now - t.fetchedAt >= YT_REFRESH_DAYS * DAY_MS);
  removeYoutubeData(stale.filter((t) => !used.has(t.id)).map((t) => t.id));

  const keep = stale.filter((t) => used.has(t.id));
  if (keep.length) {
    try {
      const res = await api.youtubeRefresh(keep.map((t) => t.videoId), ytRegion());
      for (const t of res.tracks) {
        const old = store['yt:' + t.videoId];
        store[t.id] = { ...t, duration: t.duration || old?.duration || 0 };
        S.online.set(t.id, store[t.id]);
      }
      changed = true;
      removeYoutubeData(res.missing.map((id) => 'yt:' + id));
    } catch (e) {
      // Без рабочего ключа обновить нечем — по истечении срока данные удаляем.
      // Лимит и сбой сети временные: попробуем при следующем запуске.
      if (['NO_KEY', 'BAD_KEY', 'NOT_ENABLED'].includes(cleanErr(e))) {
        removeYoutubeData(keep.filter((t) => now - t.fetchedAt >= YT_MAX_DAYS * DAY_MS).map((t) => t.id));
      }
    }
  }
  if (changed) saveSet({ onlineTracks: store });
  renderSidebarPlaylists();
  if (S.view.name !== 'settings') render();
}

async function deleteYoutubeData() {
  const ok = await UI.confirm({
    title: 'Удалить данные YouTube?',
    text: 'Ролики исчезнут из лайков, плейлистов и очереди. Ключ останется, его можно сменить во вкладке «Онлайн».',
  });
  if (!ok) return;
  const ids = Object.values(S.set.onlineTracks || {}).filter((t) => t.online === 'youtube').map((t) => t.id);
  delete S.oRes.yt;
  saveSet({ ytBlocked: {} });
  removeYoutubeData(ids);
  renderSidebarPlaylists();
  UI.toast('Данные YouTube удалены');
}

// Плеер узнал настоящую длительность трека, у которого она не была записана
function onTrackDuration(t) {
  if (t.online && S.set.onlineTracks?.[t.id]) {
    S.set.onlineTracks[t.id].duration = t.duration;
    saveSet({ onlineTracks: S.set.onlineTracks });
  }
  $$(`.row[data-id="${t.id}"] .dur`).forEach((el) => { el.textContent = fmtTime(t.duration); });
}

// Ошибка из main приходит с префиксом «Error invoking remote method…» — убираем его
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ----- библиотека -----
function setLibrary(tracks) {
  S.tracks = tracks;
  S.byId = new Map(tracks.map((t) => [t.id, t]));
  S.artists = new Map();
  S.albums = new Map();
  for (const t of tracks) {
    let ar = S.artists.get(t.artist);
    if (!ar) S.artists.set(t.artist, (ar = { name: t.artist, tracks: [], albums: new Set(), cover: null }));
    ar.tracks.push(t);
    ar.cover = ar.cover || t.cover;

    const key = albumKey(t);
    let al = S.albums.get(key);
    if (!al) S.albums.set(key, (al = { key, name: t.album, artist: t.albumArtist || t.artist, tracks: [], cover: null, year: 0, added: 0 }));
    al.tracks.push(t);
    al.cover = al.cover || t.cover;
    al.year = al.year || t.year;
    al.added = Math.max(al.added, t.addedAt || 0);
    ar.albums.add(key);
  }
  for (const al of S.albums.values()) al.tracks.sort((a, b) => a.trackNo - b.trackNo || a.title.localeCompare(b.title));
}

// ----- навигация -----
function go(name, arg = null, push = true) {
  if (push) {
    S.hist = S.hist.slice(0, S.hi + 1);
    S.hist.push({ name, arg });
    S.hi = S.hist.length - 1;
  }
  S.view = { name, arg };
  render();
  if (name === 'search') $('#q')?.focus();
}

function render() {
  const { name, arg } = S.view;
  viewEl.innerHTML = Views[name](arg);
  viewEl.scrollTop = 0;
  const q = $('#q');
  if (q) q.addEventListener('input', () => { S.q = q.value; $('#results').innerHTML = searchResults(S.q); markPlaying(); });
  if (name === 'settings') bindSettings();
  if (name === 'online') bindOnline();
  syncNav();
  markPlaying();
}

// Подсветка текущей страницы в боковой панели
function syncNav() {
  const section = { artist: 'artists', album: 'albums', playlist: 'playlists' }[S.view.name] || S.view.name;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.go === section));
  $$('.side-pl .pl-item').forEach((b) => b.classList.toggle('active', S.view.name === 'playlist' && b.dataset.arg === S.view.arg));
  $('#back').disabled = S.hi <= 0;
  $('#fwd').disabled = S.hi >= S.hist.length - 1;
}

function renderSidebarPlaylists() {
  const items = [{ id: 'liked', name: 'Любимые треки' }, ...S.set.playlists];
  $('#sidePl').innerHTML = items.map((p) =>
    `<button class="pl-item" data-go="playlist" data-arg="${p.id}">${icon(p.id === 'liked' ? 'heartFill' : 'playlist', 18)}<span>${esc(p.name)}</span></button>`).join('');
  syncNav();
}

// Подсветка играющего трека в списках
function markPlaying() {
  const cur = Player.current();
  const isQueue = S.view.name === 'queue';
  $$('.row[data-id]').forEach((r) => {
    const on = isQueue ? +r.dataset.qi === Player.index : cur && r.dataset.id === cur.id;
    r.classList.toggle('playing', !!on);
    r.classList.toggle('paused', !!on && !Player.playing);
  });
  $$('.station').forEach((c) => c.classList.toggle('playing', !!cur && c.dataset.station === cur.id));
}

// ----- онлайн: Jamendo и радио -----
let onlineTimer = 0;
function bindOnline() {
  const input = $('#oq');
  // Enter в поле ключа — то же, что «Подключить»
  $('#oresults').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'jmKey') runAction('saveJamendoKey');
    if (e.target.id === 'ytKey') runAction('saveYoutubeKey');
  });
  input.addEventListener('input', () => {
    S.oq[S.onlineTab] = input.value;
    // Поиск YouTube расходует квоту (100 поисков в день), поэтому он запускается только по Enter
    if (S.onlineTab === 'yt') return;
    clearTimeout(onlineTimer);
    onlineTimer = setTimeout(runOnlineSearch, 400);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && S.onlineTab === 'yt') runOnlineSearch();
  });
  runOnlineSearch();
}

// Страна для списка «популярное» на YouTube — из языка системы (uk-UA → UA)
const ytRegion = () => (navigator.language.split('-')[1] || 'US').toUpperCase();

async function runOnlineSearch() {
  const tab = S.onlineTab;
  // До согласия с условиями к YouTube не обращаемся
  if (tab === 'yt' && !S.set.ytConsent) { $('#oresults').innerHTML = youtubeConsent(); return; }
  const q = (S.oq[tab] || '').trim();
  const box = () => (S.view.name === 'online' && S.onlineTab === tab ? $('#oresults') : null);
  const show = ({ items, error }) => {
    const b = box();
    if (b) { b.innerHTML = onlineResults(tab, q, items, error); markPlaying(); }
  };
  const cached = S.oRes[tab];
  if (cached && cached.q === q) { show(cached); return; }

  const token = (S.oToken = (S.oToken || 0) + 1); // ответ на устаревший запрос игнорируем
  let items = [], error = null;
  try {
    items = tab === 'yt' ? await api.youtubeSearch(q, ytRegion())
      : tab === 'music' ? await api.jamendoSearch(q) : await api.radioSearch(q);
  } catch (e) {
    error = cleanErr(e);
  }
  if (token !== S.oToken) return;
  for (const t of items) S.online.set(t.id, t);
  S.oRes[tab] = { q, items, error };
  show(S.oRes[tab]);
  if (tab === 'yt' && !error) probeYoutubeResults(items, token);
}

function toggleRadioFav(id) {
  const fav = S.set.radioFav || [];
  rememberOnline([id]);
  saveSet({ radioFav: fav.includes(id) ? fav.filter((x) => x !== id) : [...fav, id] });
  runOnlineSearch();
}

async function downloadTrack(t) {
  UI.toast(`Скачиваю «${t.title}»…`);
  try {
    const res = await api.download(t);
    S.set.folders = res.folders;
    UI.toast('Скачано в папку «Музыка\\Miklify» — появится в библиотеке');
  } catch (e) {
    UI.toast('Не удалось скачать: ' + cleanErr(e));
  }
}

// ----- лайки и плейлисты -----
function toggleLike(id) {
  rememberOnline([id]);
  if (S.likes.has(id)) S.likes.delete(id); else S.likes.add(id);
  saveSet({ likes: [...S.likes] });
  // обновляем сердечки на месте, чтобы не сбрасывать прокрутку
  $$(`.row[data-id="${id}"] .lk`).forEach((b) => {
    const on = S.likes.has(id);
    b.classList.toggle('on', on);
    b.innerHTML = icon(on ? 'heartFill' : 'heart', 18);
  });
  if (Player.current()?.id === id) updatePlayerBar();
  if (S.view.name === 'playlist' && S.view.arg === 'liked') render();
}

async function createPlaylist(trackIds = []) {
  const name = await UI.ask({ title: 'Новый плейлист', placeholder: 'Название', ok: 'Создать' });
  if (!name) return null;
  rememberOnline(trackIds);
  const p = { id: uid(), name, tracks: [...trackIds] };
  saveSet({ playlists: [...S.set.playlists, p] });
  renderSidebarPlaylists();
  if (S.view.name === 'playlists') render();
  UI.toast(`Плейлист «${name}» создан`);
  return p;
}

function addToPlaylist(pid, ids) {
  const p = S.set.playlists.find((x) => x.id === pid);
  if (!p) return;
  rememberOnline(ids);
  const fresh = ids.filter((id) => !p.tracks.includes(id));
  p.tracks.push(...fresh);
  saveSet({ playlists: S.set.playlists });
  UI.toast(fresh.length ? `Добавлено в «${p.name}»` : `Уже в «${p.name}»`);
}

function removeFromPlaylist(pid, id) {
  const p = S.set.playlists.find((x) => x.id === pid);
  if (!p) return;
  p.tracks = p.tracks.filter((x) => x !== id);
  saveSet({ playlists: S.set.playlists });
  render();
}

// ----- контекстное меню трека -----
function trackMenu(t, x, y) {
  const inPl = S.listCtx.playlist && S.listCtx.playlist !== 'liked';
  const idx = S.list.indexOf(t.id);
  const items = [
    { label: 'Играть', fn: () => Player.playList(S.list, Math.max(0, idx)) },
    { label: 'Играть следующим', fn: () => { Player.addNext([t.id]); UI.toast('Будет играть следующим'); } },
    { label: 'Добавить в конец очереди', fn: () => { Player.addEnd([t.id]); UI.toast('Добавлено в очередь'); } },
    { sep: true },
    { label: S.likes.has(t.id) ? 'Убрать из любимых' : 'Добавить в любимые', fn: () => toggleLike(t.id) },
    { sep: true },
    { label: 'Добавить в плейлист', header: true },
    ...S.set.playlists.map((p) => ({ label: p.name, fn: () => addToPlaylist(p.id, [t.id]) })),
    { label: '＋ Новый плейлист…', fn: async () => { const p = await createPlaylist([t.id]); if (p) UI.toast(`Добавлено в «${p.name}»`); } },
  ];
  if (inPl) items.push({ sep: true }, { label: 'Убрать из этого плейлиста', fn: () => removeFromPlaylist(S.listCtx.playlist, t.id) });
  if (t.online) {
    if (t.download || t.license || t.online === 'youtube') items.push({ sep: true });
    if (t.online === 'youtube') items.push({ label: 'Открыть на YouTube', fn: () => api.openUrl('https://www.youtube.com/watch?v=' + t.videoId) });
    if (t.download) items.push({ label: 'Скачать в библиотеку', fn: () => downloadTrack(t) });
    if (t.license) items.push({ label: 'Лицензия (Creative Commons)', fn: () => api.openUrl(t.license) });
  } else {
    items.push({ sep: true },
      { label: 'Перейти к исполнителю', fn: () => go('artist', t.artist) },
      { label: 'Перейти к альбому', fn: () => go('album', albumKey(t)) });
  }
  UI.menu(x, y, items);
}

// ----- плеер-бар -----
function updatePlayerBar() {
  const t = Player.current();
  $('#npTitle').textContent = t ? t.title : 'Ничего не играет';
  $('#npArtist').textContent = t ? t.artist : '';
  $('#npCover').innerHTML = t ? coverHtml(t.cover, t.album, 'fill') : '';
  const liked = t && S.likes.has(t.id);
  $('#npLike').innerHTML = t ? icon(liked ? 'heartFill' : 'heart', 20) : '';
  $('#npLike').classList.toggle('on', !!liked);
  $('#bPlay').innerHTML = icon(Player.playing ? 'pause' : 'play', 26);
  $('#bShuffle').classList.toggle('on', Player.shuffle);
  const rep = $('#bRepeat');
  rep.classList.toggle('on', Player.repeat !== 'off');
  rep.innerHTML = icon('repeat', 20) + (Player.repeat === 'one' ? '<i class="badge">1</i>' : '');
  $('#bQueue').classList.toggle('on', S.view.name === 'queue');
  const v = Player.volume;
  $('#vol').value = Math.round(v * 100);
  $('#vol').style.setProperty('--p', Math.round(v * 100) + '%');
  $('#bMute').innerHTML = icon(v === 0 ? 'mute' : 'volume', 22);
  updateTime();

  if (t?.online === 'youtube') Yt.setTitle(`${t.artist} — ${t.title}`);
  api.nowPlaying(t ? `${t.artist} — ${t.title}` : '', Player.playing);
  markPlaying();
  if (S.view.name === 'queue' && !seekDragging) render();
}

let seekDragging = false;
function updateTime() {
  const seek = $('#seek');
  const cur = Player.currentTime;
  // Радио — прямой эфир: длительности нет, перематывать нельзя
  if (Player.current()?.live) {
    $('#tDur').textContent = 'ЭФИР';
    $('#tCur').textContent = fmtTime(cur);
    seek.disabled = true;
    seek.value = 0;
    seek.style.setProperty('--p', '0%');
    return;
  }
  seek.disabled = false;
  const dur = isFinite(Player.duration) && Player.duration > 0 ? Player.duration : (Player.current()?.duration || 0);
  $('#tDur').textContent = fmtTime(dur);
  if (seekDragging) return;
  $('#tCur').textContent = fmtTime(cur);
  const p = dur ? Math.round((cur / dur) * 1000) : 0;
  $('#seek').value = p;
  $('#seek').style.setProperty('--p', p / 10 + '%');
}

// ----- события -----
function bindEvents() {
  // боковая панель, навигация
  $$('#nav button').forEach((b) => {
    const ic = { home: 'home', search: 'search', online: 'globe', library: 'library', artists: 'artist', albums: 'album', playlists: 'playlist', settings: 'settings' }[b.dataset.go];
    const label = { home: 'Главная', search: 'Поиск', online: 'Онлайн', library: 'Библиотека', artists: 'Исполнители', albums: 'Альбомы', playlists: 'Плейлисты', settings: 'Настройки' }[b.dataset.go];
    b.innerHTML = `${icon(ic, 22)}<span>${label}</span>`;
  });
  $('#newPl').innerHTML = icon('plus', 18);
  $('#back').innerHTML = icon('back', 22);
  $('#fwd').innerHTML = icon('fwd', 22);
  $('#btnSettings').innerHTML = `${icon('settings', 20)}<span>Настройки</span>`;
  $('#bEq').innerHTML = icon('eq', 20);
  $('#bShuffle').innerHTML = icon('shuffle', 20);
  $('#bPrev').innerHTML = icon('prev', 24);
  $('#bNext').innerHTML = icon('next', 24);
  $('#bQueue').innerHTML = icon('queue', 20);

  $('#back').onclick = () => { if (S.hi > 0) { S.hi--; go(S.hist[S.hi].name, S.hist[S.hi].arg, false); } };
  $('#fwd').onclick = () => { if (S.hi < S.hist.length - 1) { S.hi++; go(S.hist[S.hi].name, S.hist[S.hi].arg, false); } };
  $('#newPl').onclick = () => createPlaylist();
  $('#bQueue').onclick = () => go('queue');
  $('#btnSettings').onclick = () => go('settings');
  $('#bEq').onclick = () => {
    if (S.view.name !== 'settings') go('settings');
    $('#eqSec')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // плеер
  $('#bPlay').onclick = () => Player.toggle();
  $('#bNext').onclick = () => Player.next();
  $('#bPrev').onclick = () => Player.prev();
  $('#bShuffle').onclick = () => Player.toggleShuffle();
  $('#bRepeat').onclick = () => Player.cycleRepeat();
  $('#npLike').onclick = () => { const t = Player.current(); if (t) toggleLike(t.id); };
  $('#vol').oninput = (e) => Player.setVolume(e.target.value / 100);
  let preMute = 0.8;
  $('#bMute').onclick = () => {
    if (Player.volume > 0) { preMute = Player.volume; Player.setVolume(0); } else Player.setVolume(preMute || 0.8);
  };
  const seek = $('#seek');
  // Пока ползунок держат, время не перерисовывает его. Раньше pointerup сбрасывал положение
  // ползунка обратно на текущее время ДО события change — и перемотка «не срабатывала».
  seek.addEventListener('pointerdown', () => { seekDragging = true; });
  seek.addEventListener('input', () => {
    seekDragging = true;
    const dur = Player.duration || 0;
    $('#tCur').textContent = fmtTime((seek.value / 1000) * dur);
    seek.style.setProperty('--p', seek.value / 10 + '%');
  });
  seek.addEventListener('change', () => {
    Player.seek((seek.value / 1000) * (Player.duration || 0));
    seekDragging = false;
    seek.blur(); // иначе стрелки на клавиатуре двигали бы ползунок вдобавок к перемотке ±5 с
    updateTime();
  });
  // Клик без сдвига не даёт change — снимаем флаг после того, как change (если был) отработает
  document.addEventListener('pointerup', () => { if (seekDragging) setTimeout(() => { seekDragging = false; }, 0); });

  document.addEventListener('player:update', updatePlayerBar);
  document.addEventListener('player:time', updateTime);

  // клики внутри страницы (делегирование)
  viewEl.addEventListener('click', onViewClick);
  document.addEventListener('click', onNavClick);
  viewEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-id]');
    if (!row || e.target.closest('button, a')) return;
    playRow(row);
  });
  viewEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    e.preventDefault();
    trackMenu(trackById(row.dataset.id), e.clientX, e.clientY);
  });

  // перетаскивание в очереди
  viewEl.addEventListener('dragstart', (e) => {
    const r = e.target.closest('.qrow');
    if (!r) return;
    dragFrom = +r.dataset.qi;
    r.classList.add('drag');
    e.dataTransfer.effectAllowed = 'move';
  });
  viewEl.addEventListener('dragover', (e) => {
    const r = e.target.closest('.qrow');
    if (!r || dragFrom < 0) return;
    e.preventDefault();
    $$('.qrow.over').forEach((x) => x.classList.remove('over'));
    r.classList.add('over');
  });
  viewEl.addEventListener('drop', (e) => {
    const r = e.target.closest('.qrow');
    if (!r || dragFrom < 0) return;
    e.preventDefault();
    const from = dragFrom;
    dragFrom = -1;
    Player.move(from, +r.dataset.qi);
    render();
  });
  viewEl.addEventListener('dragend', () => { dragFrom = -1; $$('.qrow.drag, .qrow.over').forEach((x) => x.classList.remove('drag', 'over')); });

  // Ссылка под видео YouTube
  $('#ytPanel').addEventListener('click', (e) => {
    const cur = Player.current();
    if (e.target.closest('[data-yt="open"]') && cur?.videoId) api.openUrl('https://www.youtube.com/watch?v=' + cur.videoId);
  });

  // Битые картинки (логотипы радиостанций, обложки из сети) просто скрываем
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);

  // кнопки не должны перехватывать пробел
  document.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(() => document.activeElement?.blur?.(), 0); });

  // горячие клавиши
  document.addEventListener('keydown', onKey);
}

function onNavClick(e) {
  const nav = e.target.closest('#nav [data-go], .side-pl [data-go], .legal-link');
  if (nav) go(nav.dataset.go, nav.dataset.arg || null);
}

// Тот же трек, что уже играет, не перезапускаем — только пауза/продолжить
function playRow(row) {
  const i = S.listCtx.queue ? +row.dataset.qi : S.list.indexOf(row.dataset.id);
  const t = trackById(row.dataset.id);
  if (isYtBlocked(t)) { UI.toast(`YouTube не разрешает играть «${t.title}» вне своего сайта`); return; }
  const isCurrent = S.listCtx.queue ? i === Player.index : Player.current()?.id === row.dataset.id;
  if (isCurrent) { Player.toggle(); return; }
  if (S.listCtx.queue) Player.playIndex(i);
  else Player.playList(S.list, Math.max(0, i));
}

// Кнопка «Играть» у альбома/плейлиста/станции: если играет именно он — пауза/продолжить
function playOrToggle(ids, start = 0) {
  const q = Player.queue;
  if (q.length === ids.length && ids.every((id, i) => id === q[i])) { Player.toggle(); return; }
  Player.playList(ids, start);
}

function onViewClick(e) {
  const t = e.target;

  // «Играть» у карточек и заголовков страниц
  const pk = t.closest('[data-playkind]');
  if (pk) {
    e.stopPropagation();
    const ids = idsFor(pk.dataset.playkind, pk.dataset.arg);
    if (!ids.length) { UI.toast('Здесь нет треков'); return; }
    playOrToggle(ids, Player.shuffle ? Math.floor(Math.random() * ids.length) : 0);
    return;
  }

  const act = t.closest('[data-act]');
  if (act) { runAction(act.dataset.act, act.dataset.arg); return; }

  // Карточка радиостанции: клик — слушать
  const st = t.closest('[data-station-play], .station');
  if (st) { playOrToggle([st.dataset.stationPlay || st.dataset.station]); return; }

  const row = t.closest('.row[data-id]');
  if (row && !row.classList.contains('head')) {
    if (t.closest('.lk')) { toggleLike(row.dataset.id); return; }
    if (t.closest('.mr')) {
      const r = t.closest('.mr').getBoundingClientRect();
      trackMenu(trackById(row.dataset.id), r.left - 190, r.bottom);
      return;
    }
    if (t.closest('.pbtn')) { playRow(row); return; }
  }

  const g = t.closest('[data-go]');
  if (g) go(g.dataset.go, g.dataset.arg || null);
}

async function runAction(act, arg) {
  switch (act) {
    case 'addFolders': S.set.folders = await api.addFolders(); break;
    case 'removeFolder': S.set.folders = await api.removeFolder(arg); break;
    case 'rescan': api.rescan(); UI.toast('Обновляю библиотеку…'); break;
    case 'newPlaylist': createPlaylist(); break;
    case 'clearQueue': Player.clearUpcoming(); break;
    case 'getKey': api.openAcoustid(); break;
    case 'openUrl': api.openUrl(arg); break;
    case 'onlineTab': S.onlineTab = arg; render(); break;
    case 'radioFav': toggleRadioFav(arg); break;
    case 'saveJamendoKey': {
      const key = ($('#jmKey')?.value || '').trim();
      if (!key) { UI.toast('Вставьте Client ID'); $('#jmKey')?.focus(); break; }
      saveSet({ jamendoKey: key });
      delete S.oRes.music; // перезапросить с новым ключом
      $('#oresults').innerHTML = '<div class="empty-sm">Проверяю ключ…</div>';
      await runOnlineSearch();
      if (!S.oRes.music?.error) UI.toast('Jamendo подключён');
      break;
    }
    case 'ytConsent': saveSet({ ytConsent: true }); runOnlineSearch(); break;
    case 'deleteYoutubeData': deleteYoutubeData(); break;
    case 'saveYoutubeKey': {
      const key = ($('#ytKey')?.value || '').trim();
      if (!key) { UI.toast('Вставьте ключ'); $('#ytKey')?.focus(); break; }
      saveSet({ youtubeKey: key });
      delete S.oRes.yt;
      $('#oresults').innerHTML = '<div class="empty-sm">Проверяю ключ…</div>';
      await runOnlineSearch();
      if (!S.oRes.yt?.error) UI.toast('YouTube подключён');
      break;
    }
    case 'changeYoutubeKey':
      S.oRes.yt = { q: (S.oq.yt || '').trim(), items: [], error: 'NO_KEY' };
      runOnlineSearch();
      break;
    case 'changeJamendoKey':
      S.oRes.music = { q: (S.oq.music || '').trim(), items: [], error: 'NO_KEY' };
      runOnlineSearch();
      break;
    case 'recognize': startRecognize(); break;
    case 'recRetry': if (!S.recognizing) { await api.retryRecognize(); startRecognize(); } break;
    case 'theme': applyTheme(arg); break;
    case 'bg': Bg.setStyle(arg); saveSet({ bg: arg }); syncSettings(); break;
    case 'eqPreset': {
      const p = EQ_PRESETS[arg];
      Player.setEq({ preset: arg, gains: p.gains || Player.eq.gains, on: true });
      syncEqUi();
      break;
    }
    case 'renamePlaylist': {
      const p = S.set.playlists.find((x) => x.id === arg);
      const name = p && await UI.ask({ title: 'Переименовать плейлист', value: p.name, ok: 'Сохранить' });
      if (name) { p.name = name; saveSet({ playlists: S.set.playlists }); renderSidebarPlaylists(); render(); }
      break;
    }
    case 'deletePlaylist': {
      const p = S.set.playlists.find((x) => x.id === arg);
      if (p && await UI.confirm({ title: `Удалить «${p.name}»?`, text: 'Сами треки на диске не удаляются.' })) {
        saveSet({ playlists: S.set.playlists.filter((x) => x.id !== arg) });
        renderSidebarPlaylists();
        go('playlists');
      }
      break;
    }
  }
  if (act === 'removeFolder' || act === 'addFolders') render();
}

// ----- тема и фон -----
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  Bg.setLight(theme === 'light');
  saveSet({ theme });
  syncSettings();
}
function syncSettings() {
  $$('[data-act="theme"]').forEach((b) => b.classList.toggle('active', b.dataset.arg === S.set.theme));
  $$('[data-act="bg"]').forEach((b) => b.classList.toggle('active', b.dataset.arg === S.set.bg));
}

// ----- страница настроек: переключатели и эквалайзер -----
function bindSettings() {
  $$('[data-toggle]', viewEl).forEach((cb) => {
    cb.onchange = () => saveSet({ [cb.dataset.toggle]: cb.checked });
  });
  $('#eqOn').onchange = (e) => { Player.setEq({ on: e.target.checked }); syncEqUi(); };
  $('#acoustidKey').onchange = (e) => { saveSet({ acoustidKey: e.target.value.trim() }); syncRecognizeUi(); };
  syncRecognizeUi();
  $$('[data-band]', viewEl).forEach((r) => {
    r.oninput = () => {
      const gains = [...Player.eq.gains];
      gains[+r.dataset.band] = +r.value;
      Player.setEq({ gains, preset: 'custom', on: true });
      syncEqUi();
    };
  });
  syncEqUi();
}

// ----- распознавание исполнителей -----
async function syncRecognizeUi() {
  const status = $('#recStatus');
  if (!status) return;
  const st = await api.recognizeStatus();
  $('#recCount').textContent = unknownTracks().length;
  // Со встроенным ключом пользователю ничего вводить не нужно — поле только для своего ключа
  $('#keyLabel').textContent = st.builtinKey ? 'Свой ключ AcoustID (необязательно)' : 'Ключ AcoustID';
  $('#keyHint').textContent = st.builtinKey ? 'Не нужен: в Miklify уже встроен ключ приложения'
    : 'Бесплатно: войдите на acoustid.org и зарегистрируйте приложение';
  const hasKey = st.builtinKey || !!S.set.acoustidKey;
  status.textContent = !st.fpcalc ? 'Не найден fpcalc.exe — выполните npm run get-fpcalc'
    : !hasKey ? 'Нужен ключ AcoustID'
    : 'Готово к распознаванию';
  $('#recBtn').disabled = !S.recognizing && (!st.fpcalc || !hasKey);
  $('#recBtn').textContent = S.recognizing ? 'Остановить' : 'Распознать';
}

async function startRecognize() {
  if (S.recognizing) { api.cancelRecognize(); return; }
  S.recognizing = true;
  syncRecognizeUi();
  const res = await api.recognize();
  S.recognizing = false;
  syncRecognizeUi();
  if (res.error) UI.toast(res.error);
  else UI.toast(res.done ? `Распознано ${res.found} из ${res.done}` : 'Нечего распознавать');
}

function showRecognizeProgress(p) {
  const box = $('#scanBox');
  const prog = $('#recProg');
  if (!p) {
    box.classList.add('hidden');
    prog?.classList.add('hidden');
    return;
  }
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  box.classList.remove('hidden');
  box.innerHTML = `<span>Распознавание: ${p.done} / ${p.total} · найдено ${p.found}</span><div class="bar"><i style="width:${pct}%"></i></div>`;
  if (prog) {
    prog.classList.remove('hidden');
    $('i', prog).style.width = pct + '%';
    $('span', prog).textContent = `${p.done} / ${p.total} · найдено ${p.found}${p.current ? ' · ' + p.current : ''}`;
  }
}

// Обновить ползунки EQ без перерисовки страницы (чтобы не сбрасывать прокрутку)
function syncEqUi() {
  const eq = Player.eq;
  const box = $('.eq', viewEl);
  if (!box) return;
  box.classList.toggle('off', !eq.on);
  $('#eqOn').checked = eq.on;
  $$('[data-band]', viewEl).forEach((r) => {
    const v = eq.gains[+r.dataset.band];
    r.value = v;
    r.style.setProperty('--p', ((v + 12) / 24) * 100 + '%');
    r.closest('.eq-band').querySelector('.eq-val').textContent = fmtDb(v);
  });
  $$('[data-act="eqPreset"]').forEach((b) => b.classList.toggle('active', b.dataset.arg === eq.preset));
}

// ----- горячие клавиши -----
function onKey(e) {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range';
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); go('search'); return; }
  if (typing) return;
  const k = e.key;
  // Зажатая клавиша шлёт повторы. Перемотке и громкости это на руку, а пауза, переключение,
  // лайк и звук должны срабатывать один раз на нажатие.
  const held = k === ' ' || /^[ml]$/i.test(k) || (e.ctrlKey && (k === 'ArrowLeft' || k === 'ArrowRight'));
  if (e.repeat && held) { e.preventDefault(); return; }
  if (k === ' ') { e.preventDefault(); Player.toggle(); }
  else if (e.ctrlKey && k === 'ArrowRight') { e.preventDefault(); Player.next(); }
  else if (e.ctrlKey && k === 'ArrowLeft') { e.preventDefault(); Player.prev(); }
  else if (e.ctrlKey && k === 'ArrowUp') { e.preventDefault(); Player.setVolume(Player.volume + 0.05); }
  else if (e.ctrlKey && k === 'ArrowDown') { e.preventDefault(); Player.setVolume(Player.volume - 0.05); }
  else if (k === 'ArrowRight') { Player.seekBy(5); }
  else if (k === 'ArrowLeft') { Player.seekBy(-5); }
  else if (k.toLowerCase() === 'm') { $('#bMute').click(); }
  else if (k.toLowerCase() === 'l') { const t = Player.current(); if (t) toggleLike(t.id); }
}

// ----- запуск -----
async function boot() {
  const { settings, tracks } = await api.init();
  S.set = settings;
  S.likes = new Set(settings.likes);
  S.online = new Map(Object.entries(settings.onlineTracks || {}));
  S.set.radioFav = settings.radioFav || [];
  // положение и размер видео-панели запоминаем (старая настройка ytPos — просто координаты)
  Yt.restore(settings.ytLayout?.place ?? settings.ytPos, settings.ytLayout?.view);
  Yt.moved = (place, view) => saveSet({ ytLayout: { place, view } });
  // «Закрыть» у видео = пауза и убрать окно: YouTube нельзя играть, когда плеер не виден
  Yt.closed = () => Player.closeVideo();
  setLibrary(tracks);

  document.documentElement.dataset.theme = settings.theme || 'dark';
  Bg.init({ style: settings.bg || 'waves', light: settings.theme === 'light' });
  Bg.setEnergySource(() => (S.set.bgReact === false ? 0 : Player.energy()));

  bindEvents();
  syncSettings();
  renderSidebarPlaylists();
  S.set.ytBlocked = settings.ytBlocked || {};
  // До исправления адреса плеера (127.0.0.1 → localhost) YouTube отказывал почти всей музыке, и в «недоступные»
  // попадали рабочие песни. Один раз сбрасываем этот список, чтобы они снова появились в результатах.
  if (settings.ytBlockedReset !== 1) {
    S.set.ytBlocked = {};
    saveSet({ ytBlocked: {}, ytBlockedReset: 1 });
  }
  Player.init({
    getTrackFn: (id) => trackById(id), state: settings, onUseFn: rememberOnline, onDurationFn: onTrackDuration,
    isBlockedFn: isYtBlocked, onBlockedFn: markYtBlocked,
  });
  updatePlayerBar();
  go('home');

  api.on('cmd', (c) => (c === 'toggle' ? Player.toggle() : c === 'next' ? Player.next() : Player.prev()));

  api.on('library:updated', (list) => {
    setLibrary(list);
    Player.prune();
    // из лайков и плейлистов убираем только отображение — id сохраняем на случай возврата файла
    render();
    updatePlayerBar();
    UI.toast(`Библиотека: ${list.length} ${plural(list.length, 'трек', 'трека', 'треков')}`);
  });

  api.on('window:visible', (v) => Player.setWindowVisible(v));
  refreshYoutubeData();

  api.on('recognize:progress', showRecognizeProgress);
  api.recognizeStatus().then((st) => { S.recognizing = st.running; });

  const box = $('#scanBox');
  api.on('scan:progress', (p) => {
    if (!p) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `<span>Сканирование: ${p.done} / ${p.total}</span><div class="bar"><i style="width:${p.total ? (p.done / p.total) * 100 : 0}%"></i></div>`;
  });
}

boot();
