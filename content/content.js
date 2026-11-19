/* =========================================================================
 * content.js —— 注入 B站播放页的入口
 * 等待播放器 <video> 出现后启动采集；处理来自扩展的消息。
 * ========================================================================= */
(function () {
  'use strict';
  const BiliLib = window.BiliLib;
  if (!BiliLib || !BiliLib.Tracker) return;

  let started = false;

  function tryStart() {
    if (started) return;
    const meta = BiliLib.Detector.getLessonMeta();
    if (meta.video) {
      started = true;
      BiliLib.Tracker.start();
    }
  }

  // 页面加载完立即尝试，之后轮询等待播放器（B站播放器是异步渲染的）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }
  const waitTimer = setInterval(function () {
    if (started) { clearInterval(waitTimer); return; }
    tryStart();
  }, 1000);

  // 响应 popup 的 PING（可选：显示当前页面是否在采集）
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === BiliLib.MSG.PING) {
      sendResponse({ ok: true, started: started, meta: BiliLib.Detector.getLessonMeta() });
    }
  });
})();
