/* =========================================================================
 * tracker.js —— 播放心跳与观看进度累计（注入在页面上下文）
 * 核心：按"视频内容进度"累计（currentTime 的增量），而非真实墙钟秒数。
 *  - 3 倍速播 1 秒真实时间 = 记 3 秒内容进度；0.5 倍速播 1 秒 = 记 0.5 秒
 *  - 暂停/缓冲/切后台 不产生 currentTime 增量，自然不计时
 *  - 拖动/跳转不算进度（先被判为 seek 丢弃），防"拖到结尾秒通关"
 * 依赖 core.js、detector.js。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;
  const Detector = BiliLib.Detector;

  const TICK_MS = 1000;      // 心跳间隔
  const SEEK_TOL = 2;        // 拖动判定容差（秒）
  const FLUSH_AT = 10;       // 累计 ~10 秒上报一次

  const Tracker = {};

  let currentMeta = null;    // 当前分P元信息
  let anchor = null;         // { t, cur, rate } 播放锚点
  let buffer = newBuffer();  // 当前分P的累计缓冲
  let isBuffering = false;   // 播放器缓冲中
  let timer = null;

  function newBuffer() {
    return { seconds: 0, maxPosition: 0, lessonKey: null, meta: null };
  }

  /** 结算当前分P缓冲并上报 */
  function flush(reason) {
    if (!buffer || buffer.seconds < 0.5) { resetBuffer(); return; }
    const payload = {
      seconds: buffer.seconds,
      maxPosition: buffer.maxPosition,
      meta: buffer.meta
    };
    BiliLib.log('flush', reason || '', payload.seconds.toFixed(1) + 's', 'maxPos=' + payload.maxPosition.toFixed(0));
    try {
      chrome.runtime.sendMessage({ type: BiliLib.MSG.REPORT_WATCH, payload: payload }, function () {
        // 忽略响应（SW 可能重启）
        if (chrome.runtime.lastError) { /* noop */ }
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
    anchor = null;
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
      anchor = null;
      return;
    }
    // 每轮重新取 video，播放器 DOM 被替换也能跟上
    const video = Detector.pickVideo();
    if (video) {
      // 维护缓冲标志（用事件更准，这里做兜底同步）
      // 若 meta 变化（如分P切了但路由监听没抓到），自动切换
      const fresh = Detector.getLessonMeta();
      if (fresh.key && currentMeta && fresh.key !== currentMeta.key) {
        Tracker.onLessonChange(fresh);
      } else if (!currentMeta && fresh.key) {
        currentMeta = fresh;
        resetBuffer();
      }
    }

    const v = Detector.pickVideo();
    if (!v || !Detector.isPlaying(v) || isBuffering) {
      anchor = null;
      return;
    }

    // 同步时长到 meta（视频元数据可能延迟加载）
    if (currentMeta && (!currentMeta.duration || currentMeta.duration <= 0) && v.duration > 0) {
      currentMeta.duration = v.duration;
    }

    const now = performance.now();
    const cur = v.currentTime;
    const rate = v.playbackRate || 1;

    if (!anchor) {
      anchor = { t: now, cur: cur, rate: rate };
      return;
    }

    const wall = (now - anchor.t) / 1000;          // 真实经过秒数
    const step = cur - anchor.cur;                 // 视频时间增量（已含倍速）
    const expected = wall * rate;                  // 正常应增量
    const isSeek = step < -0.5 || Math.abs(step - expected) > (SEEK_TOL + wall * 0.5);

    if (!isSeek && wall > 0 && wall < 3 && step > 0) {
      // 【进度口径】直接累加视频时间增量：3 倍速 1 秒真实时间 = 3 秒内容进度。
      // 上限用 expected + 1.5 兜底，防止个别播放器瞬间跳帧把数字冲高。
      const gained = Math.min(step, expected + 1.5);
      buffer.seconds += gained;
      // maxPosition：连续播放到达的最远位置（seek 已被排除，不会靠拖动拉满）
      if (cur > buffer.maxPosition && cur <= (v.duration || Infinity) + 1) {
        buffer.maxPosition = cur;
      }
      if (buffer.meta) buffer.meta.duration = v.duration || buffer.meta.duration;
      if (buffer.seconds >= FLUSH_AT) flush('threshold');
    } else if (isSeek) {
      BiliLib.log('检测到跳转/拖动，忽略本段增量', { step: step, expected: expected, wall: wall });
    }

    anchor = { t: now, cur: cur, rate: rate }; // 不论是否跳转都重设锚点
  }

  /** 启动采集 */
  Tracker.start = function () {
    if (timer) return;
    const meta = Detector.getLessonMeta();
    currentMeta = meta;
    resetBuffer();
    BiliLib.log('采集启动', meta.key || '(无bvid)', meta.title);

    timer = setInterval(tick, TICK_MS);

    // 监听播放器缓冲 / 播放结束
    document.addEventListener('playing', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') { isBuffering = false; anchor = null; }
    }, true);
    document.addEventListener('waiting', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') { isBuffering = true; anchor = null; }
    }, true);
    document.addEventListener('ended', function (e) {
      if (e.target && e.target.tagName === 'VIDEO') {
        // 看到结尾：把 maxPosition 拉满并结算
        if (buffer.meta && vDuration(e.target)) buffer.maxPosition = vDuration(e.target);
        flush('ended');
      }
    }, true);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { anchor = null; flush('hidden'); }
      else anchor = null;
    });
    window.addEventListener('pagehide', function () { flush('pagehide'); });

    // 路由/分P切换
    Detector.watchRoute(function (meta) {
      Tracker.onLessonChange(meta);
    });
  };

  function vDuration(v) {
    return v && isFinite(v.duration) ? v.duration : 0;
  }

  BiliLib.Tracker = Tracker;
})();
