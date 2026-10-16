/**
 * TableGrab 表格抓取 —— 设置页逻辑
 * ---------------------------------------------------------------------------
 * 读写 chrome.storage.local 中的 settings；所有改动即时保存并即时生效
 * （内容脚本通过 chrome.storage.onChanged 监听，无需刷新页面）。
 */
(function () {
  'use strict';

  const TGU = globalThis.TGU;
  const MSG = TGU.MSG;

  const el = {};
  let toastTimer = null;
  let saveTimer = null;

  const FIELD_IDS = [
    'showFloatingButton', 'minRows', 'minCols',
    'filterLayoutTables', 'skipHiddenTables', 'usePageTitleInFilename'
  ];

  function $(id) { return document.getElementById(id); }

  function showToast(text, type, duration) {
    const toast = $('toast');
    toast.textContent = text;
    toast.className = 'toast is-visible' + (type ? ' is-' + type : '');
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.hidden = true;
      toast.className = 'toast';
    }, duration || 2000);
  }

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

  /** 把设置写进表单 */
  function fillForm(settings) {
    const s = TGU.mergeSettings(settings);
    FIELD_IDS.forEach(function (id) {
      el[id] = el[id] || $(id);
    });
    el.showFloatingButton.checked = s.showFloatingButton;
    el.minRows.value = s.minRows;
    el.minCols.value = s.minCols;
    el.filterLayoutTables.checked = s.filterLayoutTables;
    el.skipHiddenTables.checked = s.skipHiddenTables;
    el.usePageTitleInFilename.checked = s.usePageTitleInFilename;
  }

  /** 从表单读出设置 */
  function readForm() {
    return TGU.mergeSettings({
      showFloatingButton: el.showFloatingButton.checked,
      minRows: el.minRows.value,
      minCols: el.minCols.value,
      filterLayoutTables: el.filterLayoutTables.checked,
      skipHiddenTables: el.skipHiddenTables.checked,
      usePageTitleInFilename: el.usePageTitleInFilename.checked
    });
  }

  function loadSettings() {
    return new Promise(function (resolve) {
      chrome.storage.local.get({ settings: TGU.DEFAULT_SETTINGS }, function (items) {
        resolve(TGU.mergeSettings(items && items.settings));
      });
    });
  }

  /** 保存（带去抖，输入数字时不会每敲一下都写一次） */
  function queueSave(message) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      const settings = readForm();
      chrome.storage.local.set({ settings: settings }, function () {
        fillForm(settings); // 把越界数值纠正回合法范围后再回填
        if (chrome.runtime.lastError) {
          showToast('保存失败：' + chrome.runtime.lastError.message, 'error', 3500);
          return;
        }
        showToast(message || '设置已保存并立即生效', 'success');
      });
    }, 180);
  }

  /* ============================ 事件绑定 ============================ */
  function bindEvents() {
    FIELD_IDS.forEach(function (id) {
      const node = el[id] || $(id);
      if (!node) return;
      node.addEventListener('change', function () { queueSave(); });
      if (node.type === 'number') {
        node.addEventListener('input', function () { queueSave(); });
      }
    });

    $('btnReset').addEventListener('click', function () {
      fillForm(TGU.DEFAULT_SETTINGS);
      queueSave('已恢复默认设置');
    });

    $('btnOpenGallery').addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('table-gallery.html') });
    });

    $('btnTestScan').addEventListener('click', testScan);
  }

  /* ============================ 自检试扫 ============================ */
  function testScan() {
    const result = $('testResult');
    result.className = 'test-result';
    result.textContent = '正在试扫最近浏览的网页…';

    sendMessage({ type: MSG.TEST_SCAN })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || '试扫失败');
        result.className = 'test-result is-ok';
        result.textContent = '「' + (res.title || '最近浏览的网页').slice(0, 40) + '」' +
          '共发现 ' + res.total + ' 个 <table>，其中 ' + res.valid + ' 个通过当前过滤规则，' +
          '被过滤 ' + res.skipped + ' 个' + (res.hidden ? '（隐藏表格 ' + res.hidden + ' 个）' : '') + '。';
        if (res.valid === 0) {
          result.className = 'test-result is-error';
          result.textContent += ' 没有表格通过过滤，可尝试把「最小有效行数 / 列数」调小。';
        }
      })
      .catch(function (err) {
        result.className = 'test-result is-error';
        result.textContent = '试扫失败：' + ((err && err.message) || err) +
          '（请先在浏览器里打开一个普通网页）';
      });
  }

  /* ============================ 初始化 ============================ */
  function init() {
    FIELD_IDS.forEach(function (id) { el[id] = $(id); });
    bindEvents();

    if (new URLSearchParams(location.search).get('welcome') === '1') {
      $('welcome').hidden = false;
    }

    loadSettings().then(fillForm);
  }

  init();
})();
