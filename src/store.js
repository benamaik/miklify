// Простое JSON-хранилище с отложенной записью на диск.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.data = { ...defaults };
    this.timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...defaults, ...saved };
    } catch { /* файла ещё нет или он повреждён — берём значения по умолчанию */ }
  }

  // Слить изменения в данные и запланировать запись
  set(patch) {
    Object.assign(this.data, patch);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  // Немедленно записать на диск (атомарно через временный файл)
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Не удалось сохранить', this.file, e);
    }
  }
}

module.exports = { Store };
