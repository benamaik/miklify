// Создаёт ярлыки «Miklify» в меню «Пуск» (чтобы приложение находилось поиском Windows), на рабочем столе и в папке проекта.
// Ярлык запускает Miklify.exe (брендированный Electron) напрямую — без консоли.
const { execFileSync } = require('child_process');
const path = require('path');
const { ensureBrandedExe } = require('./brand-electron');

(async () => {
const electron = await ensureBrandedExe();
const root = path.join(__dirname, '..');
const iconFile = path.join(root, 'assets', 'miklify.ico');
const q = (s) => `'${s.replace(/'/g, "''")}'`; // строка для PowerShell

const ps = `
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), ${q(root)})) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'Miklify.lnk'))
  $lnk.TargetPath = ${q(electron)}
  $lnk.Arguments = '"' + ${q(root)} + '"'
  $lnk.WorkingDirectory = ${q(root)}
  $lnk.IconLocation = ${q(iconFile)} + ',0'
  $lnk.Description = 'Miklify — плеер локальной музыки'
  $lnk.Save()
  Write-Output (Join-Path $dir 'Miklify.lnk')
}`;

// -EncodedCommand (UTF-16LE) корректно передаёт кириллицу в путях
const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]);
console.log('Ярлыки созданы:\n' + out.toString().trim());
})().catch((e) => { console.error(e.message); process.exit(1); });
