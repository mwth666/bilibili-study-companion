/* =========================================================================
 * core.js —— 公共常量与工具（在页面 / SW / popup / options 间共享）
 * 挂载到全局 window.BiliLib（在 SW 中则是 globalThis.BiliLib），不依赖打包。
 *
 * 【B站改版时主要改这里】SELECTORS 配置表集中了所有 DOM 选择器。
 * 采集主路径依赖 <video> 元素属性（最稳），DOM 选择器只作兜底。
 * ========================================================================= */
(function (root) {
  'use strict';

  const BiliLib = root.BiliLib || (root.BiliLib = {});

  /* ---------- 存储 key ---------- */
  BiliLib.KEYS = {
    DAILY: 'bili_daily',       // { 'YYYY-MM-DD': { seconds, lessonKeys:[], updatedAt } }
    LESSONS: 'bili_lessons',   // { 'BVxxx:p1': { ... } }
    COURSES: 'bili_courses',   // { 'BVxxx': { ... } }
    CHECKINS: 'bili_checkins', // { 'YYYY-MM-DD': true }
    STREAK: 'bili_streak',     // { current, longest, lastCheckinDate }
    BADGES: 'bili_badges',     // { streak7: ts, day2h: ts, courseComplete:[bvid,...] }
    SETTINGS: 'bili_settings'  // { checkinThresholdSeconds, weekStartsOn, enabled }
  };

  BiliLib.DEFAULT_SETTINGS = {
    checkinThresholdSeconds: 60, // 当日有效观看 >= 60 秒算打卡
    weekStartsOn: 1,             // 1 = 周一为一周起始
    enabled: true
  };

  /* ---------- 消息类型（content <-> background） ---------- */
  BiliLib.MSG = {
    REPORT_WATCH: 'BILI_REPORT_WATCH', // content -> SW：上报一段时间片
    PING: 'BILI_PING'                  // popup -> content：查询当前页面信息（可选）
  };

  BiliLib.LOG_TAG = '[BiliCompanion]';

  /* ---------- B站 DOM 选择器配置表（改版时改这里） ---------- */
  BiliLib.SELECTORS = {
    // 标题：从多个候选里取第一个非空；og:title 与 document.title 作最后兜底
    title: [
      'h1.video-title',
      '.video-title',
      '#viewbox_report h1',
      '.bpx-player-title',
      'meta[property="og:title"]'
    ],
    // 课程名（分P所属合集/课程名），取不到就用视频标题
    courseTitle: [
      '.video-title-nav .title',
      '.upp-card .user-name',
      '.bpx-player-video-info .title'
    ],
    // 分P总数（"分P列表"项），取不到用已见最大 p
    partItems: [
      '.list-item',
      '.bpx-player-playlist-item',
      '.video-pod__list .item'
    ],
    // 分P的 cid 数据属性（不同版本属性名不同）
    cidAttrs: ['data-cid', 'data-id', 'data-part-id']
  };

  /* ---------- 徽章定义（供 stats 与 UI 共用） ---------- */
  BiliLib.BADGE_DEFS = [
    { key: 'streak7',        name: '坚持不懈',   desc: '连续打卡 7 天',        icon: '🔥' },
    { key: 'day2h',          name: '沉浸学习',   desc: '单日观看满 2 小时',    icon: '⏱️' },
    { key: 'courseComplete', name: '学有所成',   desc: '完整看完一门课程',     icon: '🎓' },
    { key: 'total10h',       name: '积水成渊',   desc: '累计观看满 10 小时',   icon: '🌊' },
    { key: 'parts30',        name: '积少成多',   desc: '累计看完 30 节课',     icon: '🧩' }
  ];

  /* ======================= 工具函数 ======================= */

  /** 本地时区的日期 key（绝不能用 toISOString，那是 UTC，会差一天） */
  BiliLib.dayKey = function (ts) {
    const d = ts == null ? new Date() : new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  /** 取 YYYY-MM 前缀 */
  BiliLib.monthKey = function (ts) {
    return BiliLib.dayKey(ts).slice(0, 7);
  };

  /** 把 'YYYY-MM-DD' 解析为本地 Date（避免 new Date('YYYY-MM-DD') 被当 UTC） */
  BiliLib.parseDayKey = function (key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  /** 在日期上加减天数，返回 'YYYY-MM-DD' */
  BiliLib.addDays = function (key, delta) {
    const d = BiliLib.parseDayKey(key);
    d.setDate(d.getDate() + delta);
    return BiliLib.dayKey(d.getTime());
  };

  /** 秒 -> '1小时23分' / '32分钟' / '45秒' */
  BiliLib.formatDuration = function (seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分钟`;
    return `${s}秒`;
  };

  /** 秒 -> '1.4h' / '32min'（用于紧凑数字卡） */
  BiliLib.formatCompact = function (seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = s / 3600;
    if (h >= 1) return h.toFixed(1) + 'h';
    const m = Math.floor(s / 60);
    if (m >= 1) return m + 'min';
    return s + 's';
  };

  /** 时间戳 -> 'YYYY-MM-DD' 短显示 */
  BiliLib.formatDate = function (ts) {
    if (!ts) return '';
    return BiliLib.dayKey(ts);
  };

  /** 从 URL 解析 bvid 与分P序号 */
  BiliLib.parseBiliUrl = function (href) {
    try {
      const url = new URL(href);
      const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      const bvid = bvidMatch ? bvidMatch[1] : null;
      const p = parseInt(url.searchParams.get('p') || '1', 10) || 1;
      return { bvid, p, key: bvid ? `${bvid}:p${p}` : null };
    } catch (e) {
      return { bvid: null, p: 1, key: null };
    }
  };

  BiliLib.log = function () {
    const args = Array.prototype.slice.call(arguments);
    try { console.log(BiliLib.LOG_TAG, ...args); } catch (e) { /* noop */ }
  };
})(typeof window !== 'undefined' ? window : globalThis);
