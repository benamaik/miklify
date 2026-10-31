// Основной процесс Electron: окно, трей, медиаклавиши, библиотека.
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, globalShortcut, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./src/store');
const { scan } = require('./src/scanner');
const { recognize, applyOverride, fpcalcPath } = require('./src/recognize');
const online = require('./src/online');
const ytserver = require('./src/ytserver');
const { ACOUSTID_KEY, JAMENDO_CLIENT_ID, YOUTUBE_API_KEY } = require('./src/config');

// Свой ключ из настроек (если указан) или встроенный ключ приложения
const acoustidKey = () => settings.data.acoustidKey || ACOUSTID_KEY;

const ICON = path.join(__dirname, 'assets', 'icon.png');

let win = null;
let tray = null;
let quitting = false;
let scanning = false;
let rescanQueued = false;
let isPlaying = false;

// Настройки и состояние плеера (громкость, очередь, плейлисты, лайки и т.д.)
const settings = new Store(path.join(app.getPath('userData'), 'settings.json'), {
  folders: [],
  volume: 0.8,
  shuffle: false,
  repeat: 'off', // off | all | one
  theme: 'dark',
  bg: 'waves',
  queue: [],
  qi: -1,
  pos: 0,
  likes: [],
  playlists: [],
  eq: { on: true, preset: 'flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bgReact: true,      // фон реагирует на музыку
  closeToTray: true,  // крестик сворачивает в трей
  acoustidKey: '',    // ключ AcoustID для распознавания по звуку
  jamendoKey: '',     // Client ID Jamendo, введённый во вкладке «Онлайн»
  youtubeKey: '',     // ключ YouTube Data API, введённый во вкладке «Онлайн»
  ytPos: null,        // старый формат положения панели с видео {x, y}
  ytLayout: null,     // окно видео YouTube: {place: {anchor}|{x,y}, view: float|compact}
  ytConsent: false,   // пользователь принял политику конфиденциальности и условия YouTube
  ytBlocked: {},      // ролики, которые плеер YouTube отказался играть: videoId → {at, code}
  ytProbe: true,      // проверять результаты поиска YouTube плеером до показа
  onlineTracks: {},   // онлайн-треки и станции, которые лежат в плейлистах/лайках/очереди
  radioFav: [],       // избранные радиостанции
});
// Результаты распознавания: путь файла → найденные исполнитель/название/альбом
const overrides = new Store(path.join(app.getPath('userData'), 'overrides.json'), {});
let recognizing = false;
let cancelRecognize = false;
// Кэш библиотеки — повторный запуск не перечитывает теги
const library = new Store(path.join(app.getPath('userData'), 'library.json'), { tracks: [] });
const coversDir = path.join(app.getPath('userData'), 'covers');

app.setAppUserModelId('com.miklify.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

// Внешние ссылки открываем только по https и только на известные сайты
const OPEN_ALLOWED = ['acoustid.org', 'jamendo.com', 'creativecommons.org', 'radio-browser.info', 'youtube.com',
  'console.cloud.google.com', 'policies.google.com', 'github.com'];
function openExternal(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:' && OPEN_ALLOWED.some((d) => hostname === d || hostname.endsWith('.' + d))) shell.openExternal(url);
  } catch { /* неверная ссылка */ }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0b0b0b',
    title: 'Miklify',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // музыка не должна «засыпать» в свёрнутом окне
      spellcheck: false,           // проверка орфографии не нужна и занимает память
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Окно приложения никуда не уходит со своей страницы; ссылки (например, с логотипа YouTube) открываем в браузере
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // Интерфейс должен знать, видно ли окно: YouTube нельзя играть в фоне
  for (const [event, visible] of [['hide', false], ['minimize', false], ['show', true], ['restore', true]]) {
    win.on(event, () => send('window:visible', visible));
  }

  // Закрытие окна сворачивает в трей (если включено в настройках), музыка продолжает играть
  win.on('close', (e) => {
    if (quitting) return;
    if (settings.data.closeToTray) {
      e.preventDefault();
      win.hide();
    } else {
      quitting = true;
      app.quit();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Miklify');
  tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Miklify', click: showWindow },
    { type: 'separator' },
    { label: isPlaying ? 'Пауза' : 'Воспроизвести', click: () => send('cmd', 'toggle') },
    { label: 'Следующий', click: () => send('cmd', 'next') },
    { label: 'Предыдущий', click: () => send('cmd', 'prev') },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

// Медиаклавиши Windows
function registerMediaKeys() {
  const keys = {
    MediaPlayPause: 'toggle',
    MediaNextTrack: 'next',
    MediaPreviousTrack: 'prev',
  };
  for (const [key, cmd] of Object.entries(keys)) {
    try { globalShortcut.register(key, () => send('cmd', cmd)); } catch { /* клавиша занята */ }
  }
}

// Сканирование библиотеки; если запрошено повторно во время работы — запускается ещё раз
async function runScan() {
  if (scanning) { rescanQueued = true; return; }
  scanning = true;
  try {
    const tracks = await scan(settings.data.folders, library.data.tracks, coversDir, (done, total) =>
      send('scan:progress', { done, total }), overrides.data);
    library.set({ tracks });
    library.flush();
    send('library:updated', tracks);
  } catch (e) {
    console.error('Ошибка сканирования', e);
  } finally {
    scanning = false;
    send('scan:progress', null);
    if (rescanQueued) { rescanQueued = false; runScan(); }
  }
}

ipcMain.handle('init', () => ({ settings: settings.data, tracks: library.data.tracks }));

ipcMain.on('state:set', (_e, patch) => settings.set(patch));

ipcMain.handle('folders:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите папки с музыкой',
    properties: ['openDirectory', 'multiSelect'],
  });
  if (res.canceled) return settings.data.folders;
  const folders = [...new Set([...settings.data.folders, ...res.filePaths])];
  settings.set({ folders });
  runScan();
  return folders;
});

ipcMain.handle('folders:remove', (_e, folder) => {
  const folders = settings.data.folders.filter((f) => f !== folder);
  settings.set({ folders });
  runScan();
  return folders;
});

ipcMain.handle('library:rescan', () => runScan());

// ----- распознавание треков без тегов -----
ipcMain.handle('recognize:status', () => ({
  fpcalc: !!fpcalcPath(),
  running: recognizing,
  hasKey: !!acoustidKey(),
  builtinKey: !!ACOUSTID_KEY,
}));

ipcMain.handle('recognize:start', async () => {
  if (recognizing) return { error: 'Распознавание уже идёт' };
  if (scanning) return { error: 'Дождитесь окончания сканирования' };
  recognizing = true;
  cancelRecognize = false;
  try {
    const res = await recognize({
      tracks: library.data.tracks,
      overrides: overrides.data,
      key: acoustidKey(),
      coversDir,
      onProgress: (p) => send('recognize:progress', p),
      isCancelled: () => cancelRecognize,
    });
    overrides.flush();
    if (res.found) {
      const tracks = library.data.tracks.map((t) => applyOverride(t, overrides.data[t.path]));
      library.set({ tracks });
      library.flush();
      send('library:updated', tracks);
    }
    return res;
  } finally {
    recognizing = false;
    send('recognize:progress', null);
  }
});

ipcMain.on('recognize:cancel', () => { cancelRecognize = true; });

// Дать «не найденным» трекам ещё одну попытку
ipcMain.handle('recognize:retry', () => {
  for (const [p, o] of Object.entries(overrides.data)) if (o.notFound) delete overrides.data[p];
  overrides.flush();
});

ipcMain.handle('open:acoustid', () => shell.openExternal('https://acoustid.org/new-application'));

// ----- онлайн: Jamendo и интернет-радио -----
// Ключ Jamendo: введённый во вкладке «Онлайн» или встроенный в сборку
const jamendoKey = () => settings.data.jamendoKey || JAMENDO_CLIENT_ID;
const youtubeKey = () => settings.data.youtubeKey || YOUTUBE_API_KEY;
ipcMain.handle('online:status', () => ({ jamendo: !!jamendoKey(), youtube: !!youtubeKey() }));
ipcMain.handle('youtube:search', (_e, q, region, channelId) => online.youtubeSearch(youtubeKey(), q, region, channelId));
ipcMain.handle('youtube:refresh', (_e, ids, region) => online.youtubeRefresh(youtubeKey(), ids, region));
ipcMain.handle('yt:port', () => ytserver.start());
ipcMain.handle('jamendo:search', (_e, q) => online.jamendoSearch(jamendoKey(), q));
ipcMain.handle('radio:search', (_e, q) => online.radioSearch(q));
ipcMain.on('radio:click', (_e, uuid) => online.radioClick(uuid));

// Папка для скачанных и полученных треков (для проверок можно подменить переменной MIKLIFY_MUSIC_DIR)
const miklifyMusicDir = () => path.join(process.env.MIKLIFY_MUSIC_DIR || app.getPath('music'), 'Miklify');

// Папка попадает в библиотеку, и запускается сканирование
function addLibraryFolder(dir) {
  const inLibrary = settings.data.folders.some((f) => (dir + path.sep).toLowerCase().startsWith(path.join(f, path.sep).toLowerCase()));
  if (!inLibrary) settings.set({ folders: [...settings.data.folders, dir] });
  runScan();
  return settings.data.folders;
}

// Скачанные треки кладём в «Музыка\Miklify» и добавляем эту папку в библиотеку
ipcMain.handle('online:download', async (_e, track) => {
  const dir = miklifyMusicDir();
  const file = await online.download(track, dir);
  return { file, folders: addLibraryFolder(dir) };
});

// ----- обмен треками между друзьями -----
const SHARE_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a']);
const SHARE_MAX = 200 * 1024 * 1024;
const sharePicked = new Set(); // файлы, которые пользователь сам выбрал в окне выбора

// Читать для отправки можно только свою библиотеку или выбранный вручную файл
const canShare = (p) => sharePicked.has(p) || library.data.tracks.some((t) => t.path === p);

ipcMain.handle('share:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите трек для отправки',
    properties: ['openFile'],
    filters: [{ name: 'Аудио', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const p = res.filePaths[0];
  if (!SHARE_EXT.has(path.extname(p).toLowerCase())) return null;
  const st = await fs.promises.stat(p);
  if (st.size > SHARE_MAX) throw new Error('Файл больше 200 МБ — слишком большой для отправки');
  sharePicked.add(p);
  return { path: p, name: path.basename(p), size: st.size };
});

ipcMain.handle('share:read', async (_e, p, offset, len) => {
  if (!canShare(p)) throw new Error('Этот файл нельзя отправлять');
  const fh = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(Math.min(Math.max(len | 0, 1), 1024 * 1024));
    const { bytesRead } = await fh.read(buf, 0, buf.length, Math.max(offset | 0, 0));
    return new Uint8Array(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
});

// Принятый файл: имя приходит от другого человека, поэтому оставляем только безопасное имя аудиофайла
ipcMain.handle('share:save', async (_e, name, bytes) => {
  const safe = path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120);
  const ext = path.extname(safe).toLowerCase();
  if (!safe || !SHARE_EXT.has(ext)) throw new Error('Неподходящий тип файла');
  const data = Buffer.from(bytes);
  if (!data.length || data.length > SHARE_MAX) throw new Error('Неподходящий размер файла');
  const dir = path.join(miklifyMusicDir(), 'От друзей');
  await fs.promises.mkdir(dir, { recursive: true });
  let target = path.join(dir, safe);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${path.basename(safe, ext)} (${n})${ext}`);
  await fs.promises.writeFile(target, data);
  return { file: target, folders: addLibraryFolder(miklifyMusicDir()) };
});

ipcMain.handle('open:url', (_e, url) => openExternal(url));

// Название трека в заголовке окна и подсказке трея
ipcMain.on('player:now', (_e, text, playing) => {
  isPlaying = !!playing;
  if (win && !win.isDestroyed()) win.setTitle(text ? `${text} — Miklify` : 'Miklify');
  if (tray) tray.setToolTip(text || 'Miklify');
  updateTrayMenu();
});

app.whenReady().then(() => {
  // Web Audio (эквалайзер, реакция фона) молчит на чужих потоках без CORS-заголовка —
  // добавляем его только к аудио и видео, остальные ответы не трогаем
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    const headers = d.responseHeaders || {};
    if (d.resourceType !== 'media' || Object.keys(headers).some((k) => k.toLowerCase() === 'access-control-allow-origin')) {
      cb({});
      return;
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: headers });
  });
  createWindow();
  createTray();
  registerMediaKeys();
  // Если папки уже выбраны — тихо обновляем библиотеку в фоне
  win.webContents.once('did-finish-load', () => {
    if (settings.data.folders.length) runScan();
  });
});

app.on('before-quit', () => {
  quitting = true;
  settings.flush();
  library.flush();
  overrides.flush();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* остаёмся в трее */ });
