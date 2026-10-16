/**
 * TableGrab 表格抓取 —— Service Worker（Manifest V3 后台）
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 接收内容脚本发来的表格数据，暂存后打开预览页 table-gallery.html
 *   2. 接收预览页的导出请求，调用 lib/table-utils.js 生成文件内容
 *   3. 通过 chrome.downloads API 把文件保存到浏览器默认下载目录
 *   4. 管理工具栏图标（onClicked）、徽标数字、快捷键、默认设置初始化
 */
importScripts('lib/table-utils.js');

const TGU = self.TGU;
const MSG = TGU.MSG;

/** 内存态数据缓存：key = payload.id，取用最快；SW 被回收后由 storage 兜底 */
const payloadMemory = new Map();
const MEMORY_LIMIT = 8;
const STORAGE_PREFIX = 'tg_payload_';
/** 记录「来源标签页 → 预览页标签页」，用于「重新提取」时复用同一个预览页 */
const galleryBySourceTab = new Map();
/** 下一次 OPEN_GALLERY 需要复用哪个预览页（由 RESCAN_TAB 设置） */
const reuseOnNextOpen = new Map();

const DEFAULT_SETTINGS = TGU.DEFAULT_SETTINGS;

/* =========================================================================
 * 一、通用工具
 * ========================================================================= */

/** 毫秒级延时，避免连续触发多个下载被浏览器拦截 */
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** Uint8Array → base64（分块处理，避免超长参数导致栈溢出） */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, Array.prototype.slice.call(slice));
  }
  return btoa(binary);
}

/**
 * 文本 → data URL
 * Service Worker 里没有 URL.createObjectURL，因此用 base64 data URL 交给下载 API
 */
function textToDataURL(mime, text) {
  const bytes = new TextEncoder().encode(text);
  return 'data:' + mime + ';charset=utf-8;base64,' + bytesToBase64(bytes);
}

function safeGetStorage(area) {
  try {
    if (chrome.storage && chrome.storage[area]) return chrome.storage[area];
  } catch (e) { /* 忽略 */ }
  return null;
}

/* =========================================================================
 * 二、数据暂存（内存 + session storage 双写）
 * ========================================================================= */
async function storePayload(payload) {
  payloadMemory.set(payload.id, payload);
  if (payloadMemory.size > MEMORY_LIMIT) {
    const oldest = payloadMemory.keys().next().value;
    if (oldest && oldest !== payload.id) payloadMemory.delete(oldest);
  }

  const session = safeGetStorage('session');
  const local = safeGetStorage('local');
  const key = STORAGE_PREFIX + payload.id;
  try {
    if (session) {
      const obj = {}; obj[key] = payload;
      await session.set(obj);
      return;
    }
  } catch (e) {
    console.warn('[TableGrab] session 存储写入失败（可能超出配额），降级到 local：', e);
  }
  try {
    if (local) {
      const obj = {}; obj[key] = payload;
      await local.set(obj);
    }
  } catch (e) {
    console.warn('[TableGrab] local 存储写入失败，仅保留内存副本：', e);
  }
}

async function readPayload(id) {
  if (!id) return null;
  if (payloadMemory.has(id)) return payloadMemory.get(id);

  const key = STORAGE_PREFIX + id;
  const session = safeGetStorage('session');
  if (session) {
    try {
      const items = await session.get(key);
      if (items && items[key]) {
        payloadMemory.set(id, items[key]);
        return items[key];
      }
    } catch (e) { /* 忽略 */ }
  }
  const local = safeGetStorage('local');
  if (local) {
    try {
      const items = await local.get(key);
      if (items && items[key]) {
        payloadMemory.set(id, items[key]);
        return items[key];
      }
    } catch (e) { /* 忽略 */ }
  }
  return null;
}

/* =========================================================================
 * 三、打开预览页
 * ========================================================================= */
async function openGallery(payload, sourceTabId) {
  await storePayload(payload);
  const url = chrome.runtime.getURL('table-gallery.html') + '?id=' + encodeURIComponent(payload.id);

  // 「重新提取」场景：复用原来的预览页标签，避免开一堆重复标签
  const reuseTabId = sourceTabId != null ? reuseOnNextOpen.get(sourceTabId) : null;
  if (reuseTabId != null) {
    reuseOnNextOpen.delete(sourceTabId);
    try {
      const tab = await chrome.tabs.get(reuseTabId);
      if (tab) {
        await chrome.tabs.update(reuseTabId, { url: url, active: true });
        return { ok: true, id: payload.id, tabId: reuseTabId, reused: true, count: payload.tables.length };
      }
    } catch (e) {
      console.warn('[TableGrab] 预览页已关闭，改为新建标签页');
    }
  }

  const created = await chrome.tabs.create({ url: url, active: true });
  if (sourceTabId != null) galleryBySourceTab.set(sourceTabId, created.id);
  return { ok: true, id: payload.id, tabId: created.id, reused: false, count: payload.tables.length };
}

