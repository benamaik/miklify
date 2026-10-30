// Сканирование папок с музыкой, чтение тегов и сохранение обложек.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { nativeImage } = require('electron');
const { applyOverride, UNKNOWN_ARTIST } = require('./recognize');

// music-metadata поставляется только как ES-модуль, поэтому подключаем его через import()
const loadMetadataLib = import('music-metadata');

const EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a']);
const WORKERS = 6;

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

// Рекурсивный обход папки
async function* walk(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // нет доступа — пропускаем папку
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

// Средний «яркий» цвет обложки — для подсветки интерфейса и фона
function dominantColor(buffer) {
  try {
    const bmp = nativeImage.createFromBuffer(buffer).resize({ width: 12, height: 12 }).toBitmap();
    let r = 0, g = 0, b = 0, wsum = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const pb = bmp[i], pg = bmp[i + 1], pr = bmp[i + 2]; // BGRA
      const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
      const w = 0.05 + (max - min) / 255; // насыщенные пиксели важнее
      r += pr * w; g += pg * w; b += pb * w; wsum += w;
    }
    return wsum ? [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)] : null;
  } catch {
    return null;
  }
}

// Читает один файл: теги + обложка. Если файл не менялся — берёт из кэша.
async function readTrack(file, cached, coversDir, colors) {
  const st = await fs.promises.stat(file);
  // Запись без длительности перечитываем: иначе в кэше навсегда остаётся 0:00
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size && cached.duration > 0) return cached;

  const base = path.basename(file, path.extname(file));
  const track = {
    id: sha1(file).slice(0, 16),
    path: file,
    url: pathToFileURL(file).href,
    title: base,
    artist: UNKNOWN_ARTIST,
    unknown: true, // в тегах нет исполнителя — кандидат на распознавание
    album: 'Неизвестный альбом',
    albumArtist: '',
    trackNo: 0,
    year: 0,
    duration: 0,
    cover: null,
    color: null,
    mtime: st.mtimeMs,
    size: st.size,
    addedAt: cached ? cached.addedAt : Date.now(),
  };

  try {
    const mm = await loadMetadataLib;
    const meta = await mm.parseFile(file, { duration: true });
    const c = meta.common;
    track.title = c.title || base;
    track.artist = c.artist || c.albumartist || track.artist;
    track.unknown = !c.artist && !c.albumartist;
    track.album = c.album || track.album;
    track.albumArtist = c.albumartist || '';
    track.trackNo = (c.track && c.track.no) || 0;
    track.year = c.year || 0;
    track.duration = meta.format.duration || 0;

    const pic = mm.selectCover(c.picture);
    if (pic && pic.data && pic.data.length) {
      const hash = sha1(pic.data);
      const ext = /png/i.test(pic.format) ? 'png' : 'jpg';
      const coverFile = path.join(coversDir, `${hash}.${ext}`);
      if (!fs.existsSync(coverFile)) await fs.promises.writeFile(coverFile, pic.data);
      track.cover = pathToFileURL(coverFile).href;
      if (!colors.has(hash)) colors.set(hash, dominantColor(Buffer.from(pic.data)));
      track.color = colors.get(hash);
    }
  } catch (e) {
    console.warn('Не удалось прочитать теги:', file, e.message);
  }
  return track;
}

// Сканирует список папок; cache — прежняя библиотека (для ускорения),
// overrides — данные, найденные распознаванием (path → поля трека)
async function scan(folders, cache, coversDir, onProgress, overrides = {}) {
  fs.mkdirSync(coversDir, { recursive: true });
  const cacheMap = new Map(cache.map((t) => [t.path, t]));
  const colors = new Map();

  const files = new Set();
  for (const folder of folders) for await (const f of walk(folder)) files.add(f);
  const list = [...files];

  const result = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.length) {
      const file = list[next++];
      try {
        const track = await readTrack(file, cacheMap.get(file), coversDir, colors);
        result.push(applyOverride(track, overrides[file]));
      } catch (e) {
        console.warn('Пропущен файл:', file, e.message);
      }
      done++;
      if (done % 10 === 0 || done === list.length) onProgress(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));

  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  result.sort((a, b) => cmp(a.artist, b.artist) || cmp(a.album, b.album) || a.trackNo - b.trackNo || cmp(a.title, b.title));
  return result;
}

module.exports = { scan };
