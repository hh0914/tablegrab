/**
 * TableGrab 图标生成脚本（开发工具，不属于扩展运行时）
 * ---------------------------------------------------------------------------
 * 不依赖任何第三方库，用 Node 内置 zlib 直接拼出 PNG 字节流，
 * 生成 16 / 32 / 48 / 128 四种尺寸的插件图标。
 *
 * 用法：node dev/gen-icons.js
 * 输出：../icons/icon16.png、icon32.png、icon48.png、icon128.png
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------- PNG 编码 ------------------------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素数组 → PNG Buffer */
function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // 每行前置一个 filter 字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------- 图形绘制 ------------------------------- */

/** 抗锯齿辅助：返回像素中心点被覆盖的比例 */
function coverage(px, py, test) {
  // 4x4 超采样
  let hits = 0;
  const N = 4;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = px + (i + 0.5) / N;
      const y = py + (j + 0.5) / N;
      if (test(x, y)) hits++;
    }
  }
  return hits / (N * N);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/**
 * 生成单个尺寸的图标：圆角渐变方块 + 白色表格网格
 * @param {number} size 边长（像素）
 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.24;           // 圆角半径
  const pad = size * 0.22;              // 表格内边距
  const gridLeft = pad;
  const gridRight = size - pad;
  const gridTop = pad;
  const gridBottom = size - pad;
  const lineWidth = Math.max(1, size * 0.055);   // 网格线宽
  const gridW = gridRight - gridLeft;
  const cell = gridW / 3;

  // 左上 / 右下渐变色
  const c1 = [37, 99, 235];    // #2563eb
  const c2 = [29, 78, 216];    // #1d4ed8

  function inRoundedRect(x, y) {
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  }

  function onGridLine(x, y) {
    const inGrid = x >= gridLeft - lineWidth / 2 && x <= gridRight + lineWidth / 2 &&
      y >= gridTop - lineWidth / 2 && y <= gridBottom + lineWidth / 2;
    if (!inGrid) return false;
    // 外框
    if (Math.abs(x - gridLeft) <= lineWidth / 2 || Math.abs(x - gridRight) <= lineWidth / 2) return true;
    if (Math.abs(y - gridTop) <= lineWidth / 2 || Math.abs(y - gridBottom) <= lineWidth / 2) return true;
    // 内部两条竖线 + 两条横线
    for (let i = 1; i <= 2; i++) {
      if (Math.abs(x - (gridLeft + cell * i)) <= lineWidth / 2) return true;
      if (Math.abs(y - (gridTop + cell * i)) <= lineWidth / 2) return true;
    }
    return false;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x;
      const py = y;
      const bodyAlpha = coverage(px, py, inRoundedRect);
      const lineAlpha = coverage(px, py, function (sx, sy) {
        return inRoundedRect(sx, sy) && onGridLine(sx, sy);
      });

      const t = Math.min(1, (px / size) * 0.5 + (py / size) * 0.5);
      let r = mix(c1[0], c2[0], t);
      let g = mix(c1[1], c2[1], t);
      let b = mix(c1[2], c2[2], t);

      // 网格线画成白色（按覆盖比例与底色混合）
      if (lineAlpha > 0) {
        r = mix(r, 255, lineAlpha);
        g = mix(g, 255, lineAlpha);
        b = mix(b, 255, lineAlpha);
      }

      const off = (y * size + x) * 4;
      rgba[off] = r;
      rgba[off + 1] = g;
      rgba[off + 2] = b;
      rgba[off + 3] = Math.round(bodyAlpha * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

/* ------------------------------- 主流程 ------------------------------- */
function main() {
  const outDir = path.resolve(__dirname, '..', 'icons');
  fs.mkdirSync(outDir, { recursive: true });

  [16, 32, 48, 128].forEach(function (size) {
    const file = path.join(outDir, 'icon' + size + '.png');
    fs.writeFileSync(file, drawIcon(size));
    console.log('已生成 ' + path.relative(path.resolve(__dirname, '..'), file) +
      '（' + size + '×' + size + '，' + fs.statSync(file).size + ' 字节）');
  });
}

main();
