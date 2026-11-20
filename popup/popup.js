/* =========================================================================
 * popup.js —— 读取 storage，渲染快速看板
 * 依赖 core.js / stats.js。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;
  const Stats = BiliLib.Stats;
  const K = BiliLib.KEYS;
  const $ = function (id) { return document.getElementById(id); };

  function render(data) {
    // 连续天数
    const streak = data[K.STREAK] || Stats.computeStreak(data[K.CHECKINS]);
    $('streakNum').textContent = streak.current || 0;

    // 今日 / 本周 / 本月
    const today = Stats.period(data, 'day');
    const week = Stats.period(data, 'week');
    const month = Stats.period(data, 'month');
    $('todayVal').innerHTML = BiliLib.formatCompact(today.seconds);
    $('weekVal').innerHTML = BiliLib.formatCompact(week.seconds);
    $('monthVal').innerHTML = BiliLib.formatCompact(month.seconds);

    // 迷你热力图（最近 4 周）
    const cells = Stats.heatmap(data, 4);
    const frag = document.createDocumentFragment();
    cells.forEach(function (c) {
      const el = document.createElement('div');
      el.className = 'heat-cell' + (c.inFuture ? ' future' : (' l' + Stats.heatLevel(c.seconds)));
      el.title = c.key + ' · ' + BiliLib.formatDuration(c.seconds);
      frag.appendChild(el);
    });
    const hm = $('heatmapMini');
    hm.innerHTML = '';
    hm.appendChild(frag);

    const checkinCount = Object.keys(data[K.CHECKINS] || {}).filter(function (k) { return data[K.CHECKINS][k]; }).length;
    $('checkinHint').textContent = '累计打卡 ' + checkinCount + ' 天';

    renderLast(data[K.LAST]);

    // 最近学习课程（按 updatedAt 排）
    const courses = Stats.courses(data);
    const box = $('currentCourse');
    if (!courses.length) {
      box.innerHTML = '<div class="course-empty">还没有学习记录，去 B 站看节课吧～</div>';
      $('courseHint').textContent = '';
      return;
    }
    const c = courses[0];
    const pct = Math.round(c.progress * 100);
    box.innerHTML =
      '<div class="course-row">' +
        '<div class="course-name" title="' + escapeHtml(c.title) + '">' + escapeHtml(c.title) + '</div>' +
        '<div class="course-bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="course-meta">' +
          '<span>已完成 ' + c.completedParts + ' / ' + c.totalParts + ' 节</span>' +
          '<span>' + pct + '%</span>' +
        '</div>' +
      '</div>';
    $('courseHint').textContent = '共 ' + courses.length + ' 门';
  }

  /** 渲染"最近记录"自检行：能直接看出计时是否还在工作 */
  function renderLast(last) {
    const el = $('lastNote');
    if (!el) return;
    if (!last || !last.at) {
      el.textContent = '最近记录：暂无 · 打开一个 B 站视频播几秒试试';
      el.className = 'metric-note metric-note-sub warn';
      return;
    }
    const ago = Math.max(0, Math.round((Date.now() - last.at) / 1000));
    let when;
    if (ago < 60) when = ago + ' 秒前';
    else if (ago < 3600) when = Math.floor(ago / 60) + ' 分钟前';
    else if (ago < 86400) when = Math.floor(ago / 3600) + ' 小时前';
    else when = Math.floor(ago / 86400) + ' 天前';
    const add = last.seconds ? ' +' + (Math.round(last.seconds * 10) / 10) + 's' : '';
    el.textContent = '最近记录：' + when + add;
    el.className = 'metric-note metric-note-sub' + (ago > 600 ? ' warn' : '');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // popup 未引入 store.js，这里直接用 chrome.storage 读取
  function getAll() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (res) {
        const defaults = {};
        Object.keys(BiliLib.KEYS).forEach(function (name) { defaults[BiliLib.KEYS[name]] = null; });
        const out = {};
        Object.keys(BiliLib.KEYS).forEach(function (name) {
          const k = BiliLib.KEYS[name];
          let v = res && res[k] != null ? res[k] : null;
          if (v == null) {
            if (k === K.STREAK) v = { current: 0, longest: 0, lastCheckinDate: '' };
            else v = {};
          }
          out[k] = v;
        });
        resolve(out);
      });
    });
  }

  function refresh() {
    return getAll().then(render).catch(function (e) { console.warn('[BiliCompanion] popup render error', e); });
  }
  refresh();
  // 打开 popup 时自动跟着数据刷新，方便边看边确认时长在涨
  setInterval(refresh, 2000);

  $('openOptions').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });
})();