/* =========================================================================
 * 四、导出下载
 * ========================================================================= */
function downloadFile(file) {
  return chrome.downloads.download({
    url: textToDataURL(file.mime, file.content),
    filename: file.filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });
}

/** 向所有扩展页面广播导出进度（预览页据此更新状态条） */
function broadcastProgress(payload) {
  try {
    chrome.runtime.sendMessage(Object.assign({ type: MSG.EXPORT_PROGRESS }, payload), function () {
      // 忽略「没有接收方」产生的 lastError，避免控制台报错
      void chrome.runtime.lastError;
    });
  } catch (e) { /* 忽略 */ }
}

/**
 * 处理导出请求
 * @param {{payloadId?:string,indexes?:number[],tables?:Array,format:string,mode:string}} request
 */
async function handleExport(request) {
  let tables = [];
  let sourcePageTitle = '';

  if (request.payloadId) {
    const payload = await readPayload(request.payloadId);
    if (payload) {
      sourcePageTitle = payload.pageTitle || '';
      const wanted = Array.isArray(request.indexes) && request.indexes.length
        ? request.indexes
        : payload.tables.map(function (t) { return t.index; });
      const wantedSet = new Set(wanted.map(function (n) { return String(n); }));
      tables = payload.tables.filter(function (t) {
        return wantedSet.has(String(t.index));
      });
    }
  }
  // 兜底：预览页直接内联表格数据（例如内存与 storage 都被清理的特殊情况）
  if (!tables.length && Array.isArray(request.tables) && request.tables.length) {
    tables = request.tables;
    sourcePageTitle = request.pageTitle || '';
  }

  if (!tables.length) {
    return { ok: false, error: '没有可导出的表格，请回到预览页重新勾选' };
  }

  let prefix = '';
  if (request.usePageTitleInFilename && sourcePageTitle) {
    prefix = TGU.sanitizeFilename(sourcePageTitle, '');
  }

  const files = TGU.buildExportFiles(tables, {
    format: request.format,
    mode: request.mode,
    filenamePrefix: prefix
  });

  broadcastProgress({
    stage: 'start',
    total: files.length,
    done: 0,
    message: '开始导出 ' + files.length + ' 个文件…'
  });

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      await downloadFile(file);
      results.push({ filename: file.filename, ok: true });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      results.push({ filename: file.filename, ok: false, error: message });
      console.warn('[TableGrab] 下载失败：', file.filename, err);
    }
    broadcastProgress({
      stage: 'progress',
      total: files.length,
      done: i + 1,
      currentFile: file.filename,
      message: '已导出 ' + (i + 1) + ' / ' + files.length + '：' + file.filename
    });
    // 连续多个下载之间稍作停顿，避免被判定为批量自动下载而拦截
    if (i < files.length - 1) await delay(320);
  }

  const success = results.filter(function (r) { return r.ok; }).length;
  const failed = results.length - success;
  broadcastProgress({
    stage: 'done',
    total: files.length,
    done: files.length,
    success: success,
    failed: failed,
    message: failed
      ? '导出完成：成功 ' + success + ' 个，失败 ' + failed + ' 个'
      : '导出完成：成功下载 ' + success + ' 个文件'
  });

  return { ok: true, success: success, failed: failed, files: results };
}

/* =========================================================================
 * 五、内容脚本注入兜底（activeTab + scripting）
 * ========================================================================= */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    if (pong && pong.ok) return true;
  } catch (e) {
    // 未注入或扩展刚更新，下面走动态注入
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['lib/table-utils.js', 'content.js']
    });
    return true;
  } catch (err) {
    console.warn('[TableGrab] 无法注入内容脚本：', err);
    throw new Error('当前页面不支持注入（可能是浏览器内置页面，如 edge:// 、扩展商店等）');
  }
}

/** 触发某一标签页的扫描 */
async function triggerScan(tabId, options) {
  const opts = options || {};
  await ensureContentScript(tabId);
  if (opts.reuseGalleryTabId != null) reuseOnNextOpen.set(tabId, opts.reuseGalleryTabId);
  await chrome.tabs.sendMessage(tabId, { type: MSG.SCAN_NOW });
  return { ok: true };
}

