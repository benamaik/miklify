// Онлайн-источники: Jamendo (полные треки под Creative Commons) и Radio Browser (интернет-радио).
// Все запросы идут из основного процесса — ключи и сеть не попадают в интерфейс напрямую.
const fs = require('fs');
const path = require('path');

const UA = 'Miklify/1.0 (local music player)';
let radioHost = null;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ----- Radio Browser -----

// Сервис просит выбирать случайный сервер из списка, а не обращаться к одному
async function radioBase() {
  if (radioHost) return radioHost;
  try {
    const names = [...new Set((await getJson('https://all.api.radio-browser.info/json/servers')).map((s) => s.name))];
    radioHost = 'https://' + names[Math.floor(Math.random() * names.length)];
  } catch {
    radioHost = 'https://de1.api.radio-browser.info';
  }
  return radioHost;
}

function station(s) {
  const tags = (s.tags || '').split(',').filter(Boolean).slice(0, 2).join(', ');
  return {
    id: 'radio:' + s.stationuuid,
    uuid: s.stationuuid,
    online: 'radio',
    live: true,
    url: s.url_resolved || s.url,
    title: (s.name || 'Станция').trim(),
    artist: [s.country, tags].filter(Boolean).join(' · ') || 'Интернет-радио',
    album: 'Интернет-радио',
    duration: 0,
    cover: s.favicon || null,
  };
}

// Поиск по названию и по жанру-тегу; пустой запрос — самые популярные станции
async function radioSearch(q) {
  const base = await radioBase();
  const params = (extra) => new URLSearchParams({ limit: '60', hidebroken: 'true', order: 'clickcount', reverse: 'true', ...extra });
  q = (q || '').trim();
  const lists = q
    ? await Promise.all([
      getJson(`${base}/json/stations/search?${params({ name: q })}`),
      getJson(`${base}/json/stations/search?${params({ tag: q.toLowerCase() })}`),
    ])
    : [await getJson(`${base}/json/stations/search?${params({})}`)];
  const seen = new Set();
  return lists.flat().filter((s) => s.url_resolved && !seen.has(s.stationuuid) && seen.add(s.stationuuid)).map(station);
}

// Радио-каталог просит сообщать о прослушивании — так считается популярность станций
function radioClick(uuid) {
  radioBase().then((base) => fetch(`${base}/json/url/${encodeURIComponent(uuid)}`, { headers: { 'User-Agent': UA } })).catch(() => {});
}

// ----- Jamendo -----

function jamendoTrack(t) {
  return {
    id: 'jm:' + t.id,
    online: 'jamendo',
    url: t.audio,
    title: t.name,
    artist: t.artist_name,
    album: t.album_name || 'Jamendo',
    duration: +t.duration || 0,
    cover: t.image || t.album_image || null,
    download: t.audiodownload_allowed ? t.audiodownload : null,
    license: t.license_ccurl || null,
  };
}

// Пустой запрос — популярное за неделю
async function jamendoSearch(clientId, q) {
  if (!clientId) throw new Error('NO_KEY');
  const p = new URLSearchParams({ client_id: clientId, format: 'json', limit: '50', audioformat: 'mp32', imagesize: '200' });
  q = (q || '').trim();
  if (q) { p.set('search', q); p.set('order', 'relevance'); } else p.set('order', 'popularity_week');
  const json = await getJson('https://api.jamendo.com/v3.0/tracks/?' + p);
  if (json.headers?.code === 5) throw new Error('BAD_KEY'); // Jamendo: «Invalid Client Id»
  if (json.headers?.status !== 'success') throw new Error(json.headers?.error_message || 'Jamendo: ошибка');
  return json.results.filter((t) => t.audio).map(jamendoTrack);
}

