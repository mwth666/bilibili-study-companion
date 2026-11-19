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

  getAll().then(render);

  $('openOptions').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });
})();
