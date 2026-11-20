/* =========================================================================
 * detector.js —— B站播放页识别（注入在页面上下文）
 * 职责：找出当前视频的 bvid / 分P / 标题 / <video> 元素 / 时长。
 * 多级兜底：URL 解析 -> DOM 选择器 -> document.title。
 * 依赖 core.js（BiliLib.SELECTORS / parseBiliUrl / log）。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;

  const Detector = {};

  /** 取多个选择器里第一个匹配的文本 */
  function firstText(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      if (sel.indexOf('meta[') === 0) {
        const el = document.querySelector(sel);
        if (el && el.getAttribute('content')) return el.getAttribute('content').trim();
        continue;
      }
      const el = document.querySelector(sel);
      if (el) {
        const t = (el.textContent || '').trim();
        if (t) return t;
        const title = el.getAttribute('title');
        if (title) return title.trim();
      }
    }
    return '';
  }

  /** 元素是否真的显示在页面上（排除隐藏的小窗/预览/占位 video） */
  function isVisible(el) {
    if (!el) return false;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return true; }
    if (rect.width < 40 || rect.height < 30) return false;
    try {
      const cs = window.getComputedStyle(el);
      if (!cs) return true;
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) === 0) return false;
    } catch (e) { /* 忽略样式读取失败 */ }
    return true;
  }
  Detector.isVisible = isVisible;

  /**
   * 列出所有"可能是主播放器"的 video：时长有效 + 可见。
   * 进度口径依赖 currentTime 的增量，若误取到隐藏/静止的 video，
   * 增量恒为 0 会导致整段时间都不计时，所以这里必须做可见性过滤。
   * 若过滤后为空，退回"所有时长有效的 video"，宁可选中也不要不计。
   */
  Detector.listVideos = function () {
    const all = Array.prototype.slice.call(document.querySelectorAll('video'));
    const valid = all.filter(function (el) {
      return el && isFinite(el.duration) && el.duration > 0;
    });
    if (!valid.length) return [];
    const visible = valid.filter(isVisible);
    return visible.length ? visible : valid;
  };

  /** 找到真正在用的 <video>（可能有多个，取有 duration 且最像播放器的） */
  Detector.pickVideo = function () {
    const list = Detector.listVideos();
    if (list.length) {
      // 优先正在播放的那个
      const playing = list.find(function (el) { return !el.paused && !el.ended; });
      return playing || list[0];
    }
    const videos = Array.prototype.slice.call(document.querySelectorAll('video'));
    return videos[0] || null;
  };

  /** 从分P列表 DOM 里尝试读 cid 与分P总数 */
  function readPartInfo(selectors, cidAttrs, targetP, byP) {
    const listSelectors = BiliLib.SELECTORS.partItems || [];
    let totalParts = 0, cid = null;
    // 用 partItems 选择器找分P项
    let items = [];
    for (let i = 0; i < listSelectors.length; i++) {
      items = Array.prototype.slice.call(document.querySelectorAll(listSelectors[i]));
      if (items.length > 1) break;
    }
    totalParts = items.length || 0;
    items.forEach(function (el, idx) {
      const pNum = idx + 1;
      if (pNum === targetP) {
        for (let a = 0; a < cidAttrs.length; a++) {
          const c = el.getAttribute(cidAttrs[a]);
          if (c) { cid = parseInt(c, 10) || c; break; }
        }
      }
    });
    if (byP && !cid) cid = null;
    return { cid: cid, totalParts: totalParts };
  }

  /** 读取当前页面元信息 */
  Detector.getLessonMeta = function () {
    const parsed = BiliLib.parseBiliUrl(location.href);
    const video = Detector.pickVideo();
    let title = firstText(BiliLib.SELECTORS.title);
    if (!title) {
      // document.title 兜底：去掉 "..._哔哩哔哩_bilibili" 尾巴
      title = (document.title || '').replace(/[-_|\s].*(哔哩哔哩|bilibili).*$/i, '').trim();
    }
    let courseTitle = firstText(BiliLib.SELECTORS.courseTitle) || title;
    const part = readPartInfo(BiliLib.SELECTORS.partItems, BiliLib.SELECTORS.cidAttrs, parsed.p, false);

    let duration = 0;
    if (video && video.duration > 0 && isFinite(video.duration)) duration = video.duration;

    const meta = {
      bvid: parsed.bvid,
      p: parsed.p,
      key: parsed.key,
      cid: part.cid,
      title: title,
      courseTitle: courseTitle,
      duration: duration,
      totalParts: part.totalParts,
      video: video
    };
    return meta;
  };

  /** 是否处于"正在播放"状态 */
  Detector.isPlaying = function (video) {
    if (!video) return false;
    if (!isFinite(video.duration) || video.duration <= 0) return false;
    if (video.paused || video.ended) return false;
    if (video.readyState < 2) return false;
    return true;
  };

  /**
   * 监听 B站 SPA 路由 / 分P 切换。
   * onChange(meta) 在 URL 或标题变化时触发。
   */
  Detector.watchRoute = function (onChange) {
    let lastHref = location.href;
    let lastTitle = document.title;

    function check() {
      if (location.href !== lastHref || document.title !== lastTitle) {
        lastHref = location.href;
        lastTitle = document.title;
        BiliLib.log('路由/分P变化 ->', lastHref);
        try { onChange(Detector.getLessonMeta()); } catch (e) { BiliLib.log('onChange error', e); }
      }
    }

    // 劫持 history API（SPA 跳转通常走这里）
    ['pushState', 'replaceState'].forEach(function (name) {
      const orig = history[name];
      history[name] = function () {
        const r = orig.apply(this, arguments);
        queueMicrotask(check);
        return r;
      };
    });
    window.addEventListener('popstate', check);
    // 兜底轮询（对抗非常规跳转 / 播放器 DOM 替换）
    setInterval(check, 2000);
    BiliLib.log('路由监听已启动');
  };

  BiliLib.Detector = Detector;
})();
