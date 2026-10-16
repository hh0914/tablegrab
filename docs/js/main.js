/* =============================================================================
 * TableGrab 官网脚本
 * 纯原生 JavaScript，无框架、无构建步骤；双击本地 HTML 即可正常运行
 * 功能：主题切换、移动端菜单、标签页、FAQ 手风琴、一键复制、滚动出现动画
 * 注意：这里不能用 type="module"（file:// 协议下会被 CORS 拦截）
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------ 工具函数 ------------------------------ */
  function $(selector, scope) {
    return (scope || document).querySelector(selector);
  }

  function $$(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* ------------------------------ 轻提示 ------------------------------ */
  let toastTimer = null;
  function showToast(text) {
    let node = $('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('is-visible'); }, 1900);
  }

  /* ------------------------------ 复制到剪贴板 ------------------------------ */
  function copyText(text, okMessage) {
    function done(ok) {
      showToast(ok ? (okMessage || '已复制到剪贴板') : '复制失败，请手动选中复制');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
      return;
    }
    fallback();

    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) {
        done(false);
      }
    }
  }

  /* ------------------------------ 主题切换 ------------------------------ */
  const THEME_KEY = 'tablegrab-docs-theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    safeSet(THEME_KEY, theme);
    const btn = $('#themeToggle');
    if (btn) {
      const dark = theme === 'dark';
      btn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
      btn.setAttribute('title', dark ? '切换到浅色模式' : '切换到深色模式');
      const sun = $('.icon-sun', btn);
      const moon = $('.icon-moon', btn);
      if (sun) sun.hidden = dark;
      if (moon) moon.hidden = !dark;
    }
  }

  function initTheme() {
    const saved = safeGet(THEME_KEY);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));

    const btn = $('#themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  /* ------------------------------ 移动端菜单 ------------------------------ */
  function initNav() {
    const toggle = $('#navToggle');
    const links = $('#navLinks');
    if (!toggle || !links) return;

    toggle.addEventListener('click', function () {
      const isHidden = links.hasAttribute('hidden');
      if (isHidden) links.removeAttribute('hidden');
      else links.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    });

    // 点击链接后收起菜单
    $$('a', links).forEach(function (a) {
      a.addEventListener('click', function () {
        if (window.innerWidth <= 760) {
          links.setAttribute('hidden', '');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    });

    // 桌面尺寸下始终展开
    window.addEventListener('resize', function () {
      if (window.innerWidth > 760) {
        links.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ------------------------------ 标签页 ------------------------------ */
  function initTabs() {
    $$('[data-tabs]').forEach(function (root) {
      const tabs = $$('.tab', root);
      const panels = $$('.tabs__panel', root);
      if (!tabs.length) return;

      function select(index) {
        tabs.forEach(function (tab, i) {
          const active = i === index;
          tab.setAttribute('aria-selected', active ? 'true' : 'false');
          tab.setAttribute('tabindex', active ? '0' : '-1');
        });
        panels.forEach(function (panel, i) {
          if (i === index) panel.removeAttribute('hidden');
          else panel.setAttribute('hidden', '');
        });
      }

      tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () { select(i); });
        tab.addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
          select(next);
          tabs[next].focus();
        });
      });
      select(0);
    });
  }

  /* ------------------------------ FAQ 手风琴 ------------------------------ */
  function initFaq() {
    $$('.faq__q').forEach(function (q) {
      q.addEventListener('click', function () {
        const expanded = q.getAttribute('aria-expanded') === 'true';
        q.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        const panel = q.nextElementSibling;
        if (panel) {
          if (expanded) panel.setAttribute('hidden', '');
          else panel.removeAttribute('hidden');
        }
      });
    });

    // 支持用 URL 锚点直接展开对应问题
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target && target.classList.contains('faq__q')) {
        target.setAttribute('aria-expanded', 'true');
        if (target.nextElementSibling) target.nextElementSibling.removeAttribute('hidden');
      }
    }
  }

  /* ------------------------------ 一键复制 ------------------------------ */
  function initCopy() {
    document.addEventListener('click', function (e) {
      const btn = e.target.closest ? e.target.closest('[data-copy]') : null;
      if (!btn) return;
      e.preventDefault();
      const text = btn.getAttribute('data-copy');
      copyText(text, btn.getAttribute('data-copy-message') || '已复制：' + text);
    });
  }

  /* ------------------------------ 滚动出现动画 ------------------------------ */
  function initReveal() {
    const items = $$('.reveal');
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    items.forEach(function (el) { observer.observe(el); });
  }

  /* ------------------------------ 数字滚动 ------------------------------ */
  function initCounters() {
    const nums = $$('[data-count]');
    if (!nums.length || !('IntersectionObserver' in window)) return;

    function animate(el) {
      const target = parseFloat(el.getAttribute('data-count'));
      const suffix = el.getAttribute('data-suffix') || '';
      const duration = 900;
      const start = performance.now();
      function step(now) {
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = target * eased;
        el.textContent = (target % 1 === 0 ? Math.round(value) : value.toFixed(1)) + suffix;
        if (progress < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        animate(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.5 });

    nums.forEach(function (el) { observer.observe(el); });
  }

  /* ------------------------------ 页面锚点高亮 ------------------------------ */
  function markActiveNav() {
    const file = location.pathname.split('/').pop() || 'index.html';
    $$('.nav__link').forEach(function (link) {
      const href = link.getAttribute('href') || '';
      const linkFile = href.split('#')[0];
      if (linkFile === file || (file === '' && linkFile === 'index.html')) {
        link.classList.add('is-active');
      }
    });
  }

  /* ------------------------------ 初始化 ------------------------------ */
  function init() {
    initTheme();
    initNav();
    initTabs();
    initFaq();
    initCopy();
    initReveal();
    initCounters();
    markActiveNav();

    // 页脚年份
    $$('[data-year]').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
