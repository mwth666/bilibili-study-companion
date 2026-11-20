/* =========================================================================
 * widget.js —— 播放页浮动小挂件
 * 右下角常驻一个小卡片：今日时长 / 连续天数 / 本节进度。
 *  - 可拖动（位置记住）、可折叠（折叠后只剩一个小胶囊）
 *  - 5 秒不动自动半透明，鼠标移上去恢复
 *  - 双击打开完整统计
 *  - 只在播放页显示；进全屏时自动挂到全屏元素里
 * 用 Shadow DOM 隔离，B 站的全局样式影响不到它。
 * 依赖 core.js / stats.js / detector.js。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;
  if (!BiliLib || !BiliLib.Detector || !BiliLib.Stats) return;
  const K = BiliLib.KEYS;
  const WKEY = 'bili_widget';
  const TICK_MS = 1200;
  const IDLE_MS = 5000;

  const state = {
    mounted: false,
    visible: null,
    collapsed: false,
    today: -1,
    streak: -1,
    pct: -1
  };

  let host = null;
  let root = null;
  let panel = null;
  let elToday = null;
  let elUnit = null;
  let elStreak = null;
  let elPct = null;
  let elBar = null;
  let foldBtn = null;

  let idleTimer = 0;
  let drag = null;
  let pos = null;

  /* ---------------- 工具 ---------------- */

  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    if (s >= 3600) {
      const h = s / 3600;
      return { num: h >= 10 ? String(Math.round(h)) : h.toFixed(1), unit: 'h' };
    }
    if (s >= 60) return { num: String(Math.floor(s / 60)), unit: 'min' };
    return { num: String(s), unit: 's' };
  }

  function isPlayPage() {
    const href = location.href;
    return /\/video\/BV[0-9A-Za-z]+/.test(href)
      || /\/(cheese|bangumi)\/play\//.test(href)
      || /\/list\/(watchlater|ml\d+)/.test(href);
  }

  /* ---------------- 构建 DOM ---------------- */

  const TEMPLATE = `
  <style>
    :host {
      all: initial;
      position: fixed;
      right: 18px;
      bottom: 92px;
      z-index: 2147483000;
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                   "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 152px;
      padding: 9px 12px 10px;
      border-radius: 14px;
      background: rgba(24, 24, 30, 0.8);
      -webkit-backdrop-filter: blur(12px) saturate(150%);
      backdrop-filter: blur(12px) saturate(150%);
      border: 1px solid rgba(255, 255, 255, 0.13);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34);
      color: #fff;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      transition: opacity .25s ease, background .2s ease;
    }
    .panel:active { cursor: grabbing; }
    :host(.idle) .panel { opacity: .46; }
    :host(.idle) .panel:hover { opacity: 1; }
    .row1 { display: flex; align-items: center; gap: 6px; }
    .today {
      font-size: 17px;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -.3px;
      font-variant-numeric: tabular-nums;
    }
    .today .u {
      font-size: 11px;
      font-weight: 600;
      opacity: .72;
      margin-left: 2px;
      letter-spacing: .2px;
    }
    .streak {
      margin-left: auto;
      font-size: 11px;
      font-weight: 600;
      color: #ffb56b;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .streak.zero { color: rgba(255, 255, 255, .4); }
    .fold {
      flex: none;
      width: 17px;
      height: 17px;
      margin-left: 2px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 5px;
      background: rgba(255, 255, 255, .1);
      color: rgba(255, 255, 255, .75);
      font: 600 12px/1 inherit;
      font-family: inherit;
      cursor: pointer;
    }
    .fold:hover { background: rgba(255, 255, 255, .22); color: #fff; }
    .sub {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10.5px;
      color: rgba(255, 255, 255, .64);
      font-variant-numeric: tabular-nums;
    }
    .sub .txt { flex: none; min-width: 48px; }
    .bar {
      flex: 1;
      height: 3px;
      border-radius: 2px;
      background: rgba(255, 255, 255, .16);
      overflow: hidden;
    }
    .bar i {
      display: block;
      height: 100%;
      width: 0;
      border-radius: 2px;
      background: linear-gradient(90deg, #fb7299, #ffb1c6);
      transition: width .45s cubic-bezier(.4, 0, .2, 1);
    }
    :host(.mini) .panel { min-width: 0; padding: 7px 10px; gap: 0; }
    :host(.mini) .streak, :host(.mini) .sub { display: none; }
    :host(.mini) .today { font-size: 13px; }
    :host(.mini) .fold { margin-left: 4px; }
    :host(.mini) .panel { opacity: .92; }
    :host(.mini.idle) .panel { opacity: .42; }
  </style>
  <div class="panel">
    <div class="row1">
      <span class="today">0<span class="u">min</span></span>
      <span class="streak zero">🔥 0</span>
      <button class="fold" title="收起">−</button>
    </div>
    <div class="sub">
      <span class="txt">本节 0%</span>
      <span class="bar"><i></i></span>
    </div>
  </div>`;

  function build() {
    host = document.createElement('div');
    host.id = 'bili-companion-widget';
    host.style.display = 'none';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;

    panel = root.querySelector('.panel');
    elToday = root.querySelector('.today');
    elUnit = root.querySelector('.today .u');
    elStreak = root.querySelector('.streak');
    elPct = root.querySelector('.sub .txt');
    elBar = root.querySelector('.bar i');
    foldBtn = root.querySelector('.fold');

    document.documentElement.appendChild(host);
    bind();
  }

  /* ---------------- 渲染 ---------------- */

  function paint() {
    if (!host) return;

    const f = fmt(state.today);
    if (elToday.firstChild && elToday.firstChild.nodeValue !== f.num) {
      elToday.firstChild.nodeValue = f.num;
    }
    if (elUnit.textContent !== f.unit) elUnit.textContent = f.unit;

    const st = '🔥 ' + (state.streak > 0 ? state.streak : 0);
    if (elStreak.textContent !== st) {
      elStreak.textContent = st;
      elStreak.classList.toggle('zero', state.streak <= 0);
      elStreak.title = '连续打卡 ' + (state.streak > 0 ? state.streak : 0) + ' 天';
    }

    const pctTxt = '本节 ' + state.pct + '%';
    if (elPct.textContent !== pctTxt) elPct.textContent = pctTxt;

    const w = String(state.pct);
    if (elBar.dataset.w !== w) {
      elBar.dataset.w = w;
      elBar.style.width = w + '%';
    }
  }

  /* ---------------- 数据 ---------------- */

  // 缓存在内存里：首次读一遍，之后靠 storage.onChanged 增量更新，
  // 避免每秒都去反序列化几百条课节数据。
  const cache = { daily: {}, streak: null, lessons: {} };

  function applyCache() {
    const todayKey = BiliLib.dayKey();
    state.today = (cache.daily[todayKey] && cache.daily[todayKey].seconds) || 0;
    state.streak = (cache.streak && cache.streak.current) || 0;
  }

  function computePct() {
    const v = BiliLib.Detector.pickVideo();
    if (!v || !isFinite(v.duration) || v.duration <= 0) return 0;
    const meta = BiliLib.Detector.getLessonMeta();
    const lesson = meta && meta.key ? cache.lessons[meta.key] : null;
    const best = Math.max(v.currentTime || 0, lesson ? (lesson.maxPosition || 0) : 0);
    return Math.round(Math.min(1, best / v.duration) * 100);
  }

  function loadOnce() {
    chrome.storage.local.get([K.DAILY, K.STREAK, K.LESSONS], function (res) {
      if (chrome.runtime.lastError) return;
      cache.daily = res[K.DAILY] || {};
      cache.streak = res[K.STREAK] || null;
      cache.lessons = res[K.LESSONS] || {};
      applyCache();
      state.pct = computePct();
      paint();
    });
  }

  function watchStorage() {
    if (!chrome.storage || !chrome.storage.onChanged) return;
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      let dirty = false;
      if (changes[K.DAILY]) { cache.daily = changes[K.DAILY].newValue || {}; dirty = true; }
      if (changes[K.STREAK]) { cache.streak = changes[K.STREAK].newValue || null; dirty = true; }
      if (changes[K.LESSONS]) { cache.lessons = changes[K.LESSONS].newValue || {}; dirty = true; }
      if (!dirty) return;
      applyCache();
      paint();
    });
  }

  function updateVisibility() {
    if (!host) return;
    const show = isPlayPage() && !!BiliLib.Detector.pickVideo();
    if (state.visible === show) return;
    state.visible = show;
    host.style.display = show ? 'block' : 'none';
    if (show) markIdle();
  }

  function tick() {
    updateVisibility();
    if (!state.visible) return;
    state.pct = computePct();
    paint();
  }

  /* ---------------- 位置 / 折叠 ---------------- */

  function clampPos(x, y) {
    const w = host.offsetWidth || 160;
    const h = host.offsetHeight || 56;
    const maxX = Math.max(4, window.innerWidth - w - 6);
    const maxY = Math.max(4, window.innerHeight - h - 6);
    return { x: Math.min(Math.max(6, x), maxX), y: Math.min(Math.max(6, y), maxY) };
  }

  function setPos(x, y) {
    const p = clampPos(x, y);
    pos = p;
    host.style.left = p.x + 'px';
    host.style.top = p.y + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  }

  function saveState() {
    const val = { collapsed: state.collapsed };
    if (pos) { val.x = Math.round(pos.x); val.y = Math.round(pos.y); }
    const obj = {};
    obj[WKEY] = val;
    chrome.storage.local.set(obj);
  }

  function restore() {
    chrome.storage.local.get(WKEY, function (res) {
      const s = res && res[WKEY];
      if (!s) return;
      if (s.collapsed) {
        state.collapsed = true;
        applyCollapsed();
      }
      if (typeof s.x === 'number' && typeof s.y === 'number') {
        // 等一帧再定位，此时挂件已可见、能量到真实尺寸
        requestAnimationFrame(function () { if (host) setPos(s.x, s.y); });
      }
    });
  }

  function applyCollapsed() {
    if (!host) return;
    host.classList.toggle('mini', state.collapsed);
    foldBtn.textContent = state.collapsed ? '+' : '−';
    foldBtn.title = state.collapsed ? '展开' : '收起';
    if (pos) {
      requestAnimationFrame(function () { if (pos) setPos(pos.x, pos.y); });
    }
  }

  function markIdle() {
    if (!host) return;
    host.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (host) host.classList.add('idle');
    }, IDLE_MS);
  }

  /* ---------------- 交互 ---------------- */

  function bind() {
    panel.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.fold')) return;
      const rect = host.getBoundingClientRect();
      drag = {
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
        sx: e.clientX,
        sy: e.clientY,
        moved: false
      };
      try { panel.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      e.preventDefault();
    });

    panel.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.moved &&
          Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) {
        drag.moved = true;
      }
      if (drag.moved) setPos(e.clientX - drag.dx, e.clientY - drag.dy);
    });

    panel.addEventListener('pointerup', function (e) {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      try { panel.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      if (moved) { saveState(); markIdle(); }
    });

    panel.addEventListener('pointercancel', function () { drag = null; });

    panel.addEventListener('dblclick', function () {
      try { chrome.runtime.openOptionsPage(); } catch (e) { /* noop */ }
    });

    foldBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    foldBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      state.collapsed = !state.collapsed;
      applyCollapsed();
      saveState();
    });

    host.addEventListener('pointerenter', markIdle);
    host.addEventListener('pointermove', markIdle);

    window.addEventListener('resize', function () {
      if (pos) setPos(pos.x, pos.y);
    });

    // 全屏时把挂件挂进全屏元素，否则会看不见
    const attach = function () {
      const target = document.fullscreenElement || document.webkitFullscreenElement;
      const parent = target || document.documentElement;
      if (host && parent && host.parentNode !== parent) {
        try { parent.appendChild(host); } catch (e) { /* noop */ }
      }
    };
    document.addEventListener('fullscreenchange', attach);
    document.addEventListener('webkitfullscreenchange', attach);
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    if (state.mounted) return;
    if (!isPlayPage()) return;
    if (!document.querySelector('video')) return;
    state.mounted = true;
    build();
    updateVisibility();   // 先显示，才能量到真实宽高
    restore();
    loadOnce();
    watchStorage();
    tick();
    setInterval(tick, TICK_MS);
  }

  // 播放器是异步渲染的，轮询等待；SPA 从别的页面跳进播放页也能启动
  boot();
  setInterval(boot, 800);
})();
