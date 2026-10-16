/**
 * TableGrab 自动化测试（开发工具，不属于扩展运行时）
 * ---------------------------------------------------------------------------
 * 覆盖三层：
 *   A. lib/table-utils.js 纯逻辑：CSV 转义、Markdown、JSON、文件名、网格重建、过滤规则
 *   B. content.js 真实 DOM 解析：用 jsdom 模拟网页，走 chrome.runtime 消息通道验证提取结果
 *   C. background.js 导出链路：用 vm 沙箱加载 SW，验证 buildExportFiles → downloads 调用
 *
 * 用法：node dev/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'lib', 'table-utils.js');
const CONTENT_PATH = path.join(ROOT, 'content.js');
const BG_PATH = path.join(ROOT, 'background.js');

const TGU = require(LIB_PATH);

/* ============================== 迷你测试框架 ============================== */
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // 异步用例：交给调用方 await（避免异常变成未捕获的 Promise 拒绝）
      return result.then(function () {
        passed++;
        console.log('  ✓ ' + name);
      }, function (err) {
        fail(name, err);
      });
    }
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail(name, err);
  }
  return undefined;
}

function fail(name, err) {
  failed++;
  failures.push({ name, err });
  console.log('  ✗ ' + name + '\n      ' + (err && err.message ? err.message : err));
}

function group(title) {
  console.log('\n' + title);
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((message || '值不相等') + '\n      期望: ' + b + '\n      实际: ' + a);
  }
}

function assertMatch(value, regex, message) {
  if (!regex.test(value)) {
    throw new Error((message || '正则未匹配') + '\n      实际: ' + value + '\n      期望匹配: ' + regex);
  }
}

/* =========================================================================
 * A. 纯逻辑测试
 * ========================================================================= */
