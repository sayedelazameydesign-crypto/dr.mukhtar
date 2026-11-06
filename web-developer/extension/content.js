/*!
 * Chrome extension content-script bridge.
 *
 * The shared engine runs against the real page here. The popup/options page sends
 * {set, setAll, run, status, state, options} messages; reports go back over the
 * extension message bus. Active toggles and options come from chrome.storage.sync,
 * so a reload (including Auto Reload) restores the same feature set.
 */
(function () {
  'use strict';

  var W = window.WebDeveloper;
  if (!W || !window.chrome || !chrome.runtime || !chrome.runtime.onMessage) return;

  var KEY = 'web-developer-v1';
  var DB = { options: JSON.parse(JSON.stringify(W.DEFAULT_OPTIONS)), active: {}, saved: {}, shortcuts: {} };

  // Popups come and go: a message with no receiver is normal, not an error worth
  // flooding the console with. Reading lastError acknowledges it explicitly.
  function send(message, callback) {
    chrome.runtime.sendMessage(message, function () {
      void chrome.runtime.lastError;
      if (callback) callback.apply(null, arguments);
    });
  }

  var session = W.createSession(window, document, {
    features: W.FEATURES,
    options: DB.options,
    saved: DB.saved,
    report: function (report) { send({ type: 'report', report: report }); },
    persist: function (key, value) {
      DB.saved[key] = value;
      chrome.storage.sync.get(KEY, function (data) {
        var payload = Object.assign({}, data && data[KEY] ? data[KEY] : {});
        payload.saved = Object.assign({}, payload.saved || {}, DB.saved);
        var out = {}; out[KEY] = payload;
        chrome.storage.sync.set(out);
      });
    },
    download: function (file) {
      send({ type: 'download', filename: file.filename, text: file.text, mime: file.mime });
    }
  });

  function activeMap() {
    var map = {};
    session.enabled().forEach(function (id) { map[id] = true; });
    return map;
  }

  function status() {
    var base = W.statusOf(window, document);
    base.jsEnabled = true; // a running content script means JavaScript is enabled here
    return base;
  }

  function broadcastStatus() {
    send({ type: 'pageStatus', status: status() });
  }

  function applyActive(active) {
    session.enabled().slice().forEach(function (id) { session.disable(id); });
    Object.keys(active || {}).forEach(function (id) { if (active[id]) session.enable(id); });
    DB.active = activeMap();
  }

  function loadStorage() {
    chrome.storage.sync.get(KEY, function (data) {
      var stored = data && data[KEY] ? data[KEY] : {};
      DB.options = Object.assign({}, W.DEFAULT_OPTIONS, stored.options || {});
      DB.options.formValues = Object.assign({}, W.DEFAULT_OPTIONS.formValues, (stored.options || {}).formValues || {});
      DB.shortcuts = DB.options.shortcuts || {};
      DB.saved = stored.saved || {};
      session.setOptions(DB.options);
      session.ctx.state.saved = DB.saved;
      applyActive((stored.active && typeof stored.active === 'object') ? stored.active : {});
      broadcastStatus();
    });
  }

  /* Cookie metadata (SameSite, HttpOnly, Secure) lives in the service worker: the
   * cookies API is not available to content scripts. */
  function withCookies(callback) {
    chrome.runtime.sendMessage({ type: 'getCookies', url: window.location.href }, function (response) {
      session.setCookies(response && response.cookies ? response.cookies : []);
      callback();
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false;
    switch (message.type) {
      case 'set':
        if (message.enabled) session.enable(message.id); else session.disable(message.id);
        DB.active = activeMap();
        sendResponse({ active: DB.active });
        return false;
      case 'setAll': {
        var wanted = {};
        (message.ids || []).forEach(function (id) { wanted[id] = true; });
        applyActive(wanted);
        sendResponse({ active: DB.active });
        return false;
      }
      case 'run':
        if (message.id === 'view-cookie-information') {
          withCookies(function () { session.run(message.id, message.payload || {}); });
          sendResponse({ ok: true });
          return false;
        }
        session.run(message.id, message.payload || {});
        sendResponse({ ok: true, active: activeMap() });
        return false;
      case 'options':
        DB.options = Object.assign({}, DB.options, message.options || {});
        DB.shortcuts = DB.options.shortcuts || {};
        session.setOptions(DB.options);
        sendResponse({ ok: true });
        return false;
      case 'status':
        sendResponse({ status: status() });
        return false;
      case 'state':
        sendResponse({ active: activeMap() });
        return false;
      default:
        return false;
    }
  });

  /* Customizable keyboard shortcuts work on the inspected page too. */
  function comboOf(event) {
    if (!event.altKey && !event.ctrlKey && !event.metaKey) return '';
    var parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    return parts.join('+').toLowerCase();
  }

  window.addEventListener('keydown', function (event) {
    var target = event.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')) return;
    var combo = comboOf(event);
    if (!combo) return;
    var id = Object.keys(DB.shortcuts || {}).filter(function (key) {
      return String(DB.shortcuts[key]).toLowerCase() === combo;
    })[0];
    if (!id) return;
    event.preventDefault();
    var feature = W.byId(id);
    if (feature && feature.mode === 'toggle') {
      if (session.isEnabled(id)) session.disable(id); else session.enable(id);
      send({ type: 'state', active: activeMap() });
    } else {
      session.run(id);
    }
  }, true);

  loadStorage();
  broadcastStatus();
})();
