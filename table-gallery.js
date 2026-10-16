/**
 * TableGrab 表格抓取 —— 预览页逻辑
 * ---------------------------------------------------------------------------
 * 功能：读取后台暂存的表格数据 → 渲染卡片列表（预览 + 搜索）→ 勾选 → 批量导出
 * 依赖：lib/table-utils.js（TGU）中的格式化与工具函数
 */
(function () {
  'use strict';

  const TGU = globalThis.TGU;
  if (!TGU) {
    alert('TableGrab 公共库加载失败，请重新加载扩展。');
    return;
  }
  const MSG = TGU.MSG;
  const LIMITS = TGU.LIMITS;

  /* ============================ 状态 ============================ */
  const state = {
    payload: null,
    payloadId: null,
    selected: new Set(),     // 已勾选的表格 index
    expanded: new Set(),     // 已「展开全部行」的表格 index
    sourceVisible: new Set(),// 已展开原始 HTML 的表格 index
    keyword: '',
    rendered: 0,             // 已渲染的卡片数量（卡片较多时分批渲染）
    exporting: false,
    prefs: {
      format: 'csv',
      mode: 'separate',
      titlePrefix: false
    }
  };
  const BATCH_SIZE = 40;

  /* ============================ DOM 引用 ============================ */
  const el = {};

  function cacheElements() {
    [
      'sourceInfo', 'btnRescan', 'btnOpenSource', 'btnOptions', 'noticeBar',
      'emptyState', 'emptyTitle', 'emptyDesc', 'btnEmptyRescan',
      'toolbar', 'searchInput', 'btnSelectAll', 'btnInvert', 'btnClear',
      'counter', 'formatSelect', 'modeSelect', 'titlePrefix', 'btnExport',
      'tableList', 'statusText', 'statusDot', 'progress', 'progressBar',
      'btnOpenFolder', 'toast'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  /* ============================ 消息封装 ============================ */
  function sendMessage(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message || '后台通信失败')); return; }
          resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ============================ 通用 UI ============================ */
  let toastTimer = null;
  function showToast(text, type, duration) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.className = 'toast is-visible' + (type ? ' is-' + type : '');
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
      el.toast.className = 'toast';
    }, duration || 3200);
  }

  function setStatus(text, kind) {
    if (el.statusText) el.statusText.textContent = text;
    if (el.statusDot) {
      el.statusDot.className = 'status-dot' +
        (kind === 'ok' ? ' is-ok' : kind === 'error' ? ' is-error' : kind === 'busy' ? ' is-busy' : '');
    }
  }

  function setProgress(done, total) {
    if (!el.progress || !el.progressBar) return;
    if (!total) {
      el.progress.hidden = true;
      el.progressBar.style.width = '0%';
      return;
    }
    el.progress.hidden = false;
    el.progressBar.style.width = Math.round((done / total) * 100) + '%';
  }

  function setExporting(busy) {
    state.exporting = busy;
    updateSelectionUI();
  }

  /* ============================ 启动流程 ============================ */
  function boot() {
    cacheElements();
    bindEvents();
    listenProgress();

    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      showEmpty('没有收到表格数据', '请回到目标网页，点击右下角「提取表格」悬浮按钮或工具栏图标重新提取。');
      setStatus('等待提取数据', 'error');
      return;
    }

    setStatus('正在载入提取结果…', 'busy');
    sendMessage({ type: MSG.GET_PAYLOAD, id: id })
      .then(function (res) {
        if (!res || !res.ok) {
          showEmpty('表格数据已失效', (res && res.error) || '后台没有找到这次提取的数据，请重新提取。');
          setStatus('数据已失效', 'error');
          return;
        }
        state.payload = res.payload;
        state.payloadId = id;
        // 默认全选，减少一次点击
        state.payload.tables.forEach(function (t) { state.selected.add(t.index); });
        return loadPrefs().then(function () {
          renderHeader();
          renderNotices();
          renderList(true);
          updateSelectionUI();
          setStatus('共 ' + state.payload.tables.length + ' 张表格，已默认全选', 'ok');
        });
      })
      .catch(function (err) {
        showEmpty('载入失败', (err && err.message) || String(err));
        setStatus('载入失败：' + ((err && err.message) || err), 'error');
      });
  }

  function showEmpty(title, desc) {
    if (el.toolbar) el.toolbar.hidden = true;
    if (el.emptyState) {
      el.emptyState.hidden = false;
      if (title) el.emptyTitle.textContent = title;
      if (desc) el.emptyDesc.textContent = desc;
    }
  }

  /* ============================ 顶部信息 & 提示条 ============================ */
  function renderHeader() {
    const p = state.payload;
    const time = p.capturedAt ? new Date(p.capturedAt) : null;
    const timeText = time && !isNaN(time.getTime())
      ? time.toLocaleString('zh-CN', { hour12: false })
      : '';
    el.sourceInfo.textContent = [
      p.pageTitle || '未命名页面',
      '共 ' + p.tables.length + ' 张有效表格',
      timeText ? '提取于 ' + timeText : ''
    ].filter(Boolean).join(' · ');
    el.sourceInfo.title = p.sourceUrl || '';
  }

  function renderNotices() {
    const p = state.payload;
    const lines = [];
    if (p.skipped) {
      lines.push('已自动过滤 ' + p.skipped + ' 个空表或布局装饰表' +
        (p.hiddenCount ? '（本页共 ' + p.hiddenCount + ' 个隐藏表格）' : ''));
    }
    (p.notices || []).forEach(function (n) { lines.push(n); });
    const truncated = p.tables.filter(function (t) { return t.truncated; });
    if (truncated.length) {
      lines.push('有 ' + truncated.length + ' 张表格超过行/列上限，导出内容已按上限截断');
    }

    if (!lines.length) {
      el.noticeBar.hidden = true;
      return;
    }
    el.noticeBar.innerHTML = '';
    const ul = document.createElement('ul');
    lines.forEach(function (text) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    });
    el.noticeBar.appendChild(ul);
    el.noticeBar.hidden = false;
  }

  /* ============================ 列表渲染 ============================ */
  function visibleTables() {
    const all = state.payload ? state.payload.tables : [];
    return all.filter(function (t) { return TGU.matchTable(t, state.keyword); });
  }

  function renderList(reset) {
    if (reset) {
      el.tableList.innerHTML = '';
      state.rendered = 0;
    }
    const matched = visibleTables();
    if (!matched.length) {
      if (el.tableList.childElementCount === 0) {
        showEmpty(
          '没有匹配的表格',
          '当前搜索关键字「' + state.keyword + '」没有命中任何表格，换个关键字试试。'
        );
      }
      return;
    }
    el.emptyState.hidden = true;
    el.toolbar.hidden = false;

    const next = matched.slice(state.rendered, state.rendered + BATCH_SIZE);
    next.forEach(function (table) {
      el.tableList.appendChild(createCard(table));
    });
    state.rendered += next.length;

    // 分批渲染控制按钮
    const oldMore = document.getElementById('loadMoreWrap');
    if (oldMore) oldMore.remove();
    const remaining = matched.length - state.rendered;
    if (remaining > 0) {
      const wrap = document.createElement('div');
      wrap.id = 'loadMoreWrap';
      wrap.style.textAlign = 'center';
      wrap.style.padding = '6px 0 2px';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = '显示更多表格（还有 ' + remaining + ' 张）';
      btn.addEventListener('click', function () { renderList(false); });
      wrap.appendChild(btn);
      el.tableList.appendChild(wrap);
    }
  }

  /** 创建单张表格卡片 */
  function createCard(table) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.index = String(table.index);
    card.dataset.text = (table.previewText || '') + ' ' + (table.title || '');

    /* ---------- 头部 ---------- */
    const head = document.createElement('div');
    head.className = 'card__head';

    const checkLabel = document.createElement('label');
    checkLabel.className = 'check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(table.index);
    checkbox.setAttribute('aria-label', '选择表格 ' + table.index);
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) state.selected.add(table.index);
      else state.selected.delete(table.index);
      card.classList.toggle('is-selected', checkbox.checked);
      updateSelectionUI();
    });
    checkLabel.appendChild(checkbox);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'card__title';
    const titleRow = document.createElement('div');
    titleRow.className = 'card__title-row';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '表格 ' + table.index;
    const name = document.createElement('h2');
    name.className = 'card__name';
    name.textContent = table.title || ('表格 ' + table.index);
    titleRow.appendChild(tag);
    titleRow.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'card__meta';
    meta.appendChild(metaItem('行数', String(table.rowCount)));
    meta.appendChild(metaItem('列数', String(table.colCount)));
    if (table.headerRow) meta.appendChild(metaItem('表头', table.headerRowCount > 1 ? table.headerRowCount + ' 行' : '已识别'));
    if (table.truncated) {
      const warn = document.createElement('span');
      warn.className = 'badge-warn';
      warn.textContent = '已截断';
      meta.appendChild(warn);
    }
    if (table.visible === false) {
      const hint = document.createElement('span');
      hint.className = 'badge-hint';
      hint.textContent = '页面中隐藏';
      meta.appendChild(hint);
    }
    if (table.selector) {
      const sel = document.createElement('span');
      sel.className = 'badge-hint';
      sel.textContent = table.selector;
      sel.title = '页面内定位选择器：' + table.selector;
      meta.appendChild(sel);
    }
    titleWrap.appendChild(titleRow);
    titleWrap.appendChild(meta);

    /* ---------- 操作按钮 ---------- */
    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const expandBtn = makeMiniButton('展开全部行', function () {
      if (state.expanded.has(table.index)) {
        state.expanded.delete(table.index);
        expandBtn.textContent = '展开全部行';
      } else {
        state.expanded.add(table.index);
        expandBtn.textContent = '收起';
      }
      refreshPreview();
    });
    if (table.rowCount <= LIMITS.PREVIEW_ROWS && table.colCount <= LIMITS.PREVIEW_COLS) {
      expandBtn.disabled = true;
      expandBtn.textContent = '已完整显示';
    }
    actions.appendChild(expandBtn);

    const sourceBtn = makeMiniButton('查看源码', function () {
      const isOpen = state.sourceVisible.has(table.index);
      if (isOpen) state.sourceVisible.delete(table.index);
      else state.sourceVisible.add(table.index);
      sourceBtn.textContent = isOpen ? '查看源码' : '收起源码';
      sourcePre.hidden = isOpen;
    });
    actions.appendChild(sourceBtn);

    const copyBtn = makeMiniButton('复制', function () {
      copyTable(table, copyBtn);
    });
    actions.appendChild(copyBtn);

    const soloBtn = makeMiniButton('仅导出此表', function () {
      state.selected.clear();
      state.selected.add(table.index);
      syncCheckboxes();
      updateSelectionUI();
      doExport();
    });
    actions.appendChild(soloBtn);

    head.appendChild(checkLabel);
    head.appendChild(titleWrap);
    head.appendChild(actions);

    /* ---------- 预览区 ---------- */
    const preview = document.createElement('div');
    preview.className = 'card__preview';
    const more = document.createElement('div');
    more.className = 'card__preview-more';

    const sourcePre = document.createElement('pre');
    sourcePre.className = 'card__source';
    sourcePre.hidden = true;
    sourcePre.textContent = table.html
      ? table.html
      : '（本张表格未保留原始 HTML：' + (table.htmlDropped ? '因数据量过大被省略' : '页面未提供') + '）';

    function refreshPreview() {
      preview.innerHTML = '';
      const expanded = state.expanded.has(table.index);
      const built = buildPreviewTable(table, expanded);
      preview.appendChild(built.table);
      more.textContent = built.note || '';
      more.hidden = !built.note;
    }
    refreshPreview();

    card.appendChild(head);
    card.appendChild(preview);
    card.appendChild(more);
    card.appendChild(sourcePre);
    card.classList.toggle('is-selected', checkbox.checked);
    return card;
  }

  function metaItem(label, value) {
    const span = document.createElement('span');
    span.appendChild(document.createTextNode(label + ' '));
    const b = document.createElement('b');
    b.textContent = value;
    span.appendChild(b);
    return span;
  }

  function makeMiniButton(text, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--mini';
    btn.textContent = text;
    btn.addEventListener('click', handler);
    return btn;
  }

  /**
   * 构建预览表格
   * @param {object} table 表格对象
   * @param {boolean} expanded 是否显示全部行列
   */
  function buildPreviewTable(table, expanded) {
    const matrix = table.matrix || [];
    const colCount = matrix.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
    const maxRows = expanded ? Math.min(matrix.length, 500) : Math.min(matrix.length, LIMITS.PREVIEW_ROWS);
    const maxCols = expanded ? colCount : Math.min(colCount, LIMITS.PREVIEW_COLS);

    const domTable = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    // 表头：首列为行号，之后是列名
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'cell--index';
    corner.textContent = '#';
    headRow.appendChild(corner);
    for (let c = 0; c < maxCols; c++) {
      const th = document.createElement('th');
      const headerCell = table.headerRow ? (matrix[0] ? matrix[0][c] : '') : '';
      th.textContent = (headerCell && String(headerCell).trim())
        ? String(headerCell)
        : '列 ' + (c + 1);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);

    const startRow = table.headerRow ? 1 : 0;
    for (let r = startRow; r < maxRows; r++) {
      const tr = document.createElement('tr');
      const idxCell = document.createElement('td');
      idxCell.className = 'cell--index';
      idxCell.textContent = String(r + 1);
      tr.appendChild(idxCell);
      for (let c = 0; c < maxCols; c++) {
        const td = document.createElement('td');
        const value = matrix[r] && matrix[r][c] != null ? String(matrix[r][c]) : '';
        if (value === '') td.className = 'cell--empty';
        td.textContent = value;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    domTable.appendChild(thead);
    domTable.appendChild(tbody);

    // 说明文字：还有多少行/列被折叠
    let note = '';
    const hiddenRows = matrix.length - maxRows;
    const hiddenCols = colCount - maxCols;
    if (!expanded && (hiddenRows > 0 || hiddenCols > 0)) {
      note = '预览仅显示前 ' + maxRows + ' 行 / ' + maxCols + ' 列' +
        (hiddenRows > 0 ? '，还有 ' + hiddenRows + ' 行' : '') +
        (hiddenCols > 0 ? '，还有 ' + hiddenCols + ' 列' : '') +
        '未显示；点击「展开全部行」或直接导出即可获得完整数据。';
    } else if (expanded && hiddenRows > 0) {
      note = '为保证页面流畅，仅渲染前 500 行，导出文件仍是完整数据。';
    }
    return { table: domTable, note: note };
  }

  /* ============================ 选择与统计 ============================ */
  function syncCheckboxes() {
    Array.prototype.forEach.call(el.tableList.querySelectorAll('.card'), function (card) {
      const index = parseInt(card.dataset.index, 10);
      const box = card.querySelector('input[type="checkbox"]');
      if (box) box.checked = state.selected.has(index);
      card.classList.toggle('is-selected', state.selected.has(index));
    });
  }

  function updateSelectionUI() {
    const matched = visibleTables();
    el.counter.textContent = '已选 ' + state.selected.size + ' / ' + matched.length +
      (state.keyword ? '（筛选后）' : '');
    el.btnExport.disabled = state.selected.size === 0 || state.exporting;
    el.btnExport.textContent = state.exporting
      ? '正在导出…'
      : '导出选中（' + state.selected.size + '）';
  }

  /* ============================ 复制到剪贴板 ============================ */
  function copyTable(table, btn) {
    // 复制成 TSV，可直接粘贴进 Excel / 表格软件
    const text = (table.matrix || []).map(function (row) {
      return row.map(function (cell) {
        return String(cell == null ? '' : cell).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
      }).join('\t');
    }).join('\n');

    function done(ok) {
      const original = '复制';
      btn.textContent = ok ? '已复制 ✓' : '复制失败';
      setTimeout(function () { btn.textContent = original; }, 1600);
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        return;
      }
    } catch (e) { /* 走兜底方案 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch (e) {
      done(false);
    }
  }

  /* ============================ 导出 ============================ */
  function doExport() {
    if (state.exporting) return;
    const indexes = Array.from(state.selected).sort(function (a, b) { return a - b; });
    if (!indexes.length) {
      showToast('请先勾选要导出的表格', 'error');
      return;
    }

    const format = el.formatSelect.value;
    const mode = el.modeSelect.value;
    const useTitle = el.titlePrefix.checked;

    savePrefs({ format: format, mode: mode, titlePrefix: useTitle });

    setExporting(true);
    setStatus('正在生成文件…', 'busy');
    setProgress(0, indexes.length);

    const request = {
      type: MSG.EXPORT,
      payloadId: state.payloadId,
      indexes: indexes,
      format: format,
      mode: mode,
      usePageTitleInFilename: useTitle
    };

    sendMessage(request)
      .then(function (res) {
        if (res && res.ok) return res;
        // 后台缓存被清理时，把表格数据内联再试一次
        const inlineTables = state.payload.tables.filter(function (t) {
          return indexes.indexOf(t.index) !== -1;
        });
        return sendMessage(Object.assign({}, request, {
          payloadId: null,
          tables: inlineTables,
          pageTitle: state.payload.pageTitle
        }));
      })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || '导出失败');
        if (res.failed) {
          const firstError = (res.files || []).filter(function (f) { return !f.ok; })[0];
          setStatus('导出完成：成功 ' + res.success + ' 个，失败 ' + res.failed + ' 个' +
            (firstError ? '（' + firstError.error + '）' : ''), 'error');
          showToast('有 ' + res.failed + ' 个文件下载失败，请检查浏览器下载权限', 'error', 5000);
        } else {
          setStatus('导出完成：本次成功下载 ' + res.success + ' 个文件，已保存到浏览器默认下载目录', 'ok');
          showToast('已导出 ' + res.success + ' 个文件到默认下载目录', 'success');
        }
      })
      .catch(function (err) {
        setStatus('导出失败：' + ((err && err.message) || err), 'error');
        showToast('导出失败：' + ((err && err.message) || err), 'error', 5000);
      })
      .then(function () {
        setExporting(false);
        setProgress(0, 0);
      });
  }

  /* ============================ 导出进度推送 ============================ */
  function listenProgress() {
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== MSG.EXPORT_PROGRESS) return;
      if (message.stage === 'start') {
        setStatus(message.message || '开始导出…', 'busy');
        setProgress(0, message.total);
      } else if (message.stage === 'progress') {
        setStatus(message.message || '', 'busy');
        setProgress(message.done, message.total);
      } else if (message.stage === 'done') {
        setProgress(message.total, message.total);
        setTimeout(function () { setProgress(0, 0); }, 1200);
      }
    });
  }

  /* ============================ 偏好设置 ============================ */
  function loadPrefs() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get({
          settings: TGU.DEFAULT_SETTINGS,
          galleryPrefs: null
        }, function (items) {
          const saved = items && items.galleryPrefs;
          if (saved) {
            state.prefs.format = TGU.FORMATS[saved.format] ? saved.format : 'csv';
            state.prefs.mode = saved.mode === 'merged' ? 'merged' : 'separate';
            state.prefs.titlePrefix = saved.titlePrefix === true;
          } else if (items && items.settings) {
            // 首次使用：跟随扩展设置里的「文件名带网页标题前缀」
            state.prefs.titlePrefix = TGU.mergeSettings(items.settings).usePageTitleInFilename;
          }
          el.formatSelect.value = state.prefs.format;
          el.modeSelect.value = state.prefs.mode;
          el.titlePrefix.checked = state.prefs.titlePrefix;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  function savePrefs(prefs) {
    state.prefs = Object.assign({}, state.prefs, prefs);
    try {
      chrome.storage.local.set({
        galleryPrefs: {
          format: state.prefs.format,
          mode: state.prefs.mode,
          titlePrefix: state.prefs.titlePrefix
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ============================ 事件绑定 ============================ */
  function bindEvents() {
    el.searchInput.addEventListener('input', function () {
      state.keyword = el.searchInput.value;
      renderList(true);
      updateSelectionUI();
    });

    el.btnSelectAll.addEventListener('click', function () {
      visibleTables().forEach(function (t) { state.selected.add(t.index); });
      syncCheckboxes();
      updateSelectionUI();
    });

    el.btnInvert.addEventListener('click', function () {
      visibleTables().forEach(function (t) {
        if (state.selected.has(t.index)) state.selected.delete(t.index);
        else state.selected.add(t.index);
      });
      syncCheckboxes();
      updateSelectionUI();
    });

    el.btnClear.addEventListener('click', function () {
      state.selected.clear();
      syncCheckboxes();
      updateSelectionUI();
    });

    el.btnExport.addEventListener('click', doExport);

    el.formatSelect.addEventListener('change', function () {
      savePrefs({ format: el.formatSelect.value });
      setStatus('导出格式已切换为：' + el.formatSelect.options[el.formatSelect.selectedIndex].text, null);
    });

    el.modeSelect.addEventListener('change', function () {
      savePrefs({ mode: el.modeSelect.value });
      setStatus(el.modeSelect.value === 'merged' ? '已切换为：全部表格合并成一个文件' : '已切换为：每个表格单独文件', null);
    });

    el.titlePrefix.addEventListener('change', function () {
      savePrefs({ titlePrefix: el.titlePrefix.checked });
    });

    el.btnRescan.addEventListener('click', rescan);
    el.btnEmptyRescan.addEventListener('click', rescan);
    el.btnOpenSource.addEventListener('click', openSource);
    el.btnOptions.addEventListener('click', function () {
      try { chrome.runtime.openOptionsPage(); } catch (e) { showToast('无法打开设置页', 'error'); }
    });
    el.btnOpenFolder.addEventListener('click', function () {
      try { chrome.downloads.showDefaultFolder(); } catch (e) { showToast('无法打开下载目录', 'error'); }
    });

    // 列表区域键盘快捷键：Ctrl/Cmd + A 全选当前筛选结果
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' &&
        document.activeElement !== el.searchInput) {
        e.preventDefault();
        el.btnSelectAll.click();
      }
    });
  }

  function rescan() {
    const tabId = state.payload ? state.payload.tabId : null;
    if (tabId == null) {
      showToast('没有来源网页信息，请回到网页重新点击「提取表格」', 'error');
      return;
    }
    setStatus('正在重新扫描来源网页…', 'busy');
    sendMessage({ type: MSG.RESCAN_TAB, tabId: tabId })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || '重新提取失败');
        setStatus('已向来源网页发起扫描，稍后本页会自动刷新数据', 'ok');
      })
      .catch(function (err) {
        setStatus('重新提取失败：' + ((err && err.message) || err), 'error');
        showToast('重新提取失败：' + ((err && err.message) || err) +
          '（来源网页可能已关闭，可点击「回到原网页」确认）', 'error', 5000);
      });
  }

  function openSource() {
    const p = state.payload;
    if (!p) return;
    if (p.tabId != null) {
      chrome.tabs.get(p.tabId, function (tab) {
        if (!chrome.runtime.lastError && tab) {
          chrome.tabs.update(p.tabId, { active: true });
        } else {
          chrome.tabs.create({ url: p.sourceUrl });
        }
      });
    } else if (p.sourceUrl) {
      chrome.tabs.create({ url: p.sourceUrl });
    }
  }

  boot();
})();
