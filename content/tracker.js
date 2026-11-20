/* =========================================================================
 * tracker.js —— 播放心跳与观看进度累计（注入在页面上下文）
 * 核心：按"视频内容进度"累计（currentTime 的增量），而非真实墙钟秒数。
 *  - 3 倍速播 1 秒真实时间 = 记 3 秒内容进度；0.5 倍速播 1 秒 = 记 0.5 秒
 *  - 暂停/缓冲/切后台 不产生 currentTime 增量，自然不计时
 *  - 拖动/跳转不算进度（先被判为 seek 丢弃），防"拖到结尾秒通关"
 *
 * 稳定性要点（v1.2）：
 *  1) 页面上可能有多个 <video>（预览、小窗、广告），逐帧比对每个元素自己的
 *     currentTime 增量，取"真正在推进"的那一个，避免锁死在静止的 video 上
 *     导致时长一直不增加。
 *  2) 若连续 8 秒所有 <video> 都不推进却又没暂停（个别播放器不更新
 *     currentTime），退回墙钟兜底，保证不会"完全不记"。
 * 依赖 core.js、detector.js。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;
  const Detector = BiliLib.Detector;

  const TICK_MS = 1000;        // 心跳间隔
  const SEEK_TOL = 2;          // 拖动判定容差（秒）
  const FLUSH_AT = 10;         // 累计 ~10 秒进度上报一次
  const MAX_GAP = 15;          // 单次心跳允许的最大真实间隔（秒）
  const STALL_LIMIT = 8;       // 多久拿不到进度就启用墙钟兜底（秒）

  const Tracker = {};

  let currentMeta = null;      // 当前分P元信息
  let buffer = newBuffer();    // 当前分P的累计缓冲
  let timer = null;

  // 每个 <video> 各自的上一次采样点，避免多播放器互相干扰
  let lastCur = new WeakMap();
  let stall = 0;               // 连续拿不到进度的秒数

  function resetAnchors() {
    // WeakMap 没有 clear()，整体换一个新实例即可
    lastCur = new WeakMap();
  }

  function newBuffer() {
    return { seconds: 0, maxPosition: 0, lessonKey: null, meta: null };
  }

  /** 结算当前分P缓冲并上报 */
  function flush(reason) {
    if (!buffer) { resetBuffer(); return; }
    const hasSeconds = buffer.seconds >= 0.5;
    const hasPosition = buffer.maxPosition > 0.5;
    // 只有"看到结尾"这类情况才可能秒数为 0 但进度有效，也要上报
    if (!hasSeconds && !hasPosition) { resetBuffer(); return; }
    const meta = buffer.meta || currentMeta;
    if (!meta || !meta.key) {
      // 拿不到课程标识就无从落库，宁可丢弃也不写脏数据
      BiliLib.log('flush 跳过：缺少课程标识（meta.key 为空）', reason || '');
      resetBuffer();
      return;
    }
    const payload = {
      seconds: Math.round(buffer.seconds * 10) / 10,
      maxPosition: buffer.maxPosition,
      meta: meta
    };
    BiliLib.log('flush', reason || '', payload.seconds.toFixed(1) + 's', 'maxPos=' + payload.maxPosition.toFixed(0));
    try {
      chrome.runtime.sendMessage({ type: BiliLib.MSG.REPORT_WATCH, payload: payload }, function () {
        if (chrome.runtime.lastError) { /* SW 可能重启，忽略 */ }
      });
    } catch (e) {
      BiliLib.log('sendMessage error', e);
    }
    resetBuffer();
  }
  Tracker.flush = flush;

  function resetBuffer() {
    const meta = currentMeta;
    buffer = newBuffer();
    buffer.meta = meta;
    buffer.lessonKey = meta ? meta.key : null;
    stall = 0;
  }

  /** 切换分P：先结算旧的，再重置 */
  Tracker.onLessonChange = function (meta) {
    flush('lesson-change');
    currentMeta = meta;
    resetBuffer();
    BiliLib.log('切换课程分P ->', meta.key, meta.title);
  };

  /** 心跳主体 */
  function tick() {
    // 后台标签不计时
    if (document.visibilityState !== 'visible') {
      resetAnchors();
      return;
    }

    // 分P变化（路由监听没抓到时的兜底）
    const fresh = Detector.getLessonMeta();
    if (fresh.key && currentMeta && fresh.key !== currentMeta.key) {
      Tracker.onLessonChange(fresh);
    } else if (!currentMeta && fresh.key) {
      currentMeta = fresh;
      resetBuffer();
    }

    const videos = Detector.listVideos();
    if (!videos.length) return;

    const now = performance.now();
    const samples = [];

    videos.forEach(function (v) {
      const prev = lastCur.get(v);
      if (!prev) return;
      const wall = (now - prev.t) / 1000;
      if (!(wall > 0)) return;
      const cur = v.currentTime;
      const step = cur - prev.cur;               // 视频时间增量（已含倍速）
      const rate = v.playbackRate || 1;
      const expected = wall * rate;              // 正常应增量
      // 拖动只会让进度"倒退"或"大幅超前"；进度偏小属于缓冲/卡顿，
      // 不能当成拖动，否则缓冲时会被反复误判。
      const isSeek = step < -0.5 || step > expected + SEEK_TOL + wall * 0.6;
      samples.push({ v: v, cur: cur, wall: wall, step: step, rate: rate, expected: expected, isSeek: isSeek });
    });

    // 不论结果如何，先把这一帧的基准全部刷新
    videos.forEach(function (v) { lastCur.set(v, { t: now, cur: v.currentTime }); });

    if (!samples.length) return; // 首帧只建基准

    // 优先"没被判定为拖动、且推进最多"的那个 video
    samples.sort(function (a, b) {
      if (a.isSeek !== b.isSeek) return a.isSeek ? 1 : -1;
      return b.step - a.step;
    });
    const best = samples[0];

    if (!best.isSeek && best.step > 0 && best.wall <= MAX_GAP) {
      // 【进度口径】直接累加视频时间增量：3 倍速 1 秒真实时间 = 3 秒内容进度。
      const gained = Math.min(best.step, best.expected + 1.5);
      buffer.seconds += gained;
      if (best.cur > buffer.maxPosition && best.cur <= (best.v.duration || Infinity) + 1) {
        buffer.maxPosition = best.cur;
      }
      const vd = best.v.duration;
      if (buffer.meta && vd > 0) buffer.meta.duration = vd;
      if (currentMeta && vd > 0) currentMeta.duration = vd;
      stall = 0;
      if (buffer.seconds >= FLUSH_AT) flush('threshold');
      return;
    }

    if (best.isSeek) {
      stall = 0;
      BiliLib.log('检测到跳转/拖动，忽略本段增量', {
        step: best.step, expected: best.expected, wall: best.wall
      });
      return;
    }

    /* ---- 没有可用的进度增量 ---- */
    // 正常播放（未暂停、数据充足）却始终不推进：累加停顿时长，超过阈值后退回墙钟
    const live = videos.find(function (v) {
      return v && !v.paused && !v.ended && v.readyState >= 2;
    });
    if (!live) { stall = 0; return; }       // 暂停/没有可播源：本来就该不计时

    stall += best.wall;
    if (stall >= STALL_LIMIT) {
      const gained = Math.min(best.wall, MAX_GAP);
      buffer.seconds += gained;
      if (buffer.meta && live.duration > 0 && !buffer.meta.duration) buffer.meta.duration = live.duration;
      BiliLib.log('播放器未上报进度，按实际时长兜底 +' + gained.toFixed(1) + 's');
      if (buffer.seconds >= FLUSH_AT) flush('threshold');
    }
  }

  /** 启动采集 */
  Tracker.start = function () {
    if (timer) return;
    const meta = Detector.getLessonMeta();
    currentMeta = meta;
    resetBuffer();
    BiliLib.log('采集启动', meta.key || '(无课程标识)', meta.title);

    timer = setInterval(tick, TICK_MS);

    // 监听播放器缓冲 / 播放结束（媒体事件不冒泡，用捕获阶段）
    document.addEventListener('playing', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') { lastCur.delete(e.target); }
    }, true);
    document.addEventListener('waiting', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') { lastCur.delete(e.target); }
    }, true);
    document.addEventListener('ended', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') {
        const v = e.target;
        const d = v && isFinite(v.duration) ? v.duration : 0;
        if (buffer.meta && d) buffer.maxPosition = d;   // 看到结尾，拉满进度
        flush('ended');
      }
    }, true);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { flush('hidden'); }
      resetAnchors();
    });
    window.addEventListener('pagehide', function () { flush('pagehide'); });

    // 路由/分P切换
    Detector.watchRoute(function (meta) {
      Tracker.onLessonChange(meta);
    });
  };

  BiliLib.Tracker = Tracker;
})();