function runPureTests() {
  group('A. lib/table-utils.js 纯逻辑');

  /* ---------- CSV 转义 ---------- */
  test('CSV：普通文本不加引号', function () {
    assertEqual(TGU.csvCell('hello'), 'hello');
  });

  test('CSV：包含逗号必须加引号', function () {
    assertEqual(TGU.csvCell('北京,上海'), '"北京,上海"');
  });

  test('CSV：双引号转义成两个双引号', function () {
    assertEqual(TGU.csvCell('他说"你好"'), '"他说""你好"""');
  });

  test('CSV：包含换行必须加引号且保留换行', function () {
    assertEqual(TGU.csvCell('第一行\n第二行'), '"第一行\n第二行"');
  });

  test('CSV：包含回车换行也必须加引号', function () {
    assertEqual(TGU.csvCell('a\r\nb'), '"a\r\nb"');
  });

  test('CSV：首尾空格加引号以保真', function () {
    assertEqual(TGU.csvCell(' 中文 '), '" 中文 "');
  });

  test('CSV：标准模式无 BOM、LF 换行', function () {
    const out = TGU.toCSV([['a', 'b'], ['c', 'd']]);
    assertEqual(out, 'a,b\nc,d\n');
    assert(out.charCodeAt(0) !== 0xfeff, '标准 CSV 不应带 BOM');
  });

  test('CSV：Excel 兼容模式带 BOM + CRLF', function () {
    const out = TGU.toCSV([['a', 'b'], ['c', 'd']], { bom: true, crlf: true });
    assertEqual(out.charCodeAt(0), 0xfeff, '首字符应为 BOM');
    assertEqual(out.slice(1), 'a,b\r\nc,d\r\n');
  });

  test('CSV：逗号/引号/换行混合场景可被正确还原', function () {
    const matrix = [
      ['名称', '备注'],
      ['A,B', '带"引号"'],
      ['多行', '第一行\n第二行']
    ];
    const csv = TGU.toCSV(matrix);
    // 逐行解析回来（简单状态机，模拟 Excel 的解析行为）
    const parsed = parseCSV(csv);
    assertEqual(parsed, matrix, 'CSV 往返后内容应完全一致');
  });

  /* ---------- Markdown ---------- */
  test('Markdown：竖线转义、换行转 <br>', function () {
    const out = TGU.toMarkdown([['h1', 'h2'], ['a|b', 'x\ny']]);
    assertEqual(out, '| h1 | h2 |\n| --- | --- |\n| a\\|b | x<br>y |\n');
  });

  test('Markdown：行长度不齐时补齐空列', function () {
    const out = TGU.toMarkdown([['a', 'b', 'c'], ['1']]);
    const lines = out.trim().split('\n');
    assertEqual(lines.length, 3);
    assertEqual(lines[2], '| 1 |  |  |');
  });

  test('Markdown：空表格返回空字符串', function () {
    assertEqual(TGU.toMarkdown([]), '');
  });

  /* ---------- 网格重建（rowspan / colspan） ---------- */
  test('网格：colspan=2 展开为两列且只保留首个文本', function () {
    const grid = TGU.buildMatrix([
      [{ text: '表头', colspan: 2 }],
      [{ text: 'a' }, { text: 'b' }]
    ]);
    assertEqual(grid, [['表头', ''], ['a', 'b']]);
  });

  test('网格：rowspan=2 纵向占位，第二行跳过该列', function () {
    const grid = TGU.buildMatrix([
      [{ text: '纵向', rowspan: 2 }, { text: 'B1' }],
      [{ text: 'B2' }]
    ]);
    assertEqual(grid, [['纵向', 'B1'], ['', 'B2']]);
  });

  test('网格：rowspan + colspan 混合，行长度自动补齐', function () {
    const grid = TGU.buildMatrix([
      [{ text: 'A', rowspan: 2, colspan: 2 }, { text: 'B' }],
      [{ text: 'C' }],
      [{ text: 'D' }, { text: 'E' }, { text: 'F' }]
    ]);
    assertEqual(grid, [
      ['A', '', 'B'],
      ['', '', 'C'],
      ['D', 'E', 'F']
    ]);
  });

  test('网格：空行与空表返回空结构', function () {
    assertEqual(TGU.buildMatrix([]), []);
    assertEqual(TGU.buildMatrix([[]]), []);
  });

  test('网格：limitMatrix 截断并给出 truncated 标记', function () {
    const matrix = TGU.buildMatrix([
      [{ text: '1' }, { text: '2' }, { text: '3' }],
      [{ text: '4' }, { text: '5' }, { text: '6' }]
    ]);
    const limited = TGU.limitMatrix(matrix, 1, 2);
    assertEqual(limited.truncated, true);
    assertEqual(limited.matrix, [['1', '2']]);
  });

  /* ---------- 有效表格判定 ---------- */
  test('过滤：完全空的表格被判定无效', function () {
    const stats = TGU.analyzeMatrix(TGU.buildMatrix([[{ text: '' }, { text: '' }], [{ text: '' }, { text: '' }]]));
    assertEqual(TGU.isMeaningfulTable(stats, null), false);
  });

  test('过滤：1 列 5 行的表格默认无效（列数不足）', function () {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push([{ text: '第' + i + '行' }]);
    const stats = TGU.analyzeMatrix(TGU.buildMatrix(rows));
    assertEqual(TGU.isMeaningfulTable(stats, null), false);
    // 把最小列数调成 1 后就应通过
    assertEqual(TGU.isMeaningfulTable(stats, { minCols: 1 }), true);
  });

  test('过滤：2×2 的正常数据表有效', function () {
    const stats = TGU.analyzeMatrix(TGU.buildMatrix([
      [{ text: '姓名' }, { text: '分数' }],
      [{ text: '张三' }, { text: '95' }]
    ]));
    assertEqual(TGU.isMeaningfulTable(stats, null), true);
  });

  test('过滤：只有一个有效单元格的表格无效', function () {
    const stats = TGU.analyzeMatrix(TGU.buildMatrix([
      [{ text: '只有我' }, { text: '' }],
      [{ text: '' }, { text: '' }]
    ]));
    assertEqual(TGU.isMeaningfulTable(stats, null), false);
  });

  test('过滤：布局装饰表格（少行 + 全是块级容器 + 文本极少）被排除', function () {
    const stats = TGU.analyzeMatrix(TGU.buildMatrix([
      [{ text: '菜单' }, { text: '首页' }],
      [{ text: '' }, { text: '' }]
    ]));
    stats.blockCellRatio = 1;
    assertEqual(TGU.isMeaningfulTable(stats, { filterLayoutTables: true }), false);
    // 关闭该规则后应保留
    assertEqual(TGU.isMeaningfulTable(stats, { filterLayoutTables: false }), true);
  });

  test('过滤：minRows / minCols 越界时被纠正到 1~100', function () {
    const s = TGU.mergeSettings({ minRows: 0, minCols: 999 });
    assertEqual(s.minRows, 1);
    assertEqual(s.minCols, 100);
  });

  /* ---------- 文件名 ---------- */
  test('文件名：时间戳格式为 YYYYMMDD', function () {
    const stamp = TGU.timestampStamp(new Date(2026, 9, 15)); // 2026-10-15
    assertEqual(stamp, '20261015');
  });

  test('文件名：序号补零到三位', function () {
    assertEqual(TGU.padNumber(1), '001');
    assertEqual(TGU.padNumber(42), '042');
    assertEqual(TGU.padNumber(1234), '1234');
  });

  test('文件名：非法字符被替换为下划线', function () {
    assertEqual(TGU.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  });

  test('文件名：全是非法字符时使用兜底名', function () {
    assertEqual(TGU.sanitizeFilename('///', 'table'), 'table');
  });

  /* ---------- 导出文件打包 ---------- */
  const sampleTables = [
    { index: 1, title: '销售表', matrix: [['城市', '金额'], ['北京', '100']], headerRow: true },
    { index: 2, title: '库存表', matrix: [['商品', '数量'], ['苹果', '3']], headerRow: true }
  ];

  test('打包：单独文件模式命名为 page_table_20261015_001.csv', function () {
    const files = TGU.buildExportFiles(sampleTables, { format: 'csv', mode: 'separate', stamp: '20261015' });
    assertEqual(files.length, 2);
    assertEqual(files[0].filename, 'page_table_20261015_001.csv');
    assertEqual(files[1].filename, 'page_table_20261015_002.csv');
  });

  test('打包：合并模式只生成一个 _all 文件', function () {
    const files = TGU.buildExportFiles(sampleTables, { format: 'markdown', mode: 'merged', stamp: '20261015' });
    assertEqual(files.length, 1);
    assertEqual(files[0].filename, 'page_table_20261015_all.md');
    assert(files[0].content.indexOf('销售表') !== -1, '合并内容应包含表格标题');
    assert(files[0].content.indexOf('库存表') !== -1, '合并内容应包含第二张表');
  });

  test('打包：四种格式的扩展名与 MIME 正确', function () {
    const csv = TGU.buildExportFiles(sampleTables, { format: 'csv', stamp: '20261015' });
    const excel = TGU.buildExportFiles(sampleTables, { format: 'csv-excel', stamp: '20261015' });
    const md = TGU.buildExportFiles(sampleTables, { format: 'markdown', stamp: '20261015' });
    const json = TGU.buildExportFiles(sampleTables, { format: 'json', stamp: '20261015' });
    assertMatch(csv[0].filename, /\.csv$/);
    assertMatch(excel[0].filename, /\.csv$/);
    assertMatch(md[0].filename, /\.md$/);
    assertMatch(json[0].filename, /\.json$/);
    assertEqual(csv[0].mime, 'text/csv');
    assertEqual(md[0].mime, 'text/markdown');
    assertEqual(json[0].mime, 'application/json');
    assertEqual(excel[0].content.charCodeAt(0), 0xfeff, 'Excel 兼容 CSV 应带 BOM');
  });

  test('打包：JSON 单表结构包含 headers / records / matrix', function () {
    const files = TGU.buildExportFiles([sampleTables[0]], { format: 'json', stamp: '20261015' });
    const obj = JSON.parse(files[0].content);
    assertEqual(obj.headers, ['城市', '金额']);
    assertEqual(obj.records, [{ 城市: '北京', 金额: '100' }]);
    assertEqual(obj.matrix.length, 2);
  });

  test('打包：合并 JSON 是数组，长度等于选中表格数', function () {
    const files = TGU.buildExportFiles(sampleTables, { format: 'json', mode: 'merged', stamp: '20261015' });
    const arr = JSON.parse(files[0].content);
    assertEqual(Array.isArray(arr), true);
    assertEqual(arr.length, 2);
  });

  test('打包：文件名前缀生效且被清洗', function () {
    const files = TGU.buildExportFiles(sampleTables, {
      format: 'csv', stamp: '20261015', filenamePrefix: '2026 一季度/报表'
    });
    assertEqual(files[0].filename, '2026_一季度_报表_page_table_20261015_001.csv');
  });

  test('打包：未选中任何表格时返回空数组', function () {
    assertEqual(TGU.buildExportFiles([], { format: 'csv' }), []);
  });

  test('JSON 记录：表头重名自动去重', function () {
    const packed = TGU.matrixToRecords([['金额', '金额'], ['1', '2']], true);
    assertEqual(packed.headers, ['金额', '金额_1']);
  });

  test('JSON 记录：没有表头时使用「列1、列2」', function () {
    const packed = TGU.matrixToRecords([['1', '2']], false);
    assertEqual(packed.headers, ['列1', '列2']);
    assertEqual(packed.records, [{ 列1: '1', 列2: '2' }]);
  });

  /* ---------- 其他工具 ---------- */
  test('工具：utf8ByteLength 对中文按 3 字节计算', function () {
    assertEqual(TGU.utf8ByteLength('abc'), 3);
    assertEqual(TGU.utf8ByteLength('中文'), 6);
    assertEqual(TGU.utf8ByteLength('😀'), 4);
  });

  test('工具：normalizeCellText 折叠 HTML 空格与多余空行', function () {
    assertEqual(TGU.normalizeCellText('  a\u00a0\u00a0 b \n\n\n c '), 'a b\n\nc');
  });

  test('搜索：按标题、行列数、内容关键字命中', function () {
    const table = { index: 1, title: '销售报表', rowCount: 3, colCount: 4, previewText: '北京 上海 广州' };
    assertEqual(TGU.matchTable(table, ''), true);
    assertEqual(TGU.matchTable(table, '销售'), true);
    assertEqual(TGU.matchTable(table, '上海'), true);
    assertEqual(TGU.matchTable(table, '3行4列'), true);
    assertEqual(TGU.matchTable(table, '不存在的词'), false);
    assertEqual(TGU.matchTable(table, '销售 上海'), true, '多关键字应同时命中');
    assertEqual(TGU.matchTable(table, '销售 深圳'), false);
  });
}

/** 极简 CSV 解析器：仅用于测试往返一致性 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (ch === '\r') {
      // 忽略
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* =========================================================================
 * B. content.js：jsdom 真实 DOM 解析
 * ========================================================================= */

/** 构造测试页面 HTML */
function buildFixtureHTML() {
  return [
    '<!DOCTYPE html><html><head><title>测试页面</title></head><body>',
    '<h2 id="sales">2026 年一季度销售报表</h2>',
    '<table id="data-table">',
    '  <thead><tr><th>城市</th><th>销售额</th><th>同比</th></tr></thead>',
    '  <tbody>',
    '    <tr><td>北京</td><td>1,240,000</td><td>+12%</td></tr>',
    '    <tr><td>上海</td><td>980,000</td><td>-3%</td></tr>',
    '  </tbody>',
    '</table>',
    // 布局装饰表：单行 + 单元格里全是 div
    '<table id="layout-table"><tr><td><div>左侧导航</div></td><td><div>右侧内容</div></td></tr></table>',
    // 空表
    '<table id="empty-table"><tbody><tr><td></td><td></td></tr></tbody></table>',
    // 只有 1 行 3 列，默认被最小行数过滤
    '<table id="one-row"><tr><td>a</td><td>b</td><td>c</td></tr></table>',
    // rowspan / colspan 合并单元格
    '<table id="merged">',
    '  <tr><th>季度</th><th>2025</th><th>2026</th></tr>',
    '  <tr><td rowspan="2">上半年</td><td>100</td><td>120</td></tr>',
    '  <tr><td>110</td><td>150</td></tr>',
    '  <tr><td colspan="3">合计 480</td></tr>',
    '</table>',
    // 含特殊字符（逗号、引号、换行）
    '<table id="special">',
    '  <tr><th>描述</th><th>备注</th></tr>',
    '  <tr><td>北京,上海</td><td>他说"你好"</td></tr>',
    '  <tr><td>第一行<br>第二行</td><td> 两端空格 </td></tr>',
    '</table>',
    // 隐藏表格
    '<table id="hidden-table" style="display:none"><tr><td>隐藏列1</td><td>隐藏列2</td></tr><tr><td>x</td><td>y</td></tr></table>',
    '</body></html>'
  ].join('\n');
}

function loadContentScriptInJSDOM(html, storageData) {
  const dom = new JSDOM(html, {
    url: 'https://example.com/report',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const win = dom.window;
  const messageListeners = [];
  const storage = Object.assign({ position: null }, storageData || {});
  const setCalls = [];

  win.chrome = {
    runtime: {
      id: 'testextensionid',
      lastError: null,
      getURL: function (p) { return 'chrome-extension://testextensionid/' + p; },
      sendMessage: function () { /* 记录由测试显式读取 */ },
      onMessage: {
        addListener: function (fn) { messageListeners.push(fn); }
      }
    },
    storage: {
      local: {
        get: function (defaults, cb) {
          const result = {};
          Object.keys(defaults || {}).forEach(function (k) {
            result[k] = storage[k] === undefined ? defaults[k] : storage[k];
          });
          cb(result);
        },
        set: function (obj, cb) { setCalls.push(obj); Object.assign(storage, obj); if (cb) cb(); }
      },
      onChanged: { addListener: function () { /* 忽略 */ } }
    }
  };

  // 让内容脚本的 sendMessage 可被测试捕获
  const sentMessages = [];
  win.chrome.runtime.sendMessage = function (message, callback) {
    sentMessages.push(message);
    if (typeof callback === 'function') callback({ ok: true, id: 'fake', count: 0 });
  };

  win.eval(fs.readFileSync(LIB_PATH, 'utf8'));
  win.eval(fs.readFileSync(CONTENT_PATH, 'utf8'));

  return { dom, win, messageListeners, sentMessages, storage, setCalls };
}

/** 模拟后台向内容脚本发消息，返回响应（Promise） */
function ask(env, message) {
  return new Promise(function (resolve) {
    const listener = env.messageListeners[env.messageListeners.length - 1];
    if (!listener) { resolve({ ok: false, error: '内容脚本未注册消息监听' }); return; }
    let done = false;
    const ret = listener(message, { id: 'testextensionid' }, function (response) {
      if (done) return;
      done = true;
      resolve(response);
    });
    if (ret !== true && !done) {
      // 同步返回 undefined 且没调用 sendResponse
      setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: '无响应（同步返回）' }); } }, 20);
    }
  });
}

