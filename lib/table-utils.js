/**
 * TableGrab 表格抓取 —— 公共纯逻辑库
 * ---------------------------------------------------------------------------
 * 本文件同时被三处加载：
 *   1. content script（内容脚本隔离环境，共享 globalThis）
 *   2. service worker（background.js 通过 importScripts 引入）
 *   3. Node 单元测试（dev/run-tests.js 通过 vm 模块加载）
 * 因此这里只允许出现「无 DOM 依赖、无顶层副作用」的纯函数，
 * 所有对外能力统一挂载到 globalThis.TGU。
 */
(function (root) {
  'use strict';

  /* =========================================================================
   * 一、常量与默认配置
   * ========================================================================= */

  /** 默认设置：options 页面写入 chrome.storage.local，内容脚本读取 */
  const DEFAULT_SETTINGS = {
    showFloatingButton: true,      // 是否在页面右下角显示悬浮按钮
    minRows: 2,                    // 有效表格最小行数（少于该值视为空表/装饰表）
    minCols: 2,                    // 有效表格最小列数
    filterLayoutTables: true,      // 是否启用「布局表格」启发式过滤
    skipHiddenTables: false,       // 是否跳过 display:none / 零尺寸的表格
    usePageTitleInFilename: false  // 导出文件名是否带网页标题前缀
  };

  /** 各种硬性上限，防止超大页面把内存和消息体撑爆 */
  const LIMITS = {
    MAX_ROWS_PER_TABLE: 5000,        // 单表最多保留的数据行
    MAX_COLS_PER_TABLE: 200,         // 单表最多保留的数据列
    MAX_HTML_CHARS: 100000,          // 单表原始 HTML 最多保留字符数
    MAX_PAYLOAD_BYTES: 4 * 1024 * 1024, // 一次性传输给后台的数据上限（4MB）
    PREVIEW_ROWS: 12,                // 列表页默认预览行数
    PREVIEW_COLS: 10                 // 列表页默认预览列数
  };

  /** 导出格式定义 */
  const FORMATS = {
    csv: { ext: 'csv', mime: 'text/csv', label: 'CSV' },
    'csv-excel': { ext: 'csv', mime: 'text/csv', label: 'Excel 兼容 CSV' },
    markdown: { ext: 'md', mime: 'text/markdown', label: 'Markdown 表格' },
    json: { ext: 'json', mime: 'application/json', label: 'JSON' }
  };

  /* =========================================================================
   * 二、基础工具
   * ========================================================================= */

  /** 把任意值转成整数并夹在 [min, max] 区间内 */
  function clampInt(value, fallback, min, max) {
    const n = parseInt(value, 10);
    const v = isNaN(n) ? fallback : n;
    return Math.min(Math.max(v, min), max);
  }

  /** 合并用户设置与默认设置，并做类型/范围纠正 */
  function mergeSettings(settings) {
    const src = settings && typeof settings === 'object' ? settings : {};
    return {
      showFloatingButton: src.showFloatingButton !== false,
      minRows: clampInt(src.minRows, DEFAULT_SETTINGS.minRows, 1, 100),
      minCols: clampInt(src.minCols, DEFAULT_SETTINGS.minCols, 1, 100),
      filterLayoutTables: src.filterLayoutTables !== false,
      skipHiddenTables: src.skipHiddenTables === true,
      usePageTitleInFilename: src.usePageTitleInFilename === true
    };
  }

  /**
   * 单元格文本规范化（保留换行，用于 CSV / JSON 的数据保真）
   * - HTML 里的 &nbsp; 统一成普通空格
   * - 每行内部连续空白折叠为一个空格，行首尾去空白
   */
  function normalizeCellText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(function (line) { return line.replace(/[ \t\f\v]+/g, ' ').trim(); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 单行文本规范化（用于预览、Markdown、标题等场景） */
  function normalizeInlineText(raw) {
    return normalizeCellText(raw).replace(/\n+/g, ' ');
  }

  /** 计算字符串的 UTF-8 字节长度（content script / SW / Node 通用） */
  function utf8ByteLength(str) {
    const s = String(str == null ? '' : str);
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.codePointAt(i);
      if (code > 0xffff) i++;            // 代理对，跳过低位
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code < 0x10000) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  /* =========================================================================
   * 三、表格网格重建（rowspan / colspan 展开）
   * ========================================================================= */

  /**
   * 把「按行排列的单元格描述」还原成规整二维数组。
   * @param {Array<Array<{text:string,rowspan?:number,colspan?:number}>>} rows
   * @param {{repeatSpannedText?:boolean}} [options]
   * @returns {string[][]} 每行列数一致的二维数组
   */
  function buildMatrix(rows, options) {
    const opts = options || {};
    const repeatSpannedText = opts.repeatSpannedText === true;
    const grid = [];
    // 完全没有单元格的 <tr>（分隔行）不产生任何信息，先剔除，避免留下空行
    const list = (Array.isArray(rows) ? rows : []).filter(function (row) {
      return Array.isArray(row) && row.length > 0;
    });

    for (let r = 0; r < list.length; r++) {
      if (!grid[r]) grid[r] = [];
      const cells = list[r];
      let c = 0;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i] || {};
        // 跳过被上方 rowspan 占用的列
        while (grid[r][c] !== undefined) c++;
        const rowspan = clampInt(cell.rowspan, 1, 1, 500);
        const colspan = clampInt(cell.colspan, 1, 1, 200);
        const text = cell.text == null ? '' : String(cell.text);

        for (let dr = 0; dr < rowspan; dr++) {
          const rr = r + dr;
          if (!grid[rr]) grid[rr] = [];
          for (let dc = 0; dc < colspan; dc++) {
            const cc = c + dc;
            if (grid[rr][cc] !== undefined) continue; // 已被别的单元格占据
            const isOrigin = dr === 0 && dc === 0;
            grid[rr][cc] = (isOrigin || repeatSpannedText) ? text : '';
          }
        }
        c += colspan;
      }
    }

    // 统一每行列数，补齐空字符串
    let colCount = 0;
    for (let r = 0; r < grid.length; r++) {
      if (grid[r].length > colCount) colCount = grid[r].length;
    }
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < colCount; c++) {
        if (grid[r][c] === undefined) grid[r][c] = '';
      }
    }
    return grid;
  }

  /** 把二维数组裁剪到行/列上限，返回 {matrix, truncated} */
  function limitMatrix(matrix, maxRows, maxCols) {
    const rowLimit = maxRows || LIMITS.MAX_ROWS_PER_TABLE;
    const colLimit = maxCols || LIMITS.MAX_COLS_PER_TABLE;
    const truncated = matrix.length > rowLimit ||
      matrix.some(function (row) { return row.length > colLimit; });
    const out = matrix.slice(0, rowLimit).map(function (row) {
      return row.length > colLimit ? row.slice(0, colLimit) : row.slice();
    });
    return { matrix: out, truncated: truncated };
  }

  /** 统计表格规格：行数、列数、有效单元格数、文本总长度 */
  function analyzeMatrix(matrix) {
    let rowCount = matrix.length;
    let colCount = 0;
    let filledCells = 0;
    let textLength = 0;
    for (let r = 0; r < matrix.length; r++) {
      const row = matrix[r];
      if (row.length > colCount) colCount = row.length;
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (v != null && String(v).trim() !== '') {
          filledCells++;
          textLength += String(v).length;
        }
      }
    }
    return {
      rowCount: rowCount,
      colCount: colCount,
      filledCells: filledCells,
      textLength: textLength
    };
  }

  /**
   * 判断一张表是否「有效表格」
   * 过滤规则：行列过少、内容几乎为空、疑似纯布局表格
   * @param {object} stats analyzeMatrix 的结果（可附带 blockCellRatio / nestedTableCount）
   * @param {object} settings 用户设置
   */
  function isMeaningfulTable(stats, settings) {
    const s = mergeSettings(settings);
    if (!stats) return false;
    if (!stats.rowCount || !stats.colCount) return false;
    if (stats.rowCount < s.minRows || stats.colCount < s.minCols) return false;
    // 只有一个有效单元格 → 基本上是装饰 / 间距表格
    if (stats.filledCells < 2) return false;
    if (!stats.textLength) return false;
    // 布局表格启发式：少行 + 多单元格直接塞块级容器 + 文本极少
    if (s.filterLayoutTables) {
      const ratio = typeof stats.blockCellRatio === 'number' ? stats.blockCellRatio : 0;
      if (stats.rowCount <= 2 && stats.colCount >= 2 && ratio >= 0.8 && stats.textLength < 60) {
        return false;
      }
      // 表内直接嵌套表格且自身几乎没有文字，也认为是布局用途
      if (stats.nestedTableCount > 0 && stats.rowCount <= 2 && stats.textLength < 30) {
        return false;
      }
    }
    return true;
  }

  /* =========================================================================
   * 四、导出格式：CSV / Excel CSV / Markdown / JSON
   * ========================================================================= */

  /**
   * 单个 CSV 字段转义：
   * 含逗号、双引号、换行、回车时用双引号包裹，内部双引号写成两个双引号。
   */
  function csvCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s) || s !== s.trim()) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * 二维数组 → CSV 文本
   * @param {string[][]} matrix
   * @param {{bom?:boolean,crlf?:boolean}} [options] bom+crlf = Excel 兼容模式
   */
  function toCSV(matrix, options) {
    const opts = options || {};
    const eol = opts.crlf ? '\r\n' : '\n';
    const lines = matrix.map(function (row) {
      return row.map(csvCell).join(',');
    });
    const body = lines.join(eol);
    const head = opts.bom ? '\uFEFF' : '';
    return head + body + (body ? eol : '');
  }

  /** Markdown 单元格转义：反斜杠、竖线、换行 */
  function mdCell(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>')
      .trim();
  }

  /** 二维数组 → Markdown 表格（首行作为表头） */
  function toMarkdown(matrix) {
    if (!matrix || !matrix.length) return '';
    const colCount = matrix.reduce(function (max, row) {
      return Math.max(max, row.length);
    }, 0);
    const rows = matrix.map(function (row) {
      const cells = [];
      for (let c = 0; c < colCount; c++) cells.push(mdCell(row[c]));
      return cells;
    });
    const head = rows[0];
    const body = rows.slice(1);
    const lines = [
      '| ' + head.join(' | ') + ' |',
      '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'
    ];
    body.forEach(function (row) {
      lines.push('| ' + row.join(' | ') + ' |');
    });
    return lines.join('\n') + '\n';
  }

  /** 依据表头行把二维数组转成对象数组（无表头时用「列1、列2…」） */
  function matrixToRecords(matrix, hasHeaderRow) {
    if (!matrix.length) return { headers: [], records: [] };
    const colCount = matrix.reduce(function (max, row) {
      return Math.max(max, row.length);
    }, 0);
    const headerSource = hasHeaderRow ? matrix[0] : [];
    const headers = [];
    const used = {};
    for (let c = 0; c < colCount; c++) {
      let name = normalizeInlineText(headerSource[c]) || ('列' + (c + 1));
      if (used[name] != null) {         // 表头重名时补序号，避免对象键被覆盖
        used[name] += 1;
        name = name + '_' + used[name];
      } else {
        used[name] = 0;
      }
      headers.push(name);
    }
    const dataRows = hasHeaderRow ? matrix.slice(1) : matrix;
    const records = dataRows.map(function (row) {
      const obj = {};
      headers.forEach(function (name, c) {
        obj[name] = row[c] == null ? '' : row[c];
      });
      return obj;
    });
    return { headers: headers, records: records };
  }

  /** 单张表格 → 可 JSON 序列化的对象 */
  function tableToJSONObject(table, options) {
    const opts = options || {};
    const matrix = table.matrix || [];
    const packed = matrixToRecords(matrix, table.headerRow !== false);
    return {
      index: table.index,
      title: table.title || '',
      rowCount: matrix.length,
      colCount: matrix.reduce(function (max, row) { return Math.max(max, row.length); }, 0),
      headerRow: table.headerRow !== false,
      headers: packed.headers,
      headersText: packed.headers.join(','),
      sourceUrl: table.sourceUrl || '',
      pageTitle: table.pageTitle || '',
      capturedAt: table.capturedAt || '',
      truncated: !!table.truncated,
      records: packed.records,
      matrix: matrix
    };
  }

  /* =========================================================================
   * 五、文件名与打包
   * ========================================================================= */

  /** 生成 YYYYMMDD 形式的时间戳（用于 page_table_20261015_001.csv） */
  function timestampStamp(date) {
    const d = date instanceof Date ? date : new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  /** 序号补零：1 → 001 */
  function padNumber(n, width) {
    return String(n).padStart(width || 3, '0');
  }

  /** 清洗文件名：去掉路径分隔符与 Windows 非法字符 */
  function sanitizeFilename(name, fallback) {
    const cleaned = String(name == null ? '' : name)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[.\s_]+|[.\s_]+$/g, '');
    if (!cleaned) return fallback || 'table';
    return cleaned.slice(0, 100);
  }

  /** 生成合并导出里每个表格的分节标题 */
  function sectionTitle(table, ordinal) {
    const title = normalizeInlineText(table.title || ('表格 ' + (table.index || ordinal)));
    const matrix = table.matrix || [];
    const colCount = matrix.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
    return title + ' (' + matrix.length + ' 行 × ' + colCount + ' 列)';
  }

  /** 单张表格 → 指定格式的文本 */
  function renderTable(table, format) {
    if (format === 'markdown') {
      const head = '# ' + sectionTitle(table, table.index) + '\n\n';
      return head + toMarkdown(table.matrix || []);
    }
    if (format === 'json') {
      return JSON.stringify(tableToJSONObject(table), null, 2) + '\n';
    }
    // csv / csv-excel
    return toCSV(table.matrix || [], {
      bom: format === 'csv-excel',
      crlf: format === 'csv-excel'
    });
  }

  /** 多张表格 → 合并后的单文件内容 */
  function renderMerged(tables, format) {
    if (format === 'json') {
      return JSON.stringify(tables.map(function (t) { return tableToJSONObject(t); }), null, 2) + '\n';
    }
    if (format === 'markdown') {
      const parts = ['# 网页表格导出（共 ' + tables.length + ' 张）\n'];
      tables.forEach(function (t, i) {
        parts.push('## ' + sectionTitle(t, i + 1) + '\n');
        parts.push(toMarkdown(t.matrix || []));
      });
      return parts.join('\n');
    }
    // CSV 合并：用空行 + 分节说明行分隔，Excel 打开依然可读
    const bom = format === 'csv-excel' ? '\uFEFF' : '';
    const eol = format === 'csv-excel' ? '\r\n' : '\n';
    const blocks = tables.map(function (t, i) {
      const titleLine = csvCell('【' + padNumber(i + 1) + '】' + sectionTitle(t, i + 1));
      return titleLine + eol + toCSV(t.matrix || [], { crlf: format === 'csv-excel' });
    });
    return bom + blocks.join(eol);
  }

  /**
   * 生成待下载文件列表
   * @param {Array} tables 已勾选的表格（按导出顺序）
   * @param {{format:string,mode:'separate'|'merged',stamp?:string,filenamePrefix?:string}} options
   * @returns {Array<{filename:string,content:string,mime:string,order:number}>}
   */
  function buildExportFiles(tables, options) {
    const opts = options || {};
    const format = FORMATS[opts.format] ? opts.format : 'csv';
    const mode = opts.mode === 'merged' ? 'merged' : 'separate';
    const stamp = opts.stamp || timestampStamp(new Date());
    const suffix = opts.filenamePrefix ? sanitizeFilename(opts.filenamePrefix) + '_' : '';
    const meta = FORMATS[format];
    const files = [];

    if (!tables || !tables.length) return files;

    if (mode === 'merged') {
      files.push({
        order: 1,
        filename: suffix + 'page_table_' + stamp + '_all.' + meta.ext,
        content: renderMerged(tables, format),
        mime: meta.mime
      });
      return files;
    }

    tables.forEach(function (table, i) {
      files.push({
        order: i + 1,
        filename: suffix + 'page_table_' + stamp + '_' + padNumber(i + 1) + '.' + meta.ext,
        content: renderTable(table, format),
        mime: meta.mime
      });
    });
    return files;
  }

  /** 依据关键字过滤表格列表（列表页搜索框使用） */
  function matchTable(table, keyword) {
    const kw = normalizeInlineText(keyword).toLowerCase();
    if (!kw) return true;
    const terms = kw.split(/\s+/).filter(Boolean);
    const haystack = [
      table.title,
      'table ' + table.index,
      '表格 ' + table.index,
      table.rowCount + '行' + table.colCount + '列',
      (table.previewText || '')
    ].join(' ').toLowerCase();
    return terms.every(function (term) { return haystack.indexOf(term) !== -1; });
  }

  /* =========================================================================
   * 六、消息协议常量（内容脚本 / 后台 / 列表页共用）
   * ========================================================================= */
  const MSG = {
    OPEN_GALLERY: 'TG_OPEN_GALLERY',      // content → SW：保存数据并打开预览页
    GET_PAYLOAD: 'TG_GET_PAYLOAD',        // gallery → SW：按 id 取回数据
    PING: 'TG_PING',                      // SW → content：探活
    SCAN_NOW: 'TG_SCAN_NOW',              // SW → content：立即扫描
    RESCAN_TAB: 'TG_RESCAN_TAB',          // gallery → SW：重新扫描来源标签页
    EXPORT: 'TG_EXPORT',                  // gallery → SW：执行导出下载
    EXPORT_PROGRESS: 'TG_EXPORT_PROGRESS',// SW → gallery：导出进度推送
    GET_SETTINGS: 'TG_GET_SETTINGS',
    SAVE_SETTINGS: 'TG_SAVE_SETTINGS',
    TOAST: 'TG_TOAST',                    // SW → content：显示提示
    COUNT_TABLES: 'TG_COUNT_TABLES',      // SW → content：只统计不打开预览（设置页自检用）
    TEST_SCAN: 'TG_TEST_SCAN'             // options → SW：对最近浏览的网页做一次试扫
  };

  /** 判定「块级元素」用的标签集合：遍历文本时用来补空格，避免文字粘连 */
  const BLOCK_TAGS = {
    DIV: 1, P: 1, SECTION: 1, ARTICLE: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, MAIN: 1,
    NAV: 1, FORM: 1, FIGURE: 1, FIELDSET: 1, BLOCKQUOTE: 1, PRE: 1, ADDRESS: 1,
    UL: 1, OL: 1, DL: 1, LI: 1, DT: 1, DD: 1, TABLE: 1, TR: 1, TD: 1, TH: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HR: 1, CAPTION: 1
  };

  /**
   * 在不支持 / 不适合使用 innerText 时，用 DOM 遍历提取单元格文本。
   * 关键点：<br> 还原成换行，块级元素两侧补换行，保证多行内容不粘连。
   * @param {Node} node
   * @returns {string}
   */
  function textFromNode(node) {
    const out = [];
    const walk = function (current) {
      const children = current.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 3) {           // 文本节点
          out.push(child.nodeValue);
          continue;
        }
        if (child.nodeType !== 1) continue;    // 只关心元素节点
        const tag = (child.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') continue;
        if (tag === 'BR') { out.push('\n'); continue; }
        const isBlock = BLOCK_TAGS[tag] === 1;
        if (isBlock) out.push('\n');
        walk(child);
        if (isBlock) out.push('\n');
      }
    };
    walk(node);
    return out.join('');
  }

  const api = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    LIMITS: LIMITS,
    FORMATS: FORMATS,
    MSG: MSG,
    clampInt: clampInt,
    mergeSettings: mergeSettings,
    normalizeCellText: normalizeCellText,
    normalizeInlineText: normalizeInlineText,
    textFromNode: textFromNode,
    utf8ByteLength: utf8ByteLength,
    buildMatrix: buildMatrix,
    limitMatrix: limitMatrix,
    analyzeMatrix: analyzeMatrix,
    isMeaningfulTable: isMeaningfulTable,
    csvCell: csvCell,
    toCSV: toCSV,
    mdCell: mdCell,
    toMarkdown: toMarkdown,
    matrixToRecords: matrixToRecords,
    tableToJSONObject: tableToJSONObject,
    timestampStamp: timestampStamp,
    padNumber: padNumber,
    sanitizeFilename: sanitizeFilename,
    sectionTitle: sectionTitle,
    renderTable: renderTable,
    renderMerged: renderMerged,
    buildExportFiles: buildExportFiles,
    matchTable: matchTable
  };

  root.TGU = api;

  // 供 Node 测试环境以 require 方式获取（浏览器中 module 不存在，自动跳过）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