/* =========================================================================
 * 六、消息入口
 * ========================================================================= */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return undefined;

  const sourceTabId = sender && sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case MSG.OPEN_GALLERY: {
      const payload = message.payload;
      if (!payload || !Array.isArray(payload.tables)) {
        sendResponse({ ok: false, error: '表格数据格式不正确' });
        return undefined;
      }
      if (sourceTabId != null) payload.tabId = sourceTabId;
      openGallery(payload, sourceTabId)
        .then(function (res) {
          updateBadge(sourceTabId, payload.tables.length);
          sendResponse(res);
        })
        .catch(function (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
      return true; // 异步响应
    }

    case MSG.GET_PAYLOAD: {
      readPayload(message.id)
        .then(function (payload) {
          if (!payload) {
            sendResponse({ ok: false, error: '数据已过期，请回到网页重新点击「提取表格」' });
            return;
          }
          sendResponse({ ok: true, payload: payload });
        })
        .catch(function (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
      return true;
    }

    case MSG.EXPORT: {
      handleExport(message)
        .then(sendResponse)
        .catch(function (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
      return true;
    }

    case MSG.RESCAN_TAB: {
      const targetTabId = message.tabId;
      if (targetTabId == null) {
        sendResponse({ ok: false, error: '缺少来源标签页信息' });
        return undefined;
      }
      triggerScan(targetTabId, { reuseGalleryTabId: sourceTabId })
        .then(sendResponse)
        .catch(function (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
      return true;
    }

    case MSG.TEST_SCAN: {
      // 设置页自检：对「最近浏览的普通网页」做一次只统计不导出的试扫
      if (lastPageTabId == null) {
        sendResponse({ ok: false, error: '还没有可测试的网页，请先在浏览器中打开一个普通网页' });
        return undefined;
      }
      ensureContentScript(lastPageTabId)
        .then(function () {
          return chrome.tabs.sendMessage(lastPageTabId, { type: MSG.COUNT_TABLES });
        })
        .then(function (res) {
          if (!res || !res.ok) throw new Error((res && res.error) || '试扫失败');
          sendResponse(res);
        })
        .catch(function (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        });
      return true;
    }

    case MSG.GET_SETTINGS: {
      readSettings()
        .then(function (settings) { sendResponse({ ok: true, settings: settings }); })
        .catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
      return true;
    }

    case MSG.SAVE_SETTINGS: {
      saveSettings(message.settings)
        .then(function (settings) { sendResponse({ ok: true, settings: settings }); })
        .catch(function (err) { sendResponse({ ok: false, error: String(err) }); });
      return true;
    }

    default:
      return undefined;
  }
});

/* =========================================================================
 * 七、设置读写
 * ========================================================================= */
async function readSettings() {
  const local = safeGetStorage('local');
  if (!local) return TGU.mergeSettings(null);
  try {
    const items = await local.get({ settings: DEFAULT_SETTINGS });
    return TGU.mergeSettings(items && items.settings);
  } catch (e) {
    return TGU.mergeSettings(null);
  }
}

async function saveSettings(settings) {
  const merged = TGU.mergeSettings(settings);
  const local = safeGetStorage('local');
  if (local) await local.set({ settings: merged });
  return merged;
}

/* =========================================================================
 * 八、徽标 / 工具栏图标 / 快捷键 / 生命周期
 * ========================================================================= */

/** 最近浏览过的普通网页标签页（供设置页「试扫」使用） */
let lastPageTabId = null;

function rememberPageTab(tab) {
  if (!tab || tab.id == null) return;
  const url = tab.url || tab.pendingUrl || '';
  if (/^https?:\/\//i.test(url)) lastPageTabId = tab.id;
}

chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.get(info.tabId).then(rememberPageTab).catch(function () { /* 忽略 */ });
});

function updateBadge(tabId, count) {
  if (tabId == null) return;
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    chrome.action.setBadgeText({
      tabId: tabId,
      text: count > 0 ? (count > 99 ? '99+' : String(count)) : ''
    });
  } catch (e) { /* 忽略 */ }
}

// 点击工具栏图标：等效于点击页面悬浮按钮
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  triggerScan(tab.id).catch(function (err) {
    console.warn('[TableGrab] 工具栏触发失败：', err);
  });
});

// 快捷键 Alt+Shift+T
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(function (command, tab) {
    if (command !== 'extract-tables') return;
    const tabId = tab && tab.id != null ? tab.id : null;
    if (tabId == null) return;
    triggerScan(tabId).catch(function (err) {
      console.warn('[TableGrab] 快捷键触发失败：', err);
    });
  });
}

// 页面跳转 / 刷新后清掉徽标，避免残留旧数据
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status === 'loading') updateBadge(tabId, 0);
  if (changeInfo.status === 'complete') rememberPageTab(tab);
});

// 来源标签页关闭时清理映射
chrome.tabs.onRemoved.addListener(function (tabId) {
  galleryBySourceTab.forEach(function (galleryTabId, sourceId) {
    if (galleryTabId === tabId || sourceId === tabId) galleryBySourceTab.delete(sourceId);
  });
  reuseOnNextOpen.delete(tabId);
});

// 安装 / 升级：写入默认设置，首次安装时打开设置页做引导
chrome.runtime.onInstalled.addListener(function (details) {
  chrome.storage.local.get({ settings: null }, function (items) {
    if (!items.settings) {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  } catch (e) { /* 忽略 */ }
  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') });
  }
});
