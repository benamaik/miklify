// Скачивает fpcalc.exe (Chromaprint, официальный релиз с GitHub) в папку bin/.
// fpcalc нужен для распознавания треков по звуку.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const VERSION = '1.5.1';
const NAME = `chromaprint-fpcalc-${VERSION}-windows-x86_64`;
const URL = `https://github.com/acoustid/chromaprint/releases/download/v${VERSION}/${NAME}.zip`;

const binDir = path.join(__dirname, '..', 'bin');
const zipFile = path.join(binDir, 'fpcalc.zip');
const tmpDir = path.join(binDir, 'tmp');

// Загрузка с переходом по редиректам (GitHub отдаёт файл через redirect)
function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Miklify' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(binDir, { recursive: true });
  console.log('Скачиваю', URL);
  await download(URL, zipFile);

  // Распаковка средствами Windows
  fs.rmSync(tmpDir, { recursive: true, force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`]);
  fs.copyFileSync(path.join(tmpDir, NAME, 'fpcalc.exe'), path.join(binDir, 'fpcalc.exe'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(zipFile, { force: true });

  console.log('Готово:', path.join(binDir, 'fpcalc.exe'));
})().catch((e) => {
  console.error('Не удалось скачать fpcalc:', e.message);
  process.exit(1);
});