// Скачать трек Jamendo (если автор разрешил) в папку библиотеки
async function download(track, dir) {
  if (!track.download) throw new Error('Автор не разрешил скачивание этого трека');
  // Адрес приходит из интерфейса — качаем только с серверов Jamendo
  const { protocol, hostname } = new URL(track.download);
  if (protocol !== 'https:' || !(hostname === 'jamendo.com' || hostname.endsWith('.jamendo.com'))) {
    throw new Error('Неизвестный источник файла');
  }
  const res = await fetch(track.download, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe(track.artist)} - ${safe(track.title)}.mp3`);
  await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// ----- YouTube (официальный Data API; воспроизведение — через встроенный плеер YouTube) -----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeHtml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENTITIES[e.toLowerCase()] ?? m;
});

// PT1H2M3S → секунды
function isoSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

async function ytApi(key, endpoint, params) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [k, v] of Object.entries({ ...params, key })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  const e = json.error || {};
  const text = `${e.errors?.[0]?.reason || ''} ${e.status || ''} ${e.message || ''}`;
  if (/keyInvalid|API key not valid|API_KEY_INVALID/i.test(text)) throw new Error('BAD_KEY');
  if (/quota|dailyLimitExceeded|rateLimitExceeded/i.test(text)) throw new Error('QUOTA');
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(text)) throw new Error('NOT_ENABLED');
  throw new Error(e.message || `YouTube: HTTP ${res.status}`);
}

// Название ролика → «исполнитель — трек». Каналы «Artist - Topic» дают чистого исполнителя.
function youtubeTrack(item) {
  const sn = item.snippet;
  let title = decodeHtml(sn.title);
  let artist = decodeHtml(sn.channelTitle) || 'YouTube';
  if (/ - Topic$/i.test(artist)) {
    artist = artist.replace(/ - Topic$/i, '');
  } else {
    const m = /^(.{2,60}?)\s+[-–—]\s+(.+)$/.exec(title);
    if (m) { artist = m[1]; title = m[2]; }
    artist = artist.replace(/VEVO$/i, '').trim();
  }
  const clean = title.replace(/\s*[(\[][^)\]]*(official|video|audio|lyric|visualizer|clip|\bhd\b|4k|клип|аудио|текст)[^)\]]*[)\]]/gi, '').trim();
  const th = sn.thumbnails || {};
  return {
    id: 'yt:' + item.id,
    online: 'youtube',
    videoId: item.id,
    channelId: sn.channelId || null,
    url: null,
    title: clean || title,
    artist,
    album: 'YouTube',
    duration: isoSeconds(item.contentDetails?.duration),
    cover: (th.medium || th.high || th.default || {}).url || null,
    fetchedAt: Date.now(), // правила YouTube: данные API хранятся не дольше 30 дней
    // У прямых эфиров длительность P0D — это не «трек на 0:00», а эфир без конца
    ...(sn.liveBroadcastContent === 'live' ? { live: true } : {}),
  };
}

// Shorts в API отдельным признаком не помечены. Они почти всегда не длиннее минуты, а те, что до трёх минут,
// подписаны #shorts в названии, описании или тегах. Песни короче минуты встречаются редко.
const MAX_SHORT_SECONDS = 60;
const SHORTS_MARK = /#shorts?\b/i;

// Почему ролик нельзя (или не нужно) играть во встроенном плеере; null — можно.
// Это предварительная проверка по данным API: окончательно блокировки выявляет сам плеер при запуске.
function unusable(item, region, { shorts = true } = {}) {
  const cd = item.contentDetails || {}, st = item.status || {}, sn = item.snippet || {};
  if (st.embeddable === false) return 'embed';                                   // автор запретил встраивание
  if (cd.contentRating?.ytRating === 'ytAgeRestricted') return 'age';            // с возрастным ограничением не встраивается
  const rr = cd.regionRestriction;                                               // недоступно в стране пользователя
  if (rr && region && ((rr.allowed && !rr.allowed.includes(region)) || rr.blocked?.includes(region))) return 'region';
  if (sn.liveBroadcastContent === 'upcoming') return 'upcoming';                 // эфир ещё не начался
  if (shorts && sn.liveBroadcastContent !== 'live') {
    const sec = isoSeconds(cd.duration);
    if (sec > 0 && sec <= MAX_SHORT_SECONDS) return 'short';
    if (SHORTS_MARK.test(`${sn.title || ''} ${sn.description || ''}`)) return 'short';
    if ((sn.tags || []).some((t) => /^#?shorts?$|youtube shorts/i.test(t))) return 'short';
  }
  return null;
}

const MAX_RESULTS = 30;

// Поиск стоит 100 единиц квоты из 10 000 в день; «популярное» — всего 1
async function youtubeSearch(key, q, region, channelId) {
  if (!key) throw new Error('NO_KEY');
  q = (q || '').trim();
  const part = 'snippet,contentDetails,status';
  let ids = [];
  let videos;
  if (q || channelId) {
    // Берём с запасом: часть роликов отсеется. videoSyndicated оставляет только те, что можно играть вне youtube.com.
    // Категория «Музыка» отсекает влоги и обзоры; со страницей исполнителя — его самые популярные ролики.
    const found = await ytApi(key, 'search', {
      part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '45',
      ...(q ? { q } : {}),
      ...(channelId && /^[\w-]{10,40}$/.test(channelId) ? { channelId, order: 'viewCount' } : {}),
    });
    ids = found.items.map((i) => i.id?.videoId).filter(Boolean);
    if (!ids.length) return [];
    videos = await ytApi(key, 'videos', { part, id: ids.join(',') });
  } else {
    videos = await ytApi(key, 'videos', { part, chart: 'mostPopular', videoCategoryId: '10', regionCode: region || 'US', maxResults: '50' });
  }
  // Страну пользователя мы знаем только приблизительно (по языку системы), поэтому по региону здесь не отсеиваем:
  // недоступные в вашей стране ролики определяет плеер YouTube при проверке результатов.
  const items = videos.items.filter((i) => !unusable(i));
  if (ids.length) items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return items.slice(0, MAX_RESULTS).map(youtubeTrack);
}

// Обновить сохранённые данные роликов (1 единица квоты на 50 роликов).
// missing — ролики, которых больше нет или которые больше нельзя встраивать.
async function youtubeRefresh(key, videoIds, region) {
  if (!key) throw new Error('NO_KEY');
  const tracks = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const v = await ytApi(key, 'videos', { part: 'snippet,contentDetails,status', id: videoIds.slice(i, i + 50).join(',') });
    // Шорты не проверяем: человек уже сам добавил ролик в плейлист или лайки
    tracks.push(...v.items.filter((it) => !unusable(it, null, { shorts: false })).map(youtubeTrack));
  }
  const found = new Set(tracks.map((t) => t.videoId));
  return { tracks, missing: videoIds.filter((id) => !found.has(id)) };
}

module.exports = { radioSearch, radioClick, jamendoSearch, youtubeSearch, youtubeRefresh, download, unusable };
