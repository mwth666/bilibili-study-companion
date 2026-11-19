/* =========================================================================
 * stats.js —— 纯函数统计层（无副作用，输入数据 -> 输出结果）
 * 供 background / popup / options 共用，保证统计口径一致。
 * 依赖 core.js（BiliLib.dayKey / parseDayKey / addDays / BADGE_DEFS）。
 * ========================================================================= */
(function (root) {
  'use strict';
  const BiliLib = root.BiliLib || (root.BiliLib = {});
  const K = BiliLib.KEYS;
  const Stats = {};

  /* ---------- 基础聚合 ---------- */

  /** 某一天的 { seconds, lessonKeys, days } */
  Stats.day = function (daily, key) {
    const d = daily[key];
    return {
      key: key,
      seconds: d ? (d.seconds || 0) : 0,
      lessonCount: d && d.lessonKeys ? d.lessonKeys.length : 0
    };
  };

  /** 本周（周一起始）的日期 key 数组 */
  Stats.weekKeys = function (anchorTs, weekStartsOn) {
    weekStartsOn = weekStartsOn || 1;
    const today = BiliLib.parseDayKey(BiliLib.dayKey(anchorTs));
    const dow = today.getDay(); // 0=周日
    let diff = (dow - weekStartsOn + 7) % 7;
    const monday = BiliLib.addDays(BiliLib.dayKey(today.getTime()), -diff);
    const keys = [];
    for (let i = 0; i < 7; i++) keys.push(BiliLib.addDays(monday, i));
    return keys;
  };

  /** 本月的日期 key 数组 */
  Stats.monthKeys = function (anchorTs) {
    const mk = BiliLib.monthKey(anchorTs);
    const [y, m] = mk.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const keys = [];
    for (let d = 1; d <= last; d++) {
      keys.push(`${mk}-${String(d).padStart(2, '0')}`);
    }
    return keys;
  };

  /** 一段日期 key 的合计秒数 */
  Stats.sumSeconds = function (daily, keys) {
    let total = 0;
    keys.forEach(function (k) {
      if (daily[k]) total += daily[k].seconds || 0;
    });
    return total;
  };

  /** 某 period（day/week/month）的汇总卡：{ seconds, keys, activeDays, avg } */
  Stats.period = function (data, period, anchorTs) {
    const daily = data[K.DAILY] || {};
    const settings = data[K.SETTINGS] || {};
    const now = anchorTs || Date.now();
    let keys;
    if (period === 'day') {
      keys = [BiliLib.dayKey(now)];
    } else if (period === 'week') {
      keys = Stats.weekKeys(now, settings.weekStartsOn);
    } else {
      keys = Stats.monthKeys(now);
    }
    const seconds = Stats.sumSeconds(daily, keys);
    let activeDays = 0;
    keys.forEach(function (k) { if (daily[k] && (daily[k].seconds || 0) > 0) activeDays++; });
    return {
      keys: keys,
      seconds: seconds,
      activeDays: activeDays,
      avgSeconds: activeDays ? Math.round(seconds / activeDays) : 0
    };
  };

  /* ---------- 连续打卡 ---------- */

  /** 由 checkins 计算 { current, longest }（当天未打卡不算断） */
  Stats.computeStreak = function (checkins) {
    checkins = checkins || {};
    const today = BiliLib.dayKey();
    // 判断从哪天开始往前数：今天打了就从今天，否则从昨天
    let cursor = checkins[today] ? today : BiliLib.addDays(today, -1);
    let current = 0;
    while (checkins[cursor]) {
      current++;
      cursor = BiliLib.addDays(cursor, -1);
    }

    // longest：按日期排序扫描最大连续段
    const days = Object.keys(checkins).filter(function (k) { return checkins[k]; }).sort();
    let longest = 0, run = 0, prev = null;
    days.forEach(function (k) {
      if (prev && BiliLib.addDays(prev, 1) === k) run++;
      else run = 1;
      if (run > longest) longest = run;
      prev = k;
    });

    return { current: current, longest: longest, lastCheckinDate: days[days.length - 1] || '' };
  };

  /* ---------- 课程完成度 ---------- */

  /** 单节进度 0~1 */
  Stats.lessonProgress = function (lesson) {
    if (!lesson || !lesson.duration) return 0;
    if (lesson.completed) return 1;
    return Math.min(1, (lesson.maxPosition || 0) / lesson.duration);
  };

  /**
   * 课程维度列表：按 bvid 分组，计算 completedParts / totalParts / 进度
   */
  Stats.courses = function (data) {
    const lessons = data[K.LESSONS] || {};
    const courses = data[K.COURSES] || {};
    const byBvid = {};
    Object.keys(lessons).forEach(function (key) {
      const l = lessons[key];
      if (!l || !l.bvid) return;
      if (!byBvid[l.bvid]) byBvid[l.bvid] = { parts: [], completed: 0, watched: 0, title: l.courseTitle || l.title || l.bvid };
      const g = byBvid[l.bvid];
      g.parts.push(l);
      if (l.completed) g.completed++;
      g.watched += l.watchedSeconds || 0;
      if (l.courseTitle && l.courseTitle !== l.bvid) g.title = l.courseTitle;
    });
    // 合并 courses 里记录的 totalParts（可能大于已见分P数）
    const out = [];
    Object.keys(byBvid).forEach(function (bvid) {
      const g = byBvid[bvid];
      const meta = courses[bvid] || {};
      const maxP = g.parts.reduce(function (m, p) { return Math.max(m, p.p || 1); }, 0);
      const totalParts = Math.max(maxP, meta.totalParts || 0, g.parts.length);
      const completedParts = g.completed;
      g.parts.sort(function (a, b) { return (a.p || 0) - (b.p || 0); });
      out.push({
        bvid: bvid,
        title: meta.title || g.title,
        totalParts: totalParts,
        completedParts: completedParts,
        progress: totalParts ? completedParts / totalParts : 0,
        watchedSeconds: g.watched,
        parts: g.parts,
        updatedAt: meta.updatedAt || 0
      });
    });
    out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return out;
  };

  /** 累计完成的分P数 */
  Stats.totalCompletedParts = function (data) {
    const lessons = data[K.LESSONS] || {};
    let n = 0;
    Object.keys(lessons).forEach(function (k) { if (lessons[k] && lessons[k].completed) n++; });
    return n;
  };

  /* ---------- 徽章判定 ---------- */

  /**
   * 返回应解锁的徽章 key 数组（不比较已有，调用方决定写入）
   */
  Stats.evaluateBadges = function (data) {
    const daily = data[K.DAILY] || {};
    const streak = data[K.STREAK] || Stats.computeStreak(data[K.CHECKINS]);
    const current = typeof streak.current === 'number' ? streak.current : Stats.computeStreak(data[K.CHECKINS]).current;
    const courses = Stats.courses(data);
    const unlocked = [];

    if (current >= 7) unlocked.push('streak7');

    const has2h = Object.keys(daily).some(function (k) { return (daily[k].seconds || 0) >= 7200; });
    if (has2h) unlocked.push('day2h');

    if (courses.some(function (c) { return c.totalParts >= 1 && c.completedParts >= c.totalParts; })) {
      unlocked.push('courseComplete');
    }

    const total = Object.keys(daily).reduce(function (s, k) { return s + (daily[k].seconds || 0); }, 0);
    if (total >= 36000) unlocked.push('total10h');
    if (Stats.totalCompletedParts(data) >= 30) unlocked.push('parts30');

    return unlocked;
  };

  /* ---------- 热力图数据 ---------- */

  /**
   * 生成热力图格子：[{ key, seconds, date, inFuture }]
   * weeks=26 : 过去 26 周；weeks=4 : 最近 4 周
   * 按列=周、行=星期（周一起始）排布，调用方用 CSS Grid column 方向渲染。
   */
  Stats.heatmap = function (data, weeks, anchorTs) {
    const daily = data[K.DAILY] || {};
    const settings = data[K.SETTINGS] || {};
    const now = anchorTs || Date.now();
    const todayKey = BiliLib.dayKey(now);
    // 本周一
    const weekKeys = Stats.weekKeys(now, settings.weekStartsOn);
    const monday = BiliLib.parseDayKey(weekKeys[0]);
    const cells = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const weekStart = new Date(monday.getTime());
      weekStart.setDate(weekStart.getDate() - w * 7);
      for (let d = 0; d < 7; d++) {
        const day = new Date(weekStart.getTime());
        day.setDate(day.getDate() + d);
        const key = BiliLib.dayKey(day.getTime());
        cells.push({
          key: key,
          seconds: daily[key] ? (daily[key].seconds || 0) : 0,
          inFuture: key > todayKey
        });
      }
    }
    return cells;
  };

  /** 热力图颜色档位：0~4 */
  Stats.heatLevel = function (seconds) {
    if (!seconds || seconds <= 0) return 0;
    if (seconds < 600) return 1;      // <10min
    if (seconds < 1800) return 2;     // <30min
    if (seconds < 3600) return 3;     // <1h
    return 4;                          // >=1h
  };

  BiliLib.Stats = Stats;
})(typeof window !== 'undefined' ? window : globalThis);
