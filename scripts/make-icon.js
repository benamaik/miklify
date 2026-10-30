// Генерация иконок без внешних зависимостей:
//   assets/icon.png    — 256x256 (окно, трей, сборка .exe)
//   assets/miklify.ico — 16/24/32/48/64/256 (ярлыки Windows)
// Знак: белая геометрическая строчная «m» на графитовом квадрате.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;  // размер макета: все координаты ниже заданы в нём
const SS = 4;   // суперсэмплинг для сглаживания краёв

const BG = [17, 17, 17];
const FG = [242, 242, 240];
const EDGE = [44, 44, 44]; // тонкая внутренняя рамка

// Скруглённый квадрат: расстояние со знаком (<0 — внутри)
function roundRect(x, y, m, r) {
  const lo = m + r, hi = N - m - r;
  const dx = Math.max(lo - x, 0, x - hi), dy = Math.max(lo - y, 0, y - hi);
  return Math.hypot(dx, dy) - r;
}

// Расстояние до вертикального отрезка
const vseg = (x, y, sx, y0, y1) => Math.hypot(x - sx, y - Math.min(Math.max(y, y0), y1));

// Расстояние до верхней полуокружности (дуги буквы)
function arch(x, y, cx, cy, r) {
  if (y > cy) return Math.min(Math.hypot(x - (cx - r), y - cy), Math.hypot(x - (cx + r), y - cy));
  return Math.abs(Math.hypot(x - cx, y - cy) - r);
}

// Буква «m»: три ножки и две арки, обрезанные снизу ровно
const W = 13;           // половина толщины штриха
const TOP = 112, BOT = 180, R = 28;
const X = [72, 128, 184];
const SPUR = TOP - R;    // левая ножка поднимается до верха арок и срезана ровно
function inM(x, y) {
  if (y > BOT) return false;
  if (x < X[0] + W && y < SPUR) return false;
  const d = Math.min(
    vseg(x, y, X[0], SPUR, BOT),
    vseg(x, y, X[1], TOP, BOT),
    vseg(x, y, X[2], TOP, BOT),
    arch(x, y, (X[0] + X[1]) / 2, TOP, R),
    arch(x, y, (X[1] + X[2]) / 2, TOP, R),
  );
  return d <= W;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит, RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Рисуем знак в нужном размере (макет 256x256 масштабируется)
function render(size) {
  const k = N / size;
  const ss = size < 64 ? 8 : SS; // мелким размерам — больше сглаживания
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let inside = 0, fg = 0, edge = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) * k, py = (y + (sy + 0.5) / ss) * k;
          const d = roundRect(px, py, 8, 52);
          if (d > 0) continue;
          inside++;
          if (inM(px, py)) fg++;
          else if (d > -2) edge++;
        }
      }
      if (!inside) continue;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let c = 0; c < 3; c++) {
        raw[o + c] = Math.round((BG[c] * (inside - fg - edge) + FG[c] * fg + EDGE[c] * edge) / inside);
      }
      raw[o + 3] = Math.round((inside / (ss * ss)) * 255);
    }
  }
  return encodePng(size, raw);
}

// ICO-контейнер с несколькими PNG внутри (поддерживается с Windows Vista)
function encodeIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;     // 0 означает 256 px
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4);          // плоскости
    head.writeUInt16LE(32, e + 6);         // бит на пиксель
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.png)]);
}

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });

const big = render(N);
fs.writeFileSync(path.join(assets, 'icon.png'), big);

const ico = encodeIco([16, 24, 32, 48, 64].map((size) => ({ size, png: render(size) })).concat({ size: 256, png: big }));
fs.writeFileSync(path.join(assets, 'miklify.ico'), ico);
fs.rmSync(path.join(assets, 'icon.ico'), { force: true }); // старое имя — Windows кэшировала по нему прежний значок

console.log('Иконки созданы в', assets);
