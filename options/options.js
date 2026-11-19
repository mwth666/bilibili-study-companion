/* =========================================================================
 * options.js —— 统计详情页渲染与交互
 * 依赖 core.js / stats.js。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;
  const Stats = BiliLib.Stats;
  const K = BiliLib.KEYS;
  const $ = function (id) { return document.getElementById(id); };

  let state = { data: null, period: 'day' };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 直接用 chrome.storage 读全部，补默认值 */
  function getAll() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (res) {
        const out = {};
        Object.keys(K).forEach(function (name) {
          const k = K[name];
          let v = res && res[k] != null ? res[k] : null;
          if (v == null) {
            if (k === K.STREAK) v = { current: 0, longest: 0, lastCheckinDate: '' };
            else if (k === K.SETTINGS) v = Object.assign({}, BiliLib.DEFAULT_SETTINGS);
            else v = {};
          }
          out[k] = v;
        });
        resolve(out);
      });
    });
  }

  /* ---------- 总览卡 ---------- */
  function renderOverview(data) {
    const daily = data[K.DAILY] || {};
    const total = Object.keys(daily).reduce(function (s, k) { return s + (daily[k].seconds || 0); }, 0);
    const streak = data[K.STREAK] || Stats.computeStreak(data[K.CHECKINS]);
    const courses = Stats.courses(data);
    const doneCourses = courses.filter(function (c) { return c.totalParts >= 1 && c.completedParts >= c.totalParts; }).length;
    $('ovTotal').textContent = (total / 3600).toFixed(1);
    $('ovStreak').textContent = streak.current || 0;
    $('ovCourses').textContent = doneCourses;
    $('ovParts').textContent = Stats.totalCompletedParts(data);
    $('topStreak').textContent = streak.current || 0;
    $('topLongest').textContent = streak.longest || 0;
  }

  /* ---------- 趋势图（SVG 折线/柱） ---------- */
  function renderChart(data, period) {
    const daily = data[K.DAILY] || {};
    const res = Stats.period(data, period);
    let labels = [], values = [];

    if (period === 'day') {
      // 日视图：显示最近 7 天的时长对比（今天的在最后）
      const today = BiliLib.dayKey();
      for (let i = 6; i >= 0; i--) {
        const k = BiliLib.addDays(today, -i);
        labels.push(i === 0 ? '今天' : k.slice(5));
        values.push(daily[k] ? (daily[k].seconds || 0) : 0);
      }
    } else if (period === 'week') {
      const names = ['一', '二', '三', '四', '五', '六', '日'];
      res.keys.forEach(function (k, i) {
        labels.push(names[i]);
        values.push(daily[k] ? (daily[k].seconds || 0) : 0);
      });
    } else {
      // 月：按周分桶（每 7 天一段）
      const keys = res.keys;
      for (let i = 0; i < keys.length; i += 7) {
        const slice = keys.slice(i, i + 7);
        labels.push('第' + (Math.floor(i / 7) + 1) + '周');
        values.push(slice.reduce(function (s, k) { return s + (daily[k] ? daily[k].seconds || 0 : 0); }, 0));
      }
    }

    const total = res.seconds;
    const summaryLabel = period === 'day' ? '今日' : (period === 'week' ? '本周' : '本月');
    $('periodSummary').innerHTML =
      summaryLabel + ' <b>' + BiliLib.formatDuration(total) + '</b> · 有效 ' + res.activeDays + ' 天 · 日均 ' + BiliLib.formatCompact(res.avgSeconds);

    const svg = $('trendChart');
    const empty = $('chartEmpty');
    if (total <= 0) {
      svg.innerHTML = '';
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';

    const W = 900, H = 220, padL = 46, padR = 20, padT = 18, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxV = Math.max.apply(null, values.concat([1]));
    const n = values.length;
    const step = n > 1 ? innerW / (n - 1) : 0;

    function x(i) { return padL + (n > 1 ? i * step : innerW / 2); }
    function y(v) { return padT + innerH - (v / maxV) * innerH; }

    let html = '';
    // 网格线与刻度
    const gridN = 4;
    for (let g = 0; g <= gridN; g++) {
      const gy = padT + (innerH / gridN) * g;
      const gv = Math.round(maxV * (1 - g / gridN));
      html += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="#eef1ef" stroke-width="1"/>';
      html += '<text x="' + (padL - 8) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="#a6b0aa">' + BiliLib.formatCompact(gv) + '</text>';
    }
    // 折线
    const pts = values.map(function (v, i) { return x(i) + ',' + y(v); }).join(' ');
    if (n > 1) {
      html += '<polyline points="' + pts + '" fill="none" stroke="#23b36d" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    // 面积（简单多边形）
    const areaPts = padL + ',' + (padT + innerH) + ' ' + pts + ' ' + x(n - 1) + ',' + (padT + innerH);
    html += '<polygon points="' + areaPts + '" fill="rgba(35,179,109,.10)"/>';
    // 点与数值 + x 标签
    values.forEach(function (v, i) {
      html += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="3.5" fill="#fff" stroke="#12985a" stroke-width="2"/>';
      if (v > 0) html += '<text x="' + x(i) + '" y="' + (y(v) - 10) + '" text-anchor="middle" font-size="10" font-weight="600" fill="#12985a">' + BiliLib.formatCompact(v) + '</text>';
      html += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#84918b">' + escapeHtml(labels[i]) + '</text>';
    });
    svg.innerHTML = html;
  }

  /* ---------- 热力图 ---------- */
  function renderHeatmap(data) {
    const cells = Stats.heatmap(data, 26);
    const frag = document.createDocumentFragment();
    cells.forEach(function (c) {
      const el = document.createElement('div');
      el.className = 'heat-cell' + (c.inFuture ? ' future' : (' l' + Stats.heatLevel(c.seconds)));
      el.title = c.key + ' · ' + BiliLib.formatDuration(c.seconds);
      frag.appendChild(el);
    });
    const box = $('heatmapBig');
    box.innerHTML = '';
    box.appendChild(frag);

    // 月份标签：取每 4~5 列（周）的关键节点
    const months = [];
    let lastMonth = '';
    cells.forEach(function (c, i) {
      const mk = c.key.slice(0, 7);
      if (mk !== lastMonth) { months.push({ idx: Math.floor(i / 7), text: mk.slice(5) + '月' }); lastMonth = mk; }
    });
    const mh = $('heatmapMonths');
    mh.innerHTML = months.map(function (m) {
      return '<span style="margin-left:' + (m.idx * 17) + 'px">' + m.text + '</span>';
    }).join('');
  }

  /* ---------- 课程列表 ---------- */
  function renderCourses(data) {
    const courses = Stats.courses(data);
    const box = $('courseList');
    $('courseCount').textContent = courses.length ? ('共 ' + courses.length + ' 门') : '';
    if (!courses.length) {
      box.innerHTML = '<div class="empty-state">还没有课程记录。去 B 站看节课，进度会自动出现在这里。</div>';
      return;
    }
    box.innerHTML = courses.map(function (c) {
      const pct = Math.round(c.progress * 100);
      const parts = c.parts.map(function (p) {
        const pr = Stats.lessonProgress(p);
        const lv = pr >= 0.999 ? 4 : (pr >= 0.66 ? 3 : (pr >= 0.33 ? 2 : (pr > 0 ? 1 : 0)));
        return '<div class="part-box p' + lv + '" title="' + escapeHtml(p.title || ('第' + p.p + '讲')) + ' · ' + Math.round(pr * 100) + '%">' +
          (lv === 4 ? '✓' : p.p) + '</div>';
      }).join('');
      return '<div class="course-item">' +
        '<div class="course-top">' +
          '<div class="course-title" title="' + escapeHtml(c.title) + '">' + escapeHtml(c.title) + '</div>' +
          '<div class="course-pct">' + pct + '%</div>' +
        '</div>' +
        '<div class="course-progress"><i style="width:' + pct + '%"></i></div>' +
        '<div class="parts-grid">' + parts + '</div>' +
        '<div class="course-meta">已完成 ' + c.completedParts + ' / ' + c.totalParts + ' 节 · 累计观看 ' + BiliLib.formatDuration(c.watchedSeconds) + '</div>' +
      '</div>';
    }).join('');
  }

  /* ---------- 徽章墙 ---------- */
  function renderBadges(data) {
    const badges = data[K.BADGES] || {};
    const defs = BiliLib.BADGE_DEFS;
    let unlockedCount = 0;
    $('badgeWall').innerHTML = defs.map(function (d) {
      let unlocked = false, date = '';
      if (d.key === 'courseComplete') {
        unlocked = Array.isArray(badges.courseComplete) && badges.courseComplete.length > 0;
      } else {
        unlocked = !!badges[d.key];
        date = badges[d.key] ? BiliLib.formatDate(badges[d.key]) : '';
      }
      if (unlocked) unlockedCount++;
      return '<div class="badge' + (unlocked ? ' unlocked' : '') + '">' +
        '<div class="badge-icon">' + d.icon + '</div>' +
        '<div class="badge-name">' + d.name + '</div>' +
        '<div class="badge-desc">' + d.desc + '</div>' +
        (unlocked ? '<div class="badge-date">' + (date || '已解锁') + '</div>' : '') +
      '</div>';
    }).join('');
    $('badgeCount').textContent = '已解锁 ' + unlockedCount + ' / ' + defs.length;
  }

  function renderAll() {
    const data = state.data;
    renderOverview(data);
    renderChart(data, state.period);
    renderHeatmap(data);
    renderCourses(data);
    renderBadges(data);
  }

  /* ---------- 交互 ---------- */
  function bindEvents() {
    $('periodTabs').addEventListener('click', function (e) {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      state.period = btn.getAttribute('data-period');
      document.querySelectorAll('#periodTabs .tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
      renderChart(state.data, state.period);
    });

    $('clearBtn').addEventListener('click', function () {
      if (!window.confirm('确定清除全部观看记录吗？此操作不可恢复。')) return;
      chrome.runtime.sendMessage({ type: 'BILI_CLEAR_ALL' }, function () {
        getAll().then(function (data) { state.data = data; renderAll(); });
      });
    });
  }

  getAll().then(function (data) {
    state.data = data;
    renderAll();
    bindEvents();
  });
})();
