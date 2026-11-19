/* =========================================================================
 * background.js —— MV3 Service Worker
 * 职责：接收 content 上报 -> 落库（daily/lessons/courses）-> 判定打卡/徽章。
 * 不在内存保存持久状态（SW 会被回收），全部读写 chrome.storage.local。
 * 依赖 core.js / store.js / stats.js（通过 importScripts 载入）。
 * ========================================================================= */
importScripts('lib/core.js', 'lib/store.js', 'lib/stats.js');

(function () {
  'use strict';
  const BiliLib = globalThis.BiliLib;
  const K = BiliLib.KEYS;
  const Store = BiliLib.Store;
  const Stats = BiliLib.Stats;

  // 多标签去重：记住最近一次上报的 tabId；同一时刻只有活跃 tab 的数据计入。
  // 该变量随 SW 生命周期存在，SW 重启后清空（可接受：重启期间短暂可能双计）。
  let activeTabId = null;

  chrome.runtime.onInstalled.addListener(function () {
    Store.ensureInit();
    BiliLib.log('安装/更新，初始化存储');
  });
  // SW 每次启动也确保 key 存在
  Store.ensureInit();

  /** 处理一次观看上报 */
  async function handleReport(payload, sender) {
    if (!payload || !payload.meta || !payload.meta.key) return;
    const meta = payload.meta;
    const seconds = Math.max(0, Number(payload.seconds) || 0);
    if (seconds <= 0) return;

    // 多标签去重：若已有活跃 tab 且不是当前，忽略（只认最后活跃的）
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId != null) {
      if (activeTabId != null && activeTabId !== tabId) {
        BiliLib.log('忽略非活跃 tab 上报', tabId, 'active=', activeTabId);
        return;
      }
      activeTabId = tabId;
    }

    const dayKey = BiliLib.dayKey();
    const lessonKey = meta.key;
    const maxPosition = Math.max(0, Number(payload.maxPosition) || 0);
    const duration = Math.max(0, Number(meta.duration) || 0);
    const completed = duration > 0 && (maxPosition / duration >= 0.95);

    // 一次性读取全部相关 key
    const d = await Store.getMany([K.DAILY, K.LESSONS, K.COURSES, K.CHECKINS, K.STREAK, K.BADGES, K.SETTINGS]);
    const daily = d[K.DAILY];
    const lessons = d[K.LESSONS];
    const courses = d[K.COURSES];
    const checkins = d[K.CHECKINS];
    const settings = d[K.SETTINGS];

    /* --- 1) 更新每日 --- */
    if (!daily[dayKey]) daily[dayKey] = { seconds: 0, lessonKeys: [], updatedAt: 0 };
    daily[dayKey].seconds = Math.round((daily[dayKey].seconds + seconds) * 10) / 10;
    if (daily[dayKey].lessonKeys.indexOf(lessonKey) === -1) daily[dayKey].lessonKeys.push(lessonKey);
    daily[dayKey].updatedAt = Date.now();

    /* --- 2) 更新分P进度 --- */
    let lesson = lessons[lessonKey];
    if (!lesson) {
      lesson = {
        bvid: meta.bvid,
        cid: meta.cid || null,
        p: meta.p || 1,
        title: meta.title || '',
        courseTitle: meta.courseTitle || meta.title || '',
        duration: duration,
        watchedSeconds: 0,
        maxPosition: 0,
        completed: false,
        completedAt: 0,
        lastWatchedAt: 0
      };
      lessons[lessonKey] = lesson;
    }
    lesson.watchedSeconds = Math.round((lesson.watchedSeconds + seconds) * 10) / 10;
    if (maxPosition > lesson.maxPosition) lesson.maxPosition = maxPosition;
    if (duration > lesson.duration) lesson.duration = duration;
    if (meta.title && meta.title !== lesson.title) lesson.title = meta.title;
    if (meta.courseTitle && meta.courseTitle !== lesson.courseTitle) lesson.courseTitle = meta.courseTitle;
    lesson.lastWatchedAt = Date.now();
    const justCompleted = completed && !lesson.completed;
    if (justCompleted) {
      lesson.completed = true;
      lesson.completedAt = Date.now();
      lesson.maxPosition = lesson.duration; // 拉满
    }

    /* --- 3) 更新课程汇总 --- */
    if (meta.bvid) {
      const course = courses[meta.bvid] || {
        bvid: meta.bvid,
        title: meta.courseTitle || meta.title || meta.bvid,
        totalParts: meta.totalParts || 0,
        completedParts: 0,
        updatedAt: 0
      };
      if (meta.totalParts && meta.totalParts > course.totalParts) course.totalParts = meta.totalParts;
      if (meta.courseTitle && meta.courseTitle !== meta.bvid) course.title = meta.courseTitle;
      // 重算该课程已完成分P数
      const prefix = meta.bvid + ':p';
      let done = 0;
      Object.keys(lessons).forEach(function (k) {
        if (k.indexOf(prefix) === 0 && lessons[k].completed) done++;
      });
      course.completedParts = done;
      course.updatedAt = Date.now();
      courses[meta.bvid] = course;
    }

    /* --- 4) 打卡判定 --- */
    const threshold = settings.checkinThresholdSeconds || 60;
    if ((daily[dayKey].seconds || 0) >= threshold && !checkins[dayKey]) {
      checkins[dayKey] = true;
      BiliLib.log('打卡成功', dayKey);
    }

    /* --- 5) 连续天数与徽章 --- */
    const fullData = Object.assign({}, d, {
      [K.DAILY]: daily, [K.LESSONS]: lessons, [K.COURSES]: courses, [K.CHECKINS]: checkins
    });
    const streak = Stats.computeStreak(checkins);
    const badges = d[K.BADGES];
    const shouldUnlock = Stats.evaluateBadges(fullData);
    shouldUnlock.forEach(function (key) {
      if (key === 'courseComplete') {
        if (!Array.isArray(badges.courseComplete)) badges.courseComplete = [];
        // 记录是哪门课触发的
        Object.keys(courses).forEach(function (bvid) {
          const c = courses[bvid];
          if (c.totalParts >= 1 && c.completedParts >= c.totalParts && badges.courseComplete.indexOf(bvid) === -1) {
            badges.courseComplete.push(bvid);
          }
        });
      } else if (!badges[key]) {
        badges[key] = Date.now();
        BiliLib.log('解锁徽章', key);
      }
    });

    /* --- 6) 一次性写回 --- */
    await Store.set(K.DAILY, daily);
    await Store.set(K.LESSONS, lessons);
    await Store.set(K.COURSES, courses);
    await Store.set(K.CHECKINS, checkins);
    await Store.set(K.STREAK, streak);
    await Store.set(K.BADGES, badges);

    if (justCompleted) BiliLib.log('完成分P', lessonKey);
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === BiliLib.MSG.REPORT_WATCH) {
      handleReport(msg.payload, sender)
        .then(function () { try { sendResponse({ ok: true }); } catch (e) {} })
        .catch(function (err) {
          BiliLib.log('handleReport error', err);
          try { sendResponse({ ok: false, error: String(err) }); } catch (e) {}
        });
      return true; // 异步响应
    }
  });

  /** 清除数据（供 options 调用，也走消息以便统一） */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'BILI_CLEAR_ALL') {
      activeTabId = null;
      Store.clearAll().then(function () { sendResponse({ ok: true }); });
      return true;
    }
  });
})();
