/**
 * TableGrab 表格抓取 —— 内容脚本
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 在页面右下角注入可拖拽的悬浮按钮（Shadow DOM 隔离，样式见 content.css）
 *   2. 点击按钮后扫描页面全部 <table>，过滤空表 / 布局装饰表
 *   3. 把表格数据（二维数组 + 原始 HTML）通过 sendMessage 交给 service worker
 *   SPA 兼容：
 *   - 每次点击都是「实时扫描」，因此 Vue/React 动态渲染出来的表格同样能抓到
 *   - 监听 DOM 变化，被路由/框架删掉按钮时自动重新挂载
 */
(function () {
  'use strict';

  const TGU = globalThis.TGU;
  if (!TGU) {
    console.warn('[TableGrab] 公共库 TGU 未加载，脚本退出');
    return;
  }
  // 防止 declarative 注入与 scripting.executeScript 兜底注入重复初始化
  if (globalThis.__TABLEGRAB_CONTENT_LOADED__) return;
  globalThis.__TABLEGRAB_CONTENT_LOADED__ = true;

  const MSG = TGU.MSG;
  const HOST_ID = 'tablegrab-floating-host';
  /** 判定「块级布局容器」用的标签，用于布局表格启发式过滤 */
  const LAYOUT_TAGS = [
    'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'HEADER', 'FOOTER',
    'MAIN', 'FORM', 'UL', 'OL', 'DL', 'FIGURE', 'VIDEO', 'IFRAME'
  ];

  let settings = TGU.mergeSettings(null);
  let isBusy = false;
  let host = null;           // Shadow DOM 宿主元素
  let shadow = null;
  let btn = null;
  let toastEl = null;
  let badgeEl = null;
  let toastTimer = null;
  let dragState = null;
  let savedPosition = null;  // { rx, ry } 相对视口的比例坐标

  /* =========================================================================
   * 一、与扩展后台通信（统一 Promise 化 + 异常兜底）
   * ========================================================================= */
  function hasRuntime() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      if (!hasRuntime()) {
        reject(new Error('扩展上下文已失效，请刷新页面后重试'));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, function (response) {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message || '消息发送失败'));
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* =========================================================================
   * 二、设置读写（悬浮按钮开关等）
   * ========================================================================= */
  function loadSettings() {
    return new Promise(function (resolve) {
      if (!hasRuntime() || !chrome.storage || !chrome.storage.local) {
        resolve(settings);
        return;
      }
      try {
        chrome.storage.local.get({ settings: TGU.DEFAULT_SETTINGS }, function (items) {
          settings = TGU.mergeSettings(items && items.settings);
          resolve(settings);
        });
      } catch (e) {
        resolve(settings);
      }
    });
  }

  function watchSettingsChange() {
    if (!hasRuntime() || !chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      settings = TGU.mergeSettings(changes.settings.newValue);
      if (settings.showFloatingButton) ensureUI();
      else removeUI();
    });
  }

  /* =========================================================================
   * 三、页面表格解析
   * ========================================================================= */

  function isOwnNode(node) {
    return !!(host && (node === host || host.contains(node)));
  }

  /**
   * 探测当前环境是否真的会做布局计算。
   * 浏览器里 body 一定有尺寸；在无布局引擎的环境（单元测试、预渲染）中所有元素尺寸都是 0，
   * 此时若继续用「无几何矩形」判断隐藏，会把整页元素都误判成隐藏。
   */
  let layoutEngineCache = null;
  function hasLayoutEngine() {
    if (layoutEngineCache !== null) return layoutEngineCache;
    try {
      const probe = document.body || document.documentElement;
      if (!probe || typeof probe.getBoundingClientRect !== 'function') {
        layoutEngineCache = false;
      } else {
        const rect = probe.getBoundingClientRect();
        layoutEngineCache = !!(rect && (rect.width > 0 || rect.height > 0));
      }
    } catch (e) {
      layoutEngineCache = false;
    }
    return layoutEngineCache;
  }

  /** 元素是否可见（隐藏表格默认仍会保留，由设置决定是否跳过） */
  function isVisibleElement(el) {
    try {
      if (typeof window.getComputedStyle === 'function') {
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse')) {
          return false;
        }
      }
      if (el.isConnected === false) return false;
      // 几何兜底：display:none 的祖先不会继承到自身样式，但不会有任何几何矩形
      if (hasLayoutEngine() && typeof el.getClientRects === 'function') {
        const rects = el.getClientRects();
        if (rects && rects.length === 0) return false;
      }
    } catch (e) {
      return true;
    }
    return true;
  }

  /**
   * 读取单元格文本
   * 优先 innerText（能正确反映 <br>、CSS 隐藏元素），
   * 超大表格或非浏览器环境退化为 DOM 遍历（同样会还原换行），保证性能与一致性
   */
  function readCellText(cell, useInnerText) {
    let text = '';
    try {
      if (useInnerText && typeof cell.innerText === 'string' && cell.innerText.trim() !== '') {
        text = cell.innerText;
      } else {
        text = TGU.textFromNode(cell);
      }
    } catch (e) {
      text = cell.textContent || '';
    }
    text = TGU.normalizeCellText(text);
    if (text) return text;
    // 纯图标 / 纯控件单元格：退化为 alt、value，避免导出成空列
    try {
      if (typeof cell.querySelector === 'function') {
        const img = cell.querySelector('img[alt]');
        if (img) return TGU.normalizeCellText(img.getAttribute('alt') || '');
        const input = cell.querySelector('input[value]');
        if (input) return TGU.normalizeCellText(input.getAttribute('value') || '');
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /** 为表格生成一条尽量短、可直接在控制台使用的定位选择器 */
  function buildSelector(el) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node.tagName !== 'BODY' && depth < 5) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  /** 猜表格标题：caption → aria-label/data-title/title → 最近的标题元素 → 首个表头行 */
  function guessTableTitle(table, index) {
    try {
      if (table.caption) {
        const cap = TGU.normalizeInlineText(table.caption.textContent || '');
        if (cap) return cap.slice(0, 120);
      }
      const attr = table.getAttribute('aria-label') ||
        table.getAttribute('data-title') ||
        table.getAttribute('data-label') ||
        table.getAttribute('title');
      if (attr && attr.trim()) return TGU.normalizeInlineText(attr).slice(0, 120);

      // 向上最多 3 层，向前找最近的 h1~h6
      let node = table;
      for (let level = 0; node && level < 3; level++) {
        let prev = node.previousElementSibling;
        let hops = 0;
        while (prev && hops < 20) {
          if (/^H[1-6]$/.test(prev.tagName)) {
            const t = TGU.normalizeInlineText(prev.textContent || '');
            if (t) return t.slice(0, 120);
          }
          prev = prev.previousElementSibling;
          hops++;
        }
        node = node.parentElement;
      }

      // 首个表头行作为兜底名称
      const firstRow = table.rows && table.rows[0];
      if (firstRow && firstRow.cells && firstRow.cells.length) {
        const heads = Array.prototype.slice.call(firstRow.cells, 0, 4)
          .map(function (c) { return TGU.normalizeInlineText(c.textContent || ''); })
          .filter(Boolean);
        if (heads.length >= 2) return heads.join(' / ').slice(0, 120);
      }
    } catch (e) { /* 忽略 */ }
    return '表格 ' + index;
  }

  /** 多行表头合并成一行：2024 / Q1 → "2024 - Q1" */
  function mergeHeaderRows(matrix, headerCount) {
    if (headerCount <= 1 || matrix.length <= headerCount) return matrix;
    let colCount = 0;
    for (let r = 0; r < headerCount; r++) {
      colCount = Math.max(colCount, matrix[r] ? matrix[r].length : 0);
    }
    const merged = [];
    for (let c = 0; c < colCount; c++) {
      const parts = [];
      for (let r = 0; r < headerCount; r++) {
        const raw = (matrix[r] && matrix[r][c]) || '';
        const value = raw ? TGU.normalizeInlineText(raw) : (parts.length ? parts[parts.length - 1] : '');
        if (!parts.length || parts[parts.length - 1] !== value) parts.push(value);
      }
      merged.push(parts.filter(Boolean).join(' - '));
    }
    return [merged].concat(matrix.slice(headerCount));
  }

  /**
   * 解析单个 <table> 元素
   * @returns {object|null} 无效表格返回 null
   */
  function parseTableElement(table, ordinal, visible) {
    const rowEls = Array.prototype.slice.call(table.rows || []);
    if (!rowEls.length) return null;

    const useInnerText = rowEls.length <= 1500; // 超大表禁用 innerText，避免反复触发布局计算
    const descriptors = [];
    let totalCells = 0;
    let blockCells = 0;
    let cellTags = [];

    const scanRows = rowEls.slice(0, TGU.LIMITS.MAX_ROWS_PER_TABLE);
    for (let r = 0; r < scanRows.length; r++) {
      const cellEls = Array.prototype.slice.call(scanRows[r].cells || []);
      const rowDesc = [];
      for (let i = 0; i < cellEls.length; i++) {
        const cellEl = cellEls[i];
        totalCells++;
        // 布局表格启发式：单元格里直接塞块级容器
        try {
          if (cellEl.children && cellEl.children.length) {
            const firstTag = (cellEl.children[0].tagName || '').toUpperCase();
            if (LAYOUT_TAGS.indexOf(firstTag) !== -1) blockCells++;
          }
        } catch (e) { /* 忽略 */ }
        if (r < 2) cellTags.push(cellEl.tagName);
        rowDesc.push({
          text: readCellText(cellEl, useInnerText),
          rowspan: TGU.clampInt(cellEl.rowSpan, 1, 1, 500),
          colspan: TGU.clampInt(cellEl.colSpan, 1, 1, 200)
        });
      }
      descriptors.push(rowDesc);
    }

    // 展开 rowspan / colspan，得到规整二维数组
    let matrix = TGU.buildMatrix(descriptors);

    // 判断表头：有 thead → 表头行数取 thead 行数；否则首行全是 th → 1 行
    let headerRowCount = 0;
    if (table.tHead && table.tHead.rows && table.tHead.rows.length) {
      headerRowCount = Math.min(table.tHead.rows.length, matrix.length);
    } else if (rowEls[0] && rowEls[0].cells && rowEls[0].cells.length) {
      const firstCells = Array.prototype.slice.call(rowEls[0].cells);
      if (firstCells.length && firstCells.every(function (c) { return c.tagName === 'TH'; })) {
        headerRowCount = 1;
      }
    }
    if (headerRowCount > 1) matrix = mergeHeaderRows(matrix, headerRowCount);

    const limited = TGU.limitMatrix(matrix, TGU.LIMITS.MAX_ROWS_PER_TABLE, TGU.LIMITS.MAX_COLS_PER_TABLE);
    matrix = limited.matrix;

    const stats = TGU.analyzeMatrix(matrix);
    stats.blockCellRatio = totalCells ? blockCells / totalCells : 0;
    try {
      stats.nestedTableCount = table.querySelectorAll('table').length;
    } catch (e) {
      stats.nestedTableCount = 0;
    }

    if (!TGU.isMeaningfulTable(stats, settings)) return null;

    // 保留原始 HTML 供追溯（超长时截断，避免消息体过大）
    let html = '';
    let htmlTruncated = false;
    try {
      html = table.outerHTML || '';
      if (html.length > TGU.LIMITS.MAX_HTML_CHARS) {
        html = html.slice(0, TGU.LIMITS.MAX_HTML_CHARS);
        htmlTruncated = true;
      }
    } catch (e) { html = ''; }

    // 预览用的纯文本，供列表页搜索
    const previewText = matrix.slice(0, 4).map(function (row) {
      return row.slice(0, 10).join(' ');
    }).join(' ').slice(0, 500);

    return {
      id: 't' + ordinal,
      index: ordinal,
      title: guessTableTitle(table, ordinal),
      selector: buildSelector(table),
      visible: visible !== false,
      rowCount: stats.rowCount,
      colCount: stats.colCount,
      filledCells: stats.filledCells,
      textLength: stats.textLength,
      headerRow: headerRowCount > 0,
      headerRowCount: headerRowCount,
      truncated: !!limited.truncated,
      html: html,
      htmlTruncated: htmlTruncated,
      matrix: matrix,
      previewText: previewText
    };
  }

  /** 扫描整页表格，返回 { tables, skipped, hiddenCount, totalFound } */
  function collectAllTables() {
    let nodes;
    try {
      nodes = document.querySelectorAll('table');
    } catch (e) {
      nodes = [];
    }
    const collected = [];
    let skipped = 0;
    let hiddenCount = 0;

    for (let i = 0; i < nodes.length; i++) {
      const table = nodes[i];
      if (isOwnNode(table)) continue;
      try {
        const visible = isVisibleElement(table);
        if (!visible) {
          hiddenCount++;
          if (settings.skipHiddenTables) { skipped++; continue; }
        }
        const parsed = parseTableElement(table, collected.length + 1, visible);
        if (!parsed) { skipped++; continue; }
        collected.push(parsed);
      } catch (err) {
        skipped++;
        console.warn('[TableGrab] 解析表格失败：', err);
      }
    }

    // 过滤后统一重新编号，保证列表序号连续（1、2、3…）
    collected.forEach(function (t, i) {
      t.index = i + 1;
      t.id = 't' + (i + 1);
    });

    return {
      tables: collected,
      skipped: skipped,
      hiddenCount: hiddenCount,
      totalFound: nodes.length
    };
  }

  /**
   * 组装最终 payload，并做体积保护（依次：丢原始 HTML → 截断行 → 丢弃末尾表格）
   */
  function buildPayload(scanResult) {
    const payload = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      pageTitle: document.title || '未命名页面',
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      settings: {
        minRows: settings.minRows,
        minCols: settings.minCols,
        filterLayoutTables: settings.filterLayoutTables
      },
      totalFound: scanResult.totalFound,
      skipped: scanResult.skipped,
      hiddenCount: scanResult.hiddenCount,
      notices: [],
      tables: scanResult.tables
    };

    const limit = TGU.LIMITS.MAX_PAYLOAD_BYTES;
    let size = TGU.utf8ByteLength(JSON.stringify(payload));

    // 第一级：丢弃原始 HTML
    if (size > limit) {
      payload.tables.forEach(function (t) { t.html = ''; t.htmlDropped = true; });
      payload.notices.push('数据量较大，已省略原始 HTML 源码以保证传输稳定');
      size = TGU.utf8ByteLength(JSON.stringify(payload));
    }

    // 第二级：反复压缩行数最多的表格
    let guard = 0;
    while (size > limit && guard < 40) {
      let target = null;
      payload.tables.forEach(function (t) {
        if (t.matrix.length > 20 && (!target || t.matrix.length > target.matrix.length)) target = t;
      });
      if (!target) break;
      const keep = Math.max(20, Math.floor(target.matrix.length * 0.6));
      target.matrix = target.matrix.slice(0, keep);
      target.rowCount = keep;
      target.truncated = true;
      target.previewText = target.matrix.slice(0, 4).map(function (row) {
        return row.slice(0, 10).join(' ');
      }).join(' ').slice(0, 500);
      payload.notices.push('超大表格已截断，保证导出稳定');
      size = TGU.utf8ByteLength(JSON.stringify(payload));
      guard++;
    }

    // 第三级：仍然超限则丢弃末尾表格
    while (size > limit && payload.tables.length > 1) {
      payload.tables.pop();
      payload.notices.push('超出单次传输上限，已丢弃部分表格');
      size = TGU.utf8ByteLength(JSON.stringify(payload));
    }

    payload.byteSize = size;
    return payload;
  }

  /* =========================================================================
   * 四、悬浮按钮 UI（Shadow DOM）
   * ========================================================================= */

  function ensureUI() {
    if (host && document.documentElement.contains(host)) return;
    if (!document.body && !document.documentElement) return;

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-tablegrab', '1');
    // 用 all:initial 阻断页面样式继承，再用内联样式保证定位稳定
    host.style.cssText = [
      'all:initial',
      'position:fixed',
      'display:block',
      'z-index:2147483647',
      'right:24px',
      'bottom:24px',
      'left:auto',
      'top:auto',
      'width:auto',
      'height:auto',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'pointer-events:auto',
      'transform:none'
    ].join(';') + ';';

    shadow = host.attachShadow({ mode: 'open' });

    // content.css 通过 web_accessible_resources 暴露，注入到 shadow 内部
    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('content.css');
      shadow.appendChild(link);
    } catch (e) { /* 样式加载失败不影响功能 */ }

    const root = document.createElement('div');
    root.className = 'tg-root';
    root.innerHTML = [
      '<div class="tg-toast" role="status" aria-live="polite"></div>',
      '<button class="tg-btn" type="button" aria-label="提取表格" title="TableGrab：提取当前页面全部表格（按住可拖拽移动）">',
      '  <span class="tg-btn__grip" aria-hidden="true"></span>',
      '  <span class="tg-btn__icon" aria-hidden="true">',
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '      <rect x="3" y="3" width="18" height="18" rx="2" />',
      '      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />',
      '    </svg>',
      '  </span>',
      '  <span class="tg-btn__label">提取表格</span>',
      '  <span class="tg-btn__badge" hidden>0</span>',
      '</button>'
    ].join('\n');
    shadow.appendChild(root);

    toastEl = root.querySelector('.tg-toast');
    btn = root.querySelector('.tg-btn');
    badgeEl = root.querySelector('.tg-btn__badge');

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('pointermove', onPointerMove);
    btn.addEventListener('pointerup', onPointerUp);
    btn.addEventListener('pointercancel', onPointerUp);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    document.documentElement.appendChild(host);
    applySavedPosition();
    watchHostRemoval();
  }

  function removeUI() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; shadow = null; btn = null; toastEl = null; badgeEl = null;
  }

  /* ------------------------------ 拖拽逻辑 ------------------------------ */
  function onPointerDown(e) {
    if (e.button !== 0) return;
    const rect = host.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      width: rect.width,
      height: rect.height,
      moved: false
    };
    try { btn.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  }

  function onPointerMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 5) return; // 抖动阈值，区分点击与拖拽
    if (!dragState.moved) {
      dragState.moved = true;
      shadow.querySelector('.tg-root').classList.add('is-dragging');
    }
    const pos = clampPosition(dragState.originLeft + dx, dragState.originTop + dy, dragState.width, dragState.height);
    setHostPosition(pos.left, pos.top);
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    try { btn.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (shadow) {
      const root = shadow.querySelector('.tg-root');
      if (root) root.classList.remove('is-dragging');
    }
    if (!moved) {
      startScan();          // 未发生位移 → 视为点击
    } else {
      persistPosition();    // 拖拽结束 → 记住新位置
    }
  }

  function clampPosition(left, top, width, height) {
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const w = width || 120;
    const h = height || 40;
    return {
      left: Math.min(Math.max(left, 4), Math.max(4, vw - w - 4)),
      top: Math.min(Math.max(top, 4), Math.max(4, vh - h - 4))
    };
  }

  function setHostPosition(left, top) {
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }

  /** 存「相对视口的比例」，换窗口大小也能落在合理位置 */
  function persistPosition() {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const payload = {
      rx: Math.min(1, Math.max(0, rect.left / vw)),
      ry: Math.min(1, Math.max(0, rect.top / vh))
    };
    savedPosition = payload;
    if (hasRuntime() && chrome.storage && chrome.storage.local) {
      try { chrome.storage.local.set({ position: payload }); } catch (e) { /* 忽略 */ }
    }
  }

  function applySavedPosition() {
    if (!savedPosition || !host) return;
    const rect = host.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const pos = clampPosition(
      savedPosition.rx * vw,
      savedPosition.ry * vh,
      rect.width || 120,
      rect.height || 40
    );
    setHostPosition(pos.left, pos.top);
  }

  function loadPosition() {
    return new Promise(function (resolve) {
      if (!hasRuntime() || !chrome.storage || !chrome.storage.local) { resolve(); return; }
      try {
        chrome.storage.local.get({ position: null }, function (items) {
          if (items && items.position &&
            typeof items.position.rx === 'number' && typeof items.position.ry === 'number') {
            savedPosition = items.position;
          }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  /** 部分 SPA 会整块替换 body，导致按钮被移除 → 自动重新挂载 */
  function watchHostRemoval() {
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(function () {
      if (!settings.showFloatingButton) return;
      if (!host || !document.documentElement.contains(host)) {
        const oldPos = savedPosition;
        host = null;
        ensureUI();
        savedPosition = oldPos;
        applySavedPosition();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: false });
  }

  let resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applySavedPosition, 150);
  });

  /* ------------------------------ Toast 提示 ------------------------------ */
  function showToast(message, type, duration) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = 'tg-toast is-visible' + (type ? ' is-' + type : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.className = 'tg-toast';
    }, duration || 3000);
  }

  function updateBadge(count) {
    if (!badgeEl) return;
    if (typeof count === 'number' && count > 0) {
      badgeEl.hidden = false;
      badgeEl.textContent = count > 99 ? '99+' : String(count);
    } else {
      badgeEl.hidden = true;
    }
  }

  function setBusy(busy) {
    isBusy = busy;
    if (!shadow) return;
    const root = shadow.querySelector('.tg-root');
    if (root) root.classList.toggle('is-busy', busy);
  }

  /* =========================================================================
   * 五、扫描并交给后台
   * ========================================================================= */
  async function startScan() {
    if (isBusy) return;
    setBusy(true);
    showToast('正在扫描页面表格…', null, 1500);
    try {
      const scanResult = collectAllTables();
      const payload = buildPayload(scanResult);
      updateBadge(payload.tables.length);

      if (!payload.tables.length) {
        showToast(
          '未找到有效表格。本页共 ' + scanResult.totalFound + ' 个 <table>，' +
          '已忽略 ' + scanResult.skipped + ' 个空表/装饰表' +
          (scanResult.hiddenCount ? '（另有 ' + scanResult.hiddenCount + ' 个隐藏表格，可在设置中关闭过滤）' : ''),
          'error',
          5000
        );
        return;
      }

      const response = await sendMessage({ type: MSG.OPEN_GALLERY, payload: payload });
      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : '后台未响应');
      }
      showToast('已提取 ' + payload.tables.length + ' 张表格，正在新标签页打开预览', 'success', 3500);
    } catch (err) {
      showToast('提取失败：' + (err && err.message ? err.message : String(err)), 'error', 5000);
      console.warn('[TableGrab] 提取失败：', err);
    } finally {
      setBusy(false);
    }
  }

  /** 对外暴露一份手动触发入口，方便调试 / 工具栏图标调用 */
  function scanNow() {
    return startScan();
  }

  /* =========================================================================
   * 六、来自后台的消息 & 初始化
   * ========================================================================= */
  function listenRuntimeMessages() {
    if (!hasRuntime() || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || !message.type) return undefined;
      if (message.type === MSG.PING) {
        sendResponse({ ok: true, ready: true });
        return undefined;
      }
      if (message.type === MSG.SCAN_NOW) {
        startScan();
        sendResponse({ ok: true });
        return undefined;
      }
      if (message.type === MSG.COUNT_TABLES) {
        // 设置页自检：只统计数量，不打开预览页
        try {
          const result = collectAllTables();
          sendResponse({
            ok: true,
            total: result.totalFound,
            valid: result.tables.length,
            skipped: result.skipped,
            hidden: result.hiddenCount,
            title: document.title || '',
            url: location.href
          });
        } catch (e) {
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        }
        return undefined;
      }
      if (message.type === MSG.TOAST) {
        showToast(message.text || '', message.level || null, message.duration);
        sendResponse({ ok: true });
        return undefined;
      }
      return undefined;
    });
  }

  async function init() {
    await loadSettings();
    await loadPosition();
    if (settings.showFloatingButton) {
      if (document.body) {
        ensureUI();
      } else {
        // document_start 场景下 body 还没生成，等 DOM 就绪
        document.addEventListener('DOMContentLoaded', function () {
          if (settings.showFloatingButton) ensureUI();
        }, { once: true });
      }
    }
    watchSettingsChange();
    listenRuntimeMessages();
  }

  init();

  // 供调试：控制台执行 window.__tablegrabScan() 也能触发（隔离环境下需从扩展上下文调用）
  try {
    globalThis.__tablegrabScan = scanNow;
  } catch (e) { /* 忽略 */ }
})();
