# TableGrab 表格抓取

把网页上的表格一次性抓下来，勾选后批量导出为 **CSV / Excel 兼容 CSV / Markdown / JSON**。

这是一个 Manifest V3 浏览器扩展（Edge / Chrome 均可加载），配套一个静态介绍站点和一套 Node 自动化测试。全部代码为原生 JavaScript，扩展运行时零第三方依赖。

---

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [使用](#使用)
- [导出格式与文件名](#导出格式与文件名)
- [设置项](#设置项)
- [目录结构](#目录结构)
- [工作原理](#工作原理)
- [消息协议](#消息协议)
- [内置上限与体积保护](#内置上限与体积保护)
- [开发与测试](#开发与测试)
- [权限说明](#权限说明)
- [常见问题](#常见问题)

---

## 功能特性

### 抓取

- **整页扫描**：一次点击扫描当前页面全部 `<table>`，过滤掉空表、装饰表、布局表后统一编号。
- **`rowspan` / `colspan` 展开**：还原成规整二维数组，跨行单元格纵向占位，跨列单元格只在起始列保留文本。
- **多行表头合并**：识别 `<thead>` 多行表头或首行全 `<th>`，把 `2024 / Q1` 这类分组表头合并成 `2024 - Q1`。
- **标题推断**：依次尝试 `<caption>` → `aria-label` / `data-title` / `data-label` / `title` → 向上最多 3 层的最近 `<h1>`–`<h6>` → 首个表头行的前若干单元格（需要至少 2 个才采用）→ 兜底 `表格 N`。
- **文本保真**：优先使用 `innerText`，超大表格退化为 DOM 遍历（同样把 `<br>` 还原为换行、块级元素两侧补换行）。纯图标单元格会退化取 `img[alt]` 或 `input[value]`，避免导出一整列空值。
- **布局表启发式过滤**：单元格里直接塞 `<div>` / `<ul>` 等块级容器且文字极少的表格会被排除，纯嵌套表格且几乎无文字的也会排除。
- **SPA 兼容**：每次点击都是实时扫描，Vue / React 动态渲染出来的表格同样能抓到；页面整块替换 `body` 时悬浮按钮会自动重新挂载。
- **重新提取**：预览页可以直接让来源标签页重扫，并复用同一个预览标签页，不会开一堆重复标签。

### 预览与导出

- **新标签页预览**：卡片列表展示每张表的行数、列数、表头识别情况、页面内定位选择器；默认全选。
- **搜索**：按标题、序号、行列数、内容关键字过滤（空格分词的 AND 匹配）。
- **预览交互**：默认只显示前 12 行 × 10 列（列表超过 40 张时分批渲染），可展开全部行、查看原表 HTML 源码。
- **复制为 TSV**：一键复制到剪贴板，可直接粘进 Excel / 表格软件。
- **仅导出此表**：单张表快捷导出，不必手动改勾选。
- **导出进度**：后台逐个下载并实时推送进度到预览页；多个文件之间停顿 320 ms，降低被浏览器判定为批量自动下载而拦截的概率。
- **偏好记忆**：格式、模式、是否带网页标题前缀会被记住。

### 入口

| 入口 | 说明 |
| --- | --- |
| 页面右下角悬浮按钮 | 默认开启，可按住拖拽移动，位置按视口比例记忆 |
| 工具栏扩展图标 | 等效于点击悬浮按钮，并在该标签页显示表格数量徽标 |
| 快捷键 `Alt+Shift+T` | 在 Chrome 中可在 `chrome://extensions/shortcuts` 自定义 |
| 预览页「重新提取」 | 回到来源网页重扫 |

---

## 安装

扩展未发布到商店，用「加载解压缩的扩展」方式安装。

### Edge

1. 打开 `edge://extensions/`。
2. 打开左下角 **开发人员模式**。
3. 点击 **加载解压缩的扩展**，选择本项目根目录（含 `manifest.json` 的那一层）。
4. 首次安装会自动打开设置页做一次引导。

### Chrome

1. 打开 `chrome://extensions/`。
2. 打开右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目根目录。

最低浏览器版本为 102（`minimum_chrome_version`）。

---

## 使用

1. 打开任意含表格的网页。
2. 点击右下角 **提取表格** 悬浮按钮，或点击工具栏图标，或按 `Alt+Shift+T`。
3. 扩展在新标签页打开预览页，列出所有通过过滤的表格，默认全选。
4. 按需取消勾选、用搜索框筛选、展开查看完整内容。
5. 选择导出格式与模式，点击 **导出选中（N）**。
6. 文件保存到浏览器默认下载目录，导出完成后可点「打开下载目录」。

---

## 导出格式与文件名

### 格式

| `format` | 扩展名 | MIME | 特点 |
| --- | --- | --- | --- |
| `csv` | `.csv` | `text/csv` | 标准 CSV，无 BOM，`LF` 换行 |
| `csv-excel` | `.csv` | `text/csv` | 带 UTF-8 BOM，`CRLF` 换行，Excel 直接双击不乱码 |
| `markdown` | `.md` | `text/markdown` | 首行作表头；转义反斜杠与竖线，换行写成 `<br>` |
| `json` | `.json` | `application/json` | 结构化的 `headers` + `records` + 原始 `matrix` |

CSV 转义规则：字段含逗号、双引号、回车或换行，或首尾有空白时用双引号包裹，内部双引号写成两个双引号。

JSON 单表结构：

```json
{
  "index": 1,
  "title": "季度销售",
  "rowCount": 13,
  "colCount": 5,
  "headerRow": true,
  "headers": ["地区", "Q1", "Q2"],
  "headersText": "地区,Q1,Q2",
  "sourceUrl": "https://example.com/report",
  "pageTitle": "季度报表",
  "capturedAt": "2026-10-16T05:23:33.000Z",
  "truncated": false,
  "records": [{ "地区": "华东", "Q1": "120" }],
  "matrix": [["地区", "Q1"], ["华东", "120"]]
}
```

表头重名会自动补序号（`金额`、`金额_1`）；没有表头时列名用 `列1`、`列2`…

### 导出模式

| `mode` | 单表文件名 | 合并文件名 |
| --- | --- | --- |
| `separate`（默认） | `page_table_20261016_001.csv` | — |
| `merged` | — | `page_table_20261016_all.csv` |

勾选「文件名带网页标题前缀」后变为 `季度报表_page_table_20261016_001.csv`。文件名会被清洗：Windows 非法字符替换为下划线，连续空白折叠，去掉首尾的 `.` / `_` / 空白，最长 100 字符。

合并模式下：Markdown 输出 `# 网页表格导出（共 N 张）` 加每张表的 `## 标题 (行 × 列)` 分节；CSV 每张表前插入一行 `【001】标题 (行 × 列)` 分节说明，Excel 打开依然可读；JSON 输出对象数组。

同名文件冲突时由 `chrome.downloads` 的 `uniquify` 策略自动改名。

---

## 设置项

设置页位于 `options.html`，改动即时保存并即时生效（内容脚本监听 `chrome.storage.onChanged`，无需刷新页面）。数字输入有 180 ms 去抖，越界值会被纠正回合法范围后回填。

| 设置项 | 默认 | 范围 / 说明 |
| --- | --- | --- |
| 显示悬浮按钮 | 开 | 关闭后页面不再注入悬浮按钮，仍可用工具栏图标和快捷键 |
| 最小有效行数 `minRows` | 2 | 1–100，少于该值视为空表 / 装饰表 |
| 最小有效列数 `minCols` | 2 | 1–100 |
| 过滤布局表格 | 开 | 关闭后不再做布局表启发式排除 |
| 跳过隐藏表格 | 关 | 默认仍提取 `display:none` 的表格，但会标记「页面中隐藏」 |
| 文件名带网页标题前缀 | 关 | 首次使用预览页会跟随此值作为默认 |

设置页还有两个工具：

- **用当前规则试扫最近浏览的网页**：只统计不导出，返回「共发现 N 个 `<table>`，其中 M 个通过过滤，被过滤 K 个（隐藏表格 J 个）」，方便调参。
- **恢复默认设置**。

预览页的格式 / 模式 / 标题前缀偏好单独存在 `chrome.storage.local` 的 `galleryPrefs` 键下，与扩展设置互不干扰。

---

## 目录结构

```
day3/
├── manifest.json            # MV3 清单：权限、内容脚本、快捷键、资源声明
├── background.js            # Service Worker：数据暂存、打开预览页、导出下载、徽标
├── content.js               # 内容脚本：悬浮按钮（Shadow DOM）、扫描并解析表格
├── content.css              # 悬浮按钮与提示气泡样式（经 web_accessible_resources 注入 Shadow DOM）
├── lib/
│   └── table-utils.js       # 公共纯逻辑库，挂载到 globalThis.TGU
├── table-gallery.html       # 预览与导出页
├── table-gallery.js
├── table-gallery.css
├── options.html             # 设置页
├── options.js
├── options.css
├── icons/
│   └── icon16|32|48|128.png # 由 dev/gen-icons.js 生成
├── docs/                    # 静态介绍站点（可直接用浏览器打开）
│   ├── index.html           # 首页
│   ├── features.html        # 功能详解
│   ├── install.html         # 安装与使用教程
│   ├── faq.html             # 常见问题与故障排查
│   ├── css/style.css
│   ├── js/main.js
│   └── assets/logo.svg, favicon.svg
└── dev/                     # 开发工具，不属于扩展运行时
    ├── run-tests.js         # 自动化测试（67 项）
    ├── test-page.html       # 手工测试页
    ├── gen-icons.js         # 用 Node 内置 zlib 生成 PNG 图标
    ├── test-output.txt      # 最近一次测试输出
    ├── package.json
    └── package-lock.json
```

`lib/table-utils.js` 同时被三处加载：内容脚本、Service Worker（`importScripts`）、Node 测试（`require` 或 `vm`）。因此该文件只允许出现无 DOM 依赖、无顶层副作用的纯函数，所有对外能力统一挂到 `globalThis.TGU`。

---

## 工作原理

```
网页 DOM
   │  content.js：扫描 <table> → 展开 rowspan/colspan → 过滤 → 组装 payload
   ▼
TG_OPEN_GALLERY（chrome.runtime.sendMessage）
   │
background.js（Service Worker）
   ├─ 暂存 payload：内存 Map（保留最近 8 份）+ chrome.storage.session 兜底 → local 兜底
   └─ 打开 table-gallery.html?id=<payloadId>，并更新来源标签页徽标
   ▼
table-gallery.js：TG_GET_PAYLOAD 取回数据 → 渲染卡片 → 勾选
   │
   │  TG_EXPORT（携带 payloadId、勾选的 index、格式、模式）
   ▼
background.js：TGU.buildExportFiles() 生成文件 → 转 base64 data URL
   │                                        → chrome.downloads.download()
   │  TG_EXPORT_PROGRESS（start / progress / done）
   ▼
table-gallery.js：更新状态条与进度条
```

几个实现细节：

- **SW 里没有 `URL.createObjectURL`**，所以文本先 `TextEncoder` 编码，再分块转 base64，拼成 `data:<mime>;charset=utf-8;base64,...` 交给下载 API。
- **数据暂存是双写的**：Service Worker 随时可能被回收，内存 Map 只是快路径，`chrome.storage.session` 是权威副本，写满或失败时降级到 `chrome.storage.local`。
- **导出兜底**：若后台已经取不到这份 payload，预览页会把勾选的表格数据内联进请求重试一次。
- **注入兜底**：触发扫描前先 `TG_PING` 探活，失败就用 `chrome.scripting.executeScript` 动态注入 `lib/table-utils.js` + `content.js`（覆盖扩展刚更新、内容脚本未注入的情况）。`content.js` 用 `__TABLEGRAB_CONTENT_LOADED__` 标志防止重复初始化。
- **悬浮按钮样式隔离**：按钮挂在一个 `all:initial` 的宿主 `<div>` 上，内部用 Shadow DOM，样式表经 `web_accessible_resources` 注入，避免被页面 CSS 污染，也不会污染页面。

---

## 消息协议

常量集中在 `lib/table-utils.js` 的 `TGU.MSG`，内容脚本、Service Worker、预览页、设置页共用。

| 常量 | 值 | 方向 | 用途 |
| --- | --- | --- | --- |
| `OPEN_GALLERY` | `TG_OPEN_GALLERY` | content → SW | 存数据并打开预览页 |
| `GET_PAYLOAD` | `TG_GET_PAYLOAD` | gallery → SW | 按 id 取回表格数据 |
| `PING` | `TG_PING` | SW → content | 探活，判断内容脚本是否已注入 |
| `SCAN_NOW` | `TG_SCAN_NOW` | SW → content | 立即扫描并打开预览页 |
| `RESCAN_TAB` | `TG_RESCAN_TAB` | gallery → SW | 让来源标签页重新扫描 |
| `EXPORT` | `TG_EXPORT` | gallery → SW | 执行导出下载 |
| `EXPORT_PROGRESS` | `TG_EXPORT_PROGRESS` | SW → gallery | 推送 `start` / `progress` / `done` 进度 |
| `GET_SETTINGS` | `TG_GET_SETTINGS` | 页面 → SW | 读取设置 |
| `SAVE_SETTINGS` | `TG_SAVE_SETTINGS` | 页面 → SW | 写入设置 |
| `TOAST` | `TG_TOAST` | SW → content | 在页面上显示提示 |
| `COUNT_TABLES` | `TG_COUNT_TABLES` | SW → content | 只统计不打开预览（设置页试扫用） |
| `TEST_SCAN` | `TG_TEST_SCAN` | options → SW | 对「最近浏览的普通网页」做一次试扫 |

设置页实际读写的是 `chrome.storage.local`，`GET_SETTINGS` / `SAVE_SETTINGS` 保留给需要走后台的场景。

---

## 内置上限与体积保护

`TGU.LIMITS`：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `MAX_ROWS_PER_TABLE` | 5000 | 单表最多保留的数据行 |
| `MAX_COLS_PER_TABLE` | 200 | 单表最多保留的数据列 |
| `MAX_HTML_CHARS` | 100000 | 单表原始 HTML 最多保留字符数 |
| `MAX_PAYLOAD_BYTES` | 4 MB | 一次性传给后台的数据上限 |
| `PREVIEW_ROWS` | 12 | 预览默认行数 |
| `PREVIEW_COLS` | 10 | 预览默认列数 |

超过 `MAX_PAYLOAD_BYTES` 时按三级降级，保证消息通道不炸：

1. 丢弃所有表格的原始 HTML 源码；
2. 反复把行数最多的表格截断到 `max(20, 当前行数 × 60%)`（最多 40 轮）；
3. 仍然超限则从末尾开始丢弃表格。

被截断的情况会在预览页顶部提示条里说明。展开全部行时预览最多渲染 500 行，导出文件仍是完整数据。

---

## 开发与测试

扩展运行时没有任何构建步骤，改完源码直接在扩展管理页点「重新加载」即可。

### 自动化测试

测试覆盖三层：

- **A 层** —— `lib/table-utils.js` 纯逻辑：CSV 转义与还原、Markdown 补列与转义、JSON 记录去重、文件名清洗与序号补零、网格重建（`rowspan` / `colspan` / 混合）、过滤规则、字节长度。
- **B 层** —— `content.js` 真实 DOM 解析：用 jsdom 模拟网页，走 `chrome.runtime` 消息通道验证提取结果，含 SPA 动态插入、空页面、无表格点击等异常路径。
- **C 层** —— `background.js` 导出链路：用 `vm` 沙箱加载 Service Worker，验证 `buildExportFiles` → `chrome.downloads` 调用、BOM 与换行、进度广播、下载失败计入 `failed` 而不抛异常。

```bash
cd dev
npm install          # 安装 jsdom
node run-tests.js
```

最近一次结果：**通过 67 项，失败 0 项**（完整输出见 `dev/test-output.txt`）。

> Windows 控制台直接看输出可能因代码页显示成乱码，这是终端编码问题，文件内容本身是 UTF-8。想得到干净输出可以先执行 `chcp 65001`。

### 手工测试页

`dev/test-page.html` 是一个覆盖常见表格形态的手工测试页，每个用例都标注了预期结果：

标准数据表（标题取最近的 `h3`）、合并单元格（`rowspan` / `colspan` / `caption`）、特殊字符（逗号、引号、`<br>` 换行、首尾空格）、多行表头合并、只有 `<th>` 的数据行、纯图标单元格、空表、布局表、单行表（默认被 `minRows` 过滤）、隐藏表、动态插入的表格、整块替换 `body`、120 行 × 8 列大表格。

加载扩展后直接用浏览器打开它，点悬浮按钮即可逐项核对抓取与导出结果。

### 生成图标

```bash
node dev/gen-icons.js
```

不依赖第三方库，用 Node 内置 `zlib` 直接拼 PNG 字节流，输出 `icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`。

### 介绍站点

`docs/` 是纯静态页面，双击 `docs/index.html` 即可浏览；也可以直接部署到任意静态托管（GitHub Pages、Netlify 等），无需构建。

---

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击工具栏图标时获得当前标签页的临时访问权 |
| `scripting` | 内容脚本未注入时动态注入兜底 |
| `downloads` | 保存导出文件，以及「打开下载目录」 |
| `storage` | 保存设置、悬浮按钮位置、预览页偏好与临时表格数据 |
| `<all_urls>` | 需要在任意网站的页面上扫描表格和注入悬浮按钮 |

扩展不发送任何网络请求，表格数据只在本机内存与 `chrome.storage` 中流转。

---

## 常见问题

**点击后提示「当前页面不支持注入」**
浏览器内置页面（`edge://`、`chrome://`、扩展商店、`about:`）不允许注入内容脚本，换一个普通网页即可。

**提示「数据已过期」**
Service Worker 被回收且会话存储已被清理。回到目标网页重新提取一次。

**页面上的表格没被识别出来**
在设置页把「最小有效行数 / 最小列数」调小，或关闭「过滤布局表格」；也可以点「用当前规则试扫最近浏览的网页」看过滤前后的数量对比。被 `<iframe>` 承载的表格不会被提取（内容脚本只跑在顶层框架）。

**表格显示「已截断」**
超过了行 / 列上限或单次传输体积上限，导出内容按上限截断。`MAX_ROWS_PER_TABLE` 等常量在 `lib/table-utils.js` 里可以按需调大。

**导出的 CSV 在 Excel 里乱码**
改用「Excel 兼容 CSV」格式，它带 UTF-8 BOM 并使用 `CRLF` 换行。

**多个文件没有全部下载下来**
浏览器对短时间内的连续自动下载有拦截策略。扩展已内置 320 ms 间隔和 `uniquify` 重名策略；若仍被拦截，在浏览器下载设置里允许该站点多次下载，或改用「合并成一个文件」模式。

**悬浮按钮不见了**
可能被页面样式挤掉，或被设置关闭。检查设置页的「显示悬浮按钮」；仍然没有时刷新页面，按钮会自动重新挂载。
