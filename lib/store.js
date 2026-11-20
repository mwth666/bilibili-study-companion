/* =========================================================================
 * store.js —— chrome.storage.local 读写封装
 * 统一默认值初始化、读取、合并写入；在 SW / popup / options 中共享。
 * 依赖 core.js（BiliLib.KEYS / DEFAULT_SETTINGS）。
 * ========================================================================= */
(function (root) {
  'use strict';
  const BiliLib = root.BiliLib || (root.BiliLib = {});
  const K = BiliLib.KEYS;

  const Store = {};

  /** 返回的默认值模板（新 key 不存在时用） */
  const DEFAULTS = {
    [K.DAILY]: {},
    [K.LESSONS]: {},
    [K.COURSES]: {},
    [K.CHECKINS]: {},
    [K.STREAK]: { current: 0, longest: 0, lastCheckinDate: '' },
    [K.BADGES]: {},
    [K.SETTINGS]: Object.assign({}, BiliLib.DEFAULT_SETTINGS),
    [K.LAST]: null
  };
  Store.DEFAULTS = DEFAULTS;

  /** 读取单个 key，不存在则返回默认结构 */
  Store.get = function (key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(key, function (res) {
        const val = res && res[key] != null ? res[key] : DEFAULTS[key];
        resolve(val);
      });
    });
  };

  /** 读取多个 key，补齐默认值 */
  Store.getMany = function (keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (res) {
        const out = {};
        keys.forEach(function (k) {
          out[k] = res && res[k] != null ? res[k] : DEFAULTS[k];
        });
        resolve(out);
      });
    });
  };

  /** 读取全部（用于渲染看板） */
  Store.getAll = function () {
    return Store.getMany(Object.keys(DEFAULTS));
  };

  /** 写入（部分更新，Object.assign 语义由调用方决定） */
  Store.set = function (key, value) {
    return new Promise(function (resolve) {
      const obj = {};
      obj[key] = value;
      chrome.storage.local.set(obj, function () { resolve(); });
    });
  };

  /** 确保 7 个 key 都存在（首次安装时初始化） */
  Store.ensureInit = function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(Object.keys(DEFAULTS), function (res) {
        const toSet = {};
        Object.keys(DEFAULTS).forEach(function (k) {
          if (res[k] == null) toSet[k] = DEFAULTS[k];
        });
        const done = function () { resolve(); };
        if (Object.keys(toSet).length) chrome.storage.local.set(toSet, done);
        else done();
      });
    });
  };

  /** 清空全部数据（options 的"清除数据"按钮） */
  Store.clearAll = function () {
    return new Promise(function (resolve) {
      chrome.storage.local.clear(function () {
        Store.ensureInit().then(resolve);
      });
    });
  };

  BiliLib.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
