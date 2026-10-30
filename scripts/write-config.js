// Записывает ключи из переменных окружения в src/config.js. Запускается только при сборке релиза:
// в репозитории этот файл всегда остаётся с пустыми ключами.
const fs = require('fs');
const path = require('path');

const NAMES = ['ACOUSTID_KEY', 'JAMENDO_CLIENT_ID', 'YOUTUBE_API_KEY'];
const lines = NAMES.map((n) => `  ${n}: ${JSON.stringify(process.env[n] || '')},`);
fs.writeFileSync(path.join(__dirname, '..', 'src', 'config.js'), `module.exports = {\n${lines.join('\n')}\n};\n`);

console.log(NAMES.map((n) => `${n}: ${process.env[n] ? 'задан' : 'пусто'}`).join('\n'));
