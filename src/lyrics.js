// Тексты песен: сначала .lrc рядом с файлом, потом кэш, потом LRCLIB (открытая база, без ключа).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Miklify (https://github.com/benamaik/miklify)';
const MISS_DAYS = 7; // «не нашлось» помним неделю, чтобы не долбить сервис при каждом включении

// «[01:23.45] строка» → [{ t: 83.45, text }]
function parseLrc(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}

function fromRecord(r) {
  if (!r) return null;
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics) : null;
  if (synced?.length) return { synced, plain: r.plainLyrics || null };
  if (r.plainLyrics) return { synced: null, plain: r.plainLyrics };
  return null;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB: HTTP ${res.status}`);
  return res.json();
}

async function fetchLrclib({ artist, title, album, duration }) {
  const q = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album && album !== 'YouTube') q.set('album_name', album);
  if (duration > 0) q.set('duration', String(Math.round(duration)));
  let found = fromRecord(await getJson(`https://lrclib.net/api/get?${q}`));
  if (found) return found;
  // Точного совпадения нет — берём лучшее из поиска, но только если длина почти та же
  const list = await getJson(`https://lrclib.net/api/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`);
  const best = (list || [])
    .filter((r) => !duration || !r.duration || Math.abs(r.duration - duration) <= 5)
    .sort((a, b) => !!b.syncedLyrics - !!a.syncedLyrics)[0];
  return fromRecord(best);
}

// Запасной источник без меток времени: нужен, когда LRCLIB недоступен или текста там нет
async function fetchOvh({ artist, title }) {
  const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = String((await res.json()).lyrics || '').replaceAll(String.fromCharCode(13), '').trim();
  return text ? { synced: null, plain: text, source: 'lyrics.ovh' } : null;
}

function create(dir) {
  const memory = new Map();
  const fileFor = (t) => path.join(dir, crypto.createHash('sha1').update(`${t.artist}|${t.title}`.toLowerCase()).digest('hex') + '.json');

  return async function getLyrics(t) {
    if (!t || !t.title) return null;
    // 1) свой .lrc / .txt рядом с файлом
    if (t.path) {
      const base = t.path.replace(/\.[^.\\/]+$/, '');
      for (const ext of ['.lrc', '.txt']) {
        try {
          const text = fs.readFileSync(base + ext, 'utf8');
          const synced = ext === '.lrc' ? parseLrc(text) : [];
          return synced.length ? { synced, plain: null, source: 'файл' } : { synced: null, plain: text.replace(/\[[^\]]*\]/g, '').trim(), source: 'файл' };
        } catch { /* нет такого файла */ }
      }
    }
    const key = fileFor(t);
    if (memory.has(key)) return memory.get(key);
    try {
      const cached = JSON.parse(fs.readFileSync(key, 'utf8'));
      if (cached.lyrics || Date.now() - cached.at < MISS_DAYS * 864e5) { memory.set(key, cached.lyrics); return cached.lyrics; }
    } catch { /* кэша нет */ }
    let lyrics = null, down = false;
    try { lyrics = await fetchLrclib(t); } catch { down = true; }
    let result = lyrics && { ...lyrics, source: 'LRCLIB' };
    if (!result) {
      try { result = await fetchOvh(t); } catch { if (down) throw new Error('нет связи с сервисами'); }
    }
    // Когда LRCLIB лежал, ничего не запоминаем: позже там может найтись текст с метками времени
    if (down) return result;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(key, JSON.stringify({ at: Date.now(), lyrics: result }));
    memory.set(key, result);
    return result;
  };
}

module.exports = { create, parseLrc };
