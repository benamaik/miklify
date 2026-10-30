// Запуск Miklify отдельно от консоли: окно терминала можно закрыть, плеер продолжит работать.
// Запускается брендированный Miklify.exe, чтобы в диспетчере задач было «Miklify».
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');
const { ensureBrandedExe } = require('./brand-electron');

(async () => {
  let exe = electron;
  try {
    exe = await ensureBrandedExe();
  } catch (e) {
    console.warn('Не удалось подготовить Miklify.exe, запускаю обычный Electron:', e.message);
  }
  spawn(exe, [path.join(__dirname, '..')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  console.log('Miklify запущен. Это окно можно закрыть.');
})();