async function runContentTests() {
  group('B. content.js：真实 DOM 表格解析（jsdom）');

  const env = loadContentScriptInJSDOM(buildFixtureHTML());

  // 让 init() 里的异步流程跑完
  await new Promise(function (r) { setTimeout(r, 30); });

  /* ---------- 悬浮按钮注入 ---------- */
  await test('悬浮按钮：Shadow DOM 已注入且文案为「提取表格」', function () {
    const host = env.win.document.getElementById('tablegrab-floating-host');
    assert(host, '未找到悬浮按钮宿主元素');
    assert(host.shadowRoot, '宿主元素应带有 shadowRoot');
    const label = host.shadowRoot.querySelector('.tg-btn__label');
    assertEqual(label.textContent.trim(), '提取表格');
    assertMatch(host.style.cssText, /position:\s*fixed/, '宿主应为 fixed 定位');
    assertMatch(host.style.cssText, /right:\s*24px/, '默认应贴右下角');
  });

  await test('悬浮按钮：位置可按比例记忆并在注入时还原', async function () {
    const env2 = loadContentScriptInJSDOM(buildFixtureHTML(), { position: { rx: 0.5, ry: 0.25 } });
    await new Promise(function (r) { setTimeout(r, 30); });
    const host2 = env2.win.document.getElementById('tablegrab-floating-host');
    assert(host2, '未注入按钮');
    // jsdom 视口为 1024×768，宿主元素尺寸为 0，因此 left/top 应等于比例换算结果
    assertEqual(host2.style.left, '512px', 'left 应按 50% 视口宽度还原');
    assertEqual(host2.style.top, '192px', 'top 应按 25% 视口高度还原');
    assertEqual(host2.style.right, 'auto', '还原位置后 right 应为 auto');
    assertEqual(host2.style.bottom, 'auto', '还原位置后 bottom 应为 auto');
  });

  /* ---------- 统计接口 ---------- */
  const count = await ask(env, { type: TGU.MSG.COUNT_TABLES });
  await test('统计：COUNT_TABLES 返回总数与过滤结果', function () {
    assert(count && count.ok, '统计失败：' + JSON.stringify(count));
    assertEqual(count.total, 7, '页面上共 7 个 <table>');
    assertEqual(count.hidden, 1, '隐藏表格 1 个');
    assert(count.valid >= 3 && count.valid <= 5, '通过过滤的表格数量应在 3~5 之间，实际 ' + count.valid);
    assertEqual(count.title, '测试页面');
  });

  /* ---------- 完整提取 ---------- */
  const payload = await captureScan(env);

  await test('提取：payload 结构完整（id / 页面信息 / 表格数组）', function () {
    assert(payload, '没有捕获到提取消息');
    assert(payload.id && payload.id.length > 3, '应生成 payload id');
    assertEqual(payload.pageTitle, '测试页面');
    assertEqual(payload.sourceUrl, 'https://example.com/report');
    assertMatch(payload.capturedAt, /^\d{4}-\d{2}-\d{2}T/, 'capturedAt 应为 ISO 时间');
    assert(Array.isArray(payload.tables) && payload.tables.length > 0, 'tables 应为非空数组');
  });

  await test('提取：序号从 1 连续编号', function () {
    payload.tables.forEach(function (t, i) {
      assertEqual(t.index, i + 1, '第 ' + (i + 1) + ' 张表格序号应为 ' + (i + 1));
    });
  });

  await test('提取：布局装饰表与空表被过滤掉', function () {
    const titles = payload.tables.map(function (t) { return t.title + '|' + t.selector; });
    const joined = titles.join(' ');
    assert(joined.indexOf('layout-table') === -1, '布局表不应出现在结果中：' + joined);
    assert(joined.indexOf('empty-table') === -1, '空表不应出现在结果中：' + joined);
    assert(joined.indexOf('one-row') === -1, '单行表默认应被最小行数过滤');
  });

  await test('提取：数据表内容与行列数正确', function () {
    const t = findTable(payload, '#data-table');
    assert(t, '未找到 #data-table');
    assertEqual(t.rowCount, 3, '含表头共 3 行');
    assertEqual(t.colCount, 3);
    assertEqual(t.matrix[0], ['城市', '销售额', '同比']);
    assertEqual(t.matrix[1], ['北京', '1,240,000', '+12%']);
    assertEqual(t.headerRow, true, 'thead 应被识别为表头');
  });

  await test('提取：标题优先取最近的标题元素', function () {
    const t = findTable(payload, '#data-table');
    assertEqual(t.title, '2026 年一季度销售报表');
  });

  await test('提取：rowspan / colspan 被展开成规整矩阵', function () {
    const t = findTable(payload, '#merged');
    assert(t, '未找到 #merged');
    assertEqual(t.rowCount, 4);
    assertEqual(t.colCount, 3);
    assertEqual(t.matrix[1], ['上半年', '100', '120']);
    assertEqual(t.matrix[2], ['', '110', '150'], 'rowspan 占位应为空字符串');
    assertEqual(t.matrix[3], ['合计 480', '', ''], 'colspan 应展开并补空');
  });

  await test('提取：特殊字符（逗号/引号/换行）原样保留', function () {
    const t = findTable(payload, '#special');
    assert(t, '未找到 #special');
    assertEqual(t.matrix[1][0], '北京,上海');
    assertEqual(t.matrix[1][1], '他说"你好"');
    assertEqual(t.matrix[2][0], '第一行\n第二行');
    assertEqual(t.matrix[2][1], '两端空格');
  });

  await test('提取：导出的 CSV 可被正确解析回原矩阵', function () {
    const t = findTable(payload, '#special');
    const csv = TGU.toCSV(t.matrix);
    assertEqual(parseCSV(csv), t.matrix);
  });

  await test('提取：隐藏表格被标记 visible=false 但默认仍保留', function () {
    const t = findTable(payload, '#hidden-table');
    assert(t, '隐藏表格默认应保留');
    assertEqual(t.visible, false);
  });

  await test('提取：每张表格都保存了原始 HTML 片段', function () {
    payload.tables.forEach(function (t) {
      assert(typeof t.html === 'string' && t.html.indexOf('<table') === 0,
        '表格 ' + t.index + ' 的 html 字段异常');
    });
  });

  await test('提取：包含数据量统计与过滤计数', function () {
    assert(typeof payload.totalFound === 'number' && payload.totalFound === 7, 'totalFound 应为 7');
    assert(payload.skipped >= 1, '应记录被过滤的表格数');
    assert(payload.byteSize > 0, '应统计传输字节数');
  });

  /* ---------- SPA 动态渲染兼容 ---------- */
  await test('SPA 兼容：点击后动态插入的表格同样能被提取', async function () {
    // 模拟框架延迟渲染出表格
    const doc = env.win.document;
    const wrap = doc.createElement('div');
    wrap.innerHTML = '<table id="spa-table"><thead><tr><th>订单号</th><th>状态</th></tr></thead>' +
      '<tbody><tr><td>A001</td><td>已发货</td></tr><tr><td>A002</td><td>待付款</td></tr></tbody></table>';
    doc.body.appendChild(wrap);
    const again = await captureScan(env);
    const t = findTable(again, '#spa-table');
    assert(t, '动态渲染的表格未被提取到');
    assertEqual(t.matrix[1], ['A001', '已发货']);
  });

  await test('SPA 兼容：页面清空 body 后悬浮按钮会自动重新挂载', async function () {
    const doc = env.win.document;
    const oldHost = doc.getElementById('tablegrab-floating-host');
    assert(oldHost, '前置条件：按钮存在');
    oldHost.remove();
    await new Promise(function (r) { setTimeout(r, 30); });
    assert(doc.getElementById('tablegrab-floating-host'), '按钮应被重新挂载');
  });

  /* ---------- 异常处理 ---------- */
  await test('异常处理：空页面不会崩溃且返回空列表', async function () {
    const emptyEnv = loadContentScriptInJSDOM('<!DOCTYPE html><html><head><title>空页面</title></head><body><p>没有任何表格</p></body></html>');
    await new Promise(function (r) { setTimeout(r, 20); });
    const res = await ask(emptyEnv, { type: TGU.MSG.COUNT_TABLES });
    assert(res && res.ok, '空页面统计应正常返回');
    assertEqual(res.total, 0);
    assertEqual(res.valid, 0);
  });

  await test('异常处理：按钮点击时无表格会给出提示且不抛异常', async function () {
    const emptyEnv = loadContentScriptInJSDOM('<!DOCTYPE html><html><head><title>空页面</title></head><body></body></html>');
    await new Promise(function (r) { setTimeout(r, 20); });
    const btn = emptyEnv.win.document.getElementById('tablegrab-floating-host').shadowRoot.querySelector('.tg-btn');
    btn.dispatchEvent(new emptyEnv.win.Event('pointerdown', { bubbles: true }));
    const toast = emptyEnv.win.document
      .getElementById('tablegrab-floating-host').shadowRoot.querySelector('.tg-toast');
    // 直接触发内部扫描（pointerup 需要 PointerEvent，统一走 SCAN_NOW 更稳定）
    await ask(emptyEnv, { type: TGU.MSG.SCAN_NOW });
    await new Promise(function (r) { setTimeout(r, 20); });
    assert(/未找到有效表格/.test(toast.textContent), '应提示未找到有效表格，实际：' + toast.textContent);
    assertEqual(emptyEnv.sentMessages.length, 0, '没有表格时不应发送打开预览页的消息');
  });
}

