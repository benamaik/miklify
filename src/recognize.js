// Распознавание треков без тегов по звуку: Chromaprint (fpcalc) → AcoustID → MusicBrainz.
// В сеть уходит только «отпечаток» звука; сама музыка никуда не отправляется и не скачивается.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { app } = require('electron');

const UNKNOWN_ARTIST = 'Неизвестный исполнитель';
const MIN_SCORE = 0.6;          // ниже — считаем, что трек не узнан
const REQUEST_GAP = 350;        // AcoustID разрешает до 3 запросов в секунду
const UA = 'Miklify/1.0 (local music player)';

// fpcalc.exe лежит в bin/ проекта, а в собранном приложении — в resources/bin/
function fpcalcPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'fpcalc.exe'),
    path.join(app.getAppPath(), 'bin', 'fpcalc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Нужно ли распознавать трек: в тегах нет исполнителя и мы его ещё не пробовали
const needsRecognition = (t, overrides) =>
  (t.unknown ?? t.artist === UNKNOWN_ARTIST) && !t.recognized && !overrides[t.path];

// Отпечаток звука (первые 120 секунд)
function fingerprint(exe, file) {
  return new Promise((resolve, reject) => {
    execFile(exe, ['-json', '-length', '120', file], { timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error('fpcalc: ' + err.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('fpcalc: неверный ответ')); }
    });
  });
}

async function lookup(key, fp) {
  const body = new URLSearchParams({
    client: key,
    meta: 'recordings releasegroups compress',
    duration: String(Math.round(fp.duration)),
    fingerprint: fp.fingerprint,
  });
  const res = await fetch('https://api.acoustid.org/v2/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body,
  });
  const json = await res.json();
  if (json.status !== 'ok') {
    const e = new Error(json.error?.message || `AcoustID: ошибка ${res.status}`);
    e.fatal = json.error?.code === 4 || json.error?.code === 6; // неверный ключ — дальше нет смысла
    throw e;
  }
  return json.results || [];
}

// Выбрать лучшую запись: самый уверенный результат, запись с исполнителем, по длительности ближе к файлу
function pickRecording(results, duration) {
  for (const r of [...results].sort((a, b) => b.score - a.score)) {
    if (r.score < MIN_SCORE) break;
    const recs = (r.recordings || []).filter((x) => x.title && x.artists?.length);
    if (!recs.length) continue;
    recs.sort((a, b) => Math.abs((a.duration || duration) - duration) - Math.abs((b.duration || duration) - duration));
    return recs[0];
  }
  return null;
}

function artistName(artists) {
  if (artists.some((a) => a.joinphrase)) return artists.map((a) => a.name + (a.joinphrase || '')).join('').trim();
  return artists.map((a) => a.name).join(', ');
}

// Предпочитаем студийный альбом, потом сингл/EP, сборники — в последнюю очередь
function pickReleaseGroup(groups = []) {
  const rank = (g) => (g.type === 'Album' ? 0 : g.type ? 1 : 2) + (g.secondarytypes?.length ? 3 : 0);
  return [...groups].sort((a, b) => rank(a) - rank(b))[0] || null;
}

// Обложка из Cover Art Archive (если есть)
async function fetchCover(rgId, coversDir) {
  try {
    const res = await fetch(`https://coverartarchive.org/release-group/${rgId}/front-250`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    const file = path.join(coversDir, crypto.createHash('sha1').update(data).digest('hex') + '.jpg');
    if (!fs.existsSync(file)) await fs.promises.writeFile(file, data);
    return pathToFileURL(file).href;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Распознать треки без исполнителя.
 * overrides — объект path → найденные данные (или {notFound: true}); дополняется на месте.
 * Возвращает {done, found, error}.
 */
async function recognize({ tracks, overrides, key, coversDir, onProgress, isCancelled }) {
  const exe = fpcalcPath();
  if (!exe) return { done: 0, found: 0, error: 'Не найден fpcalc.exe — выполните npm run get-fpcalc' };
  if (!key) return { done: 0, found: 0, error: 'Укажите ключ AcoustID в настройках' };

  const todo = tracks.filter((t) => needsRecognition(t, overrides));
  let done = 0, found = 0, last = 0;
  onProgress({ done, total: todo.length, found });

  for (const t of todo) {
    if (isCancelled()) break;
    try {
      const fp = await fingerprint(exe, t.path);
      await sleep(Math.max(0, REQUEST_GAP - (Date.now() - last)));
      last = Date.now();
      const rec = pickRecording(await lookup(key, fp), fp.duration);
      if (rec) {
        const rg = pickReleaseGroup(rec.releasegroups);
        const o = {
          title: rec.title,
          artist: artistName(rec.artists),
          album: rg ? rg.title : t.album,
          mbid: rec.id,
        };
        if (!t.cover && rg) o.cover = await fetchCover(rg.id, coversDir);
        overrides[t.path] = o;
        found++;
      } else {
        overrides[t.path] = { notFound: true };
      }
    } catch (e) {
      if (e.fatal) return { done, found, error: e.message };
      console.warn('Не удалось распознать', t.path, e.message);
    }
    done++;
    onProgress({ done, total: todo.length, found, current: path.basename(t.path) });
  }
  return { done, found, error: null };
}

// Применить найденные данные к треку (используется и после сканирования)
// Если у файла позже появились настоящие теги — они главнее
function applyOverride(track, o) {
  if (!o || o.notFound || track.unknown === false) return track;
  return { ...track, title: o.title, artist: o.artist, album: o.album, cover: track.cover || o.cover || null, recognized: true };
}

module.exports = { recognize, applyOverride, fpcalcPath, needsRecognition, UNKNOWN_ARTIST };
