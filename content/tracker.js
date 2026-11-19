/* =========================================================================
 * tracker.js —— 播放心跳与有效时长累计（注入在页面上下文）
 * 核心：按"真实墙钟秒数"累计，而非 currentTime 差值。
 *  - 2倍速看30分钟视频只记15分钟真实时间（防倍速双计）
 *  - 拖动/跳转不计时长，也不计入 maxPosition（防"拖到结尾秒通关"）
 *  - 暂停/缓冲/切后台 断开锚点不计时
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
    const step = cur - anchor.cur;                 // 视频时间增量
    const expected = wall * rate;                  // 正常应增量
    const isSeek = step < -0.5 || Math.abs(step - expected) > (SEEK_TOL + wall * 0.5);

    if (!isSeek && wall > 0 && wall < 3) {
      buffer.seconds += wall;
      // maxPosition：连续播放到达的最远位置（估算当前位置，不含跳转）
      const reach = anchor.cur + expected;
      if (reach > buffer.maxPosition && reach <= (v.duration || Infinity) + 1) {
        buffer.maxPosition = reach;
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