/** 触发一次扫描并捕获 OPEN_GALLERY 消息 */
function captureScan(env) {
  return new Promise(function (resolve) {
    const original = env.win.chrome.runtime.sendMessage;
    let captured = null;
    env.win.chrome.runtime.sendMessage = function (message, callback) {
      if (message && message.type === TGU.MSG.OPEN_GALLERY) captured = message.payload;
      if (typeof callback === 'function') callback({ ok: true, id: 'fake' });
    };
    ask(env, { type: TGU.MSG.SCAN_NOW }).then(function () {
      setTimeout(function () {
        env.win.chrome.runtime.sendMessage = original;
        resolve(captured);
      }, 30);
    });
  });
}

function findTable(payload, selectorFragment) {
  return payload.tables.filter(function (t) {
    return (t.selector || '').indexOf(selectorFragment) !== -1;
  })[0];
}

/* =========================================================================
 * C. background.js：导出链路（vm 沙箱 + chrome API 桩）
 * ========================================================================= */
function createBackgroundSandbox() {
  const downloadCalls = [];
  const runtimeMessages = [];
  let onMessageListener = null;

  const sandbox = {
    console: { log: function () {}, warn: function () {}, error: console.error },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    btoa: btoa,
    TextEncoder: TextEncoder,
    Promise: Promise,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Set: Set,
    Map: Map,
    parseInt: parseInt,
    isNaN: isNaN,
    chrome: {
      runtime: {
        lastError: undefined,
        getURL: function (p) { return 'chrome-extension://test/' + p; },
        sendMessage: function (msg, cb) { runtimeMessages.push(msg); if (cb) cb(); },
        onMessage: { addListener: function (fn) { onMessageListener = fn; } },
        onInstalled: { addListener: function () {} }
      },
      storage: {
        local: {
          _data: {},
          // MV3 的 chrome.storage 同时支持「回调」与「Promise」两种用法，这里都要实现
          get: function (defaults, cb) {
            const out = Object.assign({}, defaults, sandbox.chrome.storage.local._data);
            if (typeof cb === 'function') cb(out);
            return Promise.resolve(out);
          },
          set: function (obj, cb) {
            Object.assign(sandbox.chrome.storage.local._data, obj);
            if (typeof cb === 'function') cb();
            return Promise.resolve();
          }
        },
        session: {
          _data: {},
          get: function (key) {
            const out = {};
            if (sandbox.chrome.storage.session._data[key] !== undefined) {
              out[key] = sandbox.chrome.storage.session._data[key];
            }
            return Promise.resolve(out);
          },
          set: function (obj) {
            Object.assign(sandbox.chrome.storage.session._data, obj);
            return Promise.resolve();
          }
        }
      },
      tabs: {
        create: function () { return Promise.resolve({ id: 99 }); },
        update: function () { return Promise.resolve({ id: 99 }); },
        get: function (id) { return Promise.resolve({ id: id, url: 'https://example.com/' }); },
        sendMessage: function () { return Promise.resolve({ ok: true }); },
        onUpdated: { addListener: function () {} },
        onRemoved: { addListener: function () {} },
        onActivated: { addListener: function () {} }
      },
      downloads: {
        download: function (options) {
          downloadCalls.push(options);
          return Promise.resolve(downloadCalls.length);
        }
      },
      action: {
        setBadgeText: function () {},
        setBadgeBackgroundColor: function () {},
        onClicked: { addListener: function () {} }
      },
      commands: { onCommand: { addListener: function () {} } },
      scripting: { executeScript: function () { return Promise.resolve([]); } }
    }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext('globalThis.self = globalThis;', ctx);
  sandbox.importScripts = function (p) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), ctx, { filename: p });
  };
  vm.runInContext(fs.readFileSync(BG_PATH, 'utf8'), ctx, { filename: 'background.js' });

  return {
    sandbox, ctx, downloadCalls, runtimeMessages,
    send: function (message) {
      return new Promise(function (resolve) {
        const ret = onMessageListener(message, { tab: { id: 7 } }, resolve);
        if (ret !== true) setTimeout(function () { resolve(undefined); }, 10);
      });
    }
  };
}

