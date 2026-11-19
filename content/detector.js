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

  /** 找到真正在用的 <video>（可能有多个，取有 duration 且最像播放器的） */
  Detector.pickVideo = function () {
    let videos = Array.prototype.slice.call(document.querySelectorAll('video'));
    // 优先取有有效 duration 的
    let v = videos.find(function (el) { return el.duration > 0 && isFinite(el.duration); });
    if (v) return v;
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
