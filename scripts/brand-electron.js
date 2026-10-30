// Делает копию electron.exe под именем Miklify.exe с нашим названием и значком,
// чтобы в диспетчере задач, на панели задач и в трее было «Miklify», а не «Electron».
// Собранный через electron-builder .exe брендируется сам — это нужно для запуска из папки проекта.
const fs = require('fs');
const path = require('path');
const electron = require('electron'); // путь к electron.exe
const rceditModule = require('rcedit');

const rcedit = rceditModule.rcedit || rceditModule;
const root = path.join(__dirname, '..');
const branded = path.join(path.dirname(electron), 'Miklify.exe');
const { version } = require('../package.json');

// Нужно ли (пере)создать: файла нет или Electron обновился после брендирования
function isStale() {
  if (!fs.existsSync(branded)) return true;
  return fs.statSync(electron).mtimeMs > fs.statSync(branded).mtimeMs;
}

async function ensureBrandedExe() {
  if (!isStale()) return branded;
  const tmp = branded + '.tmp';
  fs.copyFileSync(electron, tmp);
  await rcedit(tmp, {
    icon: path.join(root, 'assets', 'miklify.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      FileDescription: 'Miklify',
      ProductName: 'Miklify',
      InternalName: 'Miklify',
      OriginalFilename: 'Miklify.exe',
      CompanyName: 'Miklify',
      LegalCopyright: '',
    },
  });
  fs.renameSync(tmp, branded);
  return branded;
}

module.exports = { ensureBrandedExe, branded };

if (require.main === module) {
  ensureBrandedExe()
    .then((p) => console.log('Готово:', p))
    .catch((e) => { console.error('Не удалось создать Miklify.exe:', e.message); process.exit(1); });
}