async function runBackgroundTests() {
  group('C. background.js：消息处理与下载链路');

  const bg = createBackgroundSandbox();

  const tables = [
    { index: 1, title: '销售表', matrix: [['城市', '金额'], ['北京', '100'], ['上海', '200']], headerRow: true },
    { index: 2, title: '库存表', matrix: [['商品', '数量'], ['苹果', '3']], headerRow: true }
  ];

  await test('SW：TG_EXPORT 单独文件模式逐个下载', async function () {
    const res = await bg.send({
      type: 'TG_EXPORT',
      tables: tables,
      indexes: [1, 2],
      format: 'csv',
      mode: 'separate'
    });
    assert(res && res.ok, '导出应成功：' + JSON.stringify(res));
    assertEqual(res.success, 2);
    assertEqual(res.failed, 0);
    assertEqual(bg.downloadCalls.length, 2);
    assertMatch(bg.downloadCalls[0].filename, /^page_table_\d{8}_001\.csv$/);
    assertMatch(bg.downloadCalls[1].filename, /^page_table_\d{8}_002\.csv$/);
    assertEqual(bg.downloadCalls[0].conflictAction, 'uniquify');
    assertEqual(bg.downloadCalls[0].saveAs, false);
  });

  await test('SW：下载内容是可解码的 data URL，内容与表格一致', function () {
    const url = bg.downloadCalls[0].url;
    assertMatch(url, /^data:text\/csv;charset=utf-8;base64,/);
    const base64 = url.split(',')[1];
    const text = Buffer.from(base64, 'base64').toString('utf8');
    assertEqual(text, '城市,金额\n北京,100\n上海,200\n');
  });

  await test('SW：Excel 兼容模式带 BOM 且使用 CRLF', async function () {
    bg.downloadCalls.length = 0;
    const res = await bg.send({
      type: 'TG_EXPORT', tables: [tables[0]], indexes: [1], format: 'csv-excel', mode: 'separate'
    });
    assertEqual(res.success, 1);
    const text = Buffer.from(bg.downloadCalls[0].url.split(',')[1], 'base64').toString('utf8');
    assertEqual(text.charCodeAt(0), 0xfeff, '应带 BOM');
    assert(text.indexOf('\r\n') !== -1, '应使用 CRLF 换行');
  });

  await test('SW：合并模式只产生一次下载', async function () {
    bg.downloadCalls.length = 0;
    const res = await bg.send({
      type: 'TG_EXPORT', tables: tables, indexes: [1, 2], format: 'markdown', mode: 'merged'
    });
    assertEqual(res.success, 1);
    assertEqual(bg.downloadCalls.length, 1);
    assertMatch(bg.downloadCalls[0].filename, /^page_table_\d{8}_all\.md$/);
    const text = Buffer.from(bg.downloadCalls[0].url.split(',')[1], 'base64').toString('utf8');
    assert(text.indexOf('销售表') !== -1 && text.indexOf('库存表') !== -1, '合并内容应包含两张表');
  });

  await test('SW：导出过程会广播 progress / done 进度', async function () {
    const before = bg.runtimeMessages.length;
    bg.downloadCalls.length = 0;
    await bg.send({ type: 'TG_EXPORT', tables: tables, indexes: [1], format: 'json', mode: 'separate' });
    const newMsgs = bg.runtimeMessages.slice(before);
    const stages = newMsgs.filter(function (m) { return m.type === 'TG_EXPORT_PROGRESS'; })
      .map(function (m) { return m.stage; });
    assert(stages.indexOf('start') !== -1, '应推送 start');
    assert(stages.indexOf('progress') !== -1, '应推送 progress');
    assert(stages.indexOf('done') !== -1, '应推送 done');
  });

  await test('SW：未提供表格时返回明确错误而不崩溃', async function () {
    const res = await bg.send({ type: 'TG_EXPORT', indexes: [1], format: 'csv', mode: 'separate' });
    assertEqual(res.ok, false);
    assertMatch(res.error, /没有可导出的表格/);
  });

  await test('SW：OPEN_GALLERY 存入数据并返回预览页信息', async function () {
    const payload = {
      id: 'ptest', pageTitle: '测试页', sourceUrl: 'https://example.com/',
      capturedAt: new Date().toISOString(), tables: tables
    };
    const res = await bg.send({ type: 'TG_OPEN_GALLERY', payload: payload });
    assert(res && res.ok, '应打开预览页：' + JSON.stringify(res));
    assertEqual(res.count, 2);
    assertEqual(res.reused, false);

    const back = await bg.send({ type: 'TG_GET_PAYLOAD', id: 'ptest' });
    assert(back && back.ok, '应能按 id 取回数据');
    assertEqual(back.payload.tables.length, 2);
  });

  await test('SW：GET_PAYLOAD 对未知 id 返回友好错误', async function () {
    const res = await bg.send({ type: 'TG_GET_PAYLOAD', id: 'not-exist' });
    assertEqual(res.ok, false);
    assertMatch(res.error, /数据已过期/);
  });

  await test('SW：SETTINGS 读写与默认值合并', async function () {
    const saved = await bg.send({ type: 'TG_SAVE_SETTINGS', settings: { minRows: 5, minCols: 3 } });
    assertEqual(saved.ok, true);
    assertEqual(saved.settings.minRows, 5);
    assertEqual(saved.settings.showFloatingButton, true, '未提供的项应回落默认值');
    const read = await bg.send({ type: 'TG_GET_SETTINGS' });
    assertEqual(read.settings.minRows, 5);
  });

  await test('SW：下载失败会被捕获并计入 failed 而不是抛异常', async function () {
    const original = bg.sandbox.chrome.downloads.download;
    bg.sandbox.chrome.downloads.download = function () {
      return Promise.reject(new Error('用户取消了下载'));
    };
    const res = await bg.send({
      type: 'TG_EXPORT', tables: [tables[0]], indexes: [1], format: 'csv', mode: 'separate'
    });
    bg.sandbox.chrome.downloads.download = original;
    assertEqual(res.ok, true);
    assertEqual(res.success, 0);
    assertEqual(res.failed, 1);
    assertMatch(res.files[0].error, /用户取消了下载/);
  });
}

/* =========================================================================
 * 主流程
 * ========================================================================= */
(async function main() {
  console.log('TableGrab 自动化测试\n====================');

  runPureTests();
  await runContentTests();
  await runBackgroundTests();

  console.log('\n====================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach(function (f) {
      console.log('  - ' + f.name + '\n    ' + (f.err && f.err.stack ? f.err.stack.split('\n')[0] : f.err));
    });
    process.exitCode = 1;
  }
})().catch(function (err) {
  console.error('测试运行异常：', err);
  process.exitCode = 1;
});
