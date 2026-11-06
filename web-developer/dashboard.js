/*!
 * Web Developer dashboard — UI, storage, standalone/extension adapters, options.
 * Loaded by index.html (dashboard/popup) and options.html. Same engine in both modes.
 */
(function () {
  'use strict';

  var W = window.WebDeveloper;
  if (!W) { document.body.innerHTML = '<p style="padding:20px;font:16px sans-serif">Feature engine failed to load.</p>'; return; }

  var $ = function (id) { return document.getElementById(id); };
  var esc = W.escapeHtml;
  var KEY = 'web-developer-v1';
  var isExtension = !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.tabs && chrome.tabs.sendMessage);
  var isOptionsPage = !!(document.body && document.body.dataset && document.body.dataset.page === 'options');
  var DEFAULT_MENUS = [
    { id: 'all', label: 'All features', order: 0 },
    { id: 'pinned', label: 'Pinned', order: 1 },
    { id: 'feature', label: 'Common features', order: 2 },
    { id: 'enhancement', label: 'Enhancements', order: 3 },
    { id: 'platform', label: 'Platform', order: 4 },
    { id: 'chrome', label: 'Chrome', order: 5 },
    { id: 'base', label: 'Base features', order: 6 }
  ];

  var DB = freshDB();
  var state = {
    filter: 'all', query: '', tab: 'output', reports: [], changed: false,
    session: null, detached: false, tabUrl: '', shortcutFilter: '', drag: null
  };
  var channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('web-developer-options') : null;

  function freshDB() {
    return {
      options: JSON.parse(JSON.stringify(W.DEFAULT_OPTIONS)),
      pins: [], templates: [], active: {}, saved: { lineGuides: [] }
    };
  }

  function menuConfig() {
    var custom = DB.options.customizableMenus || {};
    return DEFAULT_MENUS.map(function (menu) {
      return Object.assign({}, menu, custom[menu.id] || {});
    }).filter(function (menu) { return menu.visible !== false; })
      .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0); });
  }

  function mergeDB(raw) {
    var base = freshDB();
    if (!raw || typeof raw !== 'object') { DB = base; return; }
    DB.options = Object.assign({}, base.options, raw.options || {});
    DB.options.formValues = Object.assign({}, base.options.formValues, (raw.options || {}).formValues || {});
    DB.options.customizableMenus = Object.assign({}, (raw.options || {}).customizableMenus || {});
    DB.options.shortcuts = Object.assign({}, (raw.options || {}).shortcuts || {});
    DB.options.tools = Array.isArray(DB.options.tools) ? DB.options.tools : base.options.tools;
    DB.pins = Array.isArray(raw.pins) ? raw.pins.filter(function (id) { return !!W.byId(id); }) : [];
    DB.templates = Array.isArray(raw.templates) ? raw.templates.filter(function (t) { return t && t.name; }) : [];
    DB.saved = (raw.saved && typeof raw.saved === 'object') ? raw.saved : {};
    var active = {};
    Object.keys((raw.active && typeof raw.active === 'object') ? raw.active : {}).forEach(function (id) {
      var feature = W.byId(id);
      if (feature && feature.mode === 'toggle' && raw.active[id]) active[id] = true;
    });
    DB.active = active;
  }

  function readStorage() {
    return new Promise(function (resolve) {
      if (isExtension && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.get(KEY, function (data) { resolve(data ? data[KEY] : null); });
      } else {
        try { resolve(JSON.parse(window.localStorage.getItem(KEY) || 'null')); }
        catch (_) { resolve(null); }
      }
    });
  }

  function writeStorage() {
    if (isExtension && chrome.storage && chrome.storage.sync) {
      var payload = {};
      payload[KEY] = DB;
      chrome.storage.sync.set(payload, function () {
        if (chrome.runtime.lastError) toast('Sync failed: ' + chrome.runtime.lastError.message);
      });
    } else {
      try { window.localStorage.setItem(KEY, JSON.stringify(DB)); } catch (_) { /* quota */ }
      if (channel) channel.postMessage(DB);
    }
  }

  if (channel) {
    channel.onmessage = function (event) {
      if (!event.data || event.data === DB) return;
      mergeDB(event.data);
      applyTheme(); applyWrap(); renderAll();
      toast('Options synced from another tab');
    };
  }
  if (isExtension && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync' || !changes[KEY] || !changes[KEY].newValue) return;
      mergeDB(changes[KEY].newValue);
      applyTheme(); applyWrap(); renderAll();
    });
  }

  function markChanged() {
    state.changed = true;
    var ack = $('wd-ack');
    if (ack) ack.textContent = '● Changes';
  }
  function acknowledge() {
    state.changed = false;
    var ack = $('wd-ack');
    if (ack) ack.textContent = '✓ Saved';
    toast('Changes acknowledged');
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('wd-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 2600);
  }

  function downloadBlob(file) {
    var name = file.filename || 'web-developer.txt';
    var text = file.text || '';
    if (isExtension && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'download', filename: name, text: text, mime: file.mime || 'text/plain' });
      toast('Download started: ' + name);
      return;
    }
    try {
      var blob = new Blob([text], { type: file.mime || 'text/plain' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('Downloaded ' + name);
    } catch (error) { toast('Download failed: ' + error.message); }
  }

  /* ------------------------------------------------------------ adapters */

  function frame() { return $('wd-demo-frame'); }
  function frameWindow() { var f = frame(); return f ? f.contentWindow : null; }
  function frameDoc() { var f = frame(); try { return f ? f.contentDocument : null; } catch (_) { return null; } }
  function pageUrl() {
    if (isExtension) return state.tabUrl || '';
    try { return frameWindow().location.href; } catch (_) { return window.location.href; }
  }
  function pageDomain() {
    try { return new URL(pageUrl()).hostname; } catch (_) { return ''; }
  }

  function activeTabId() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0] ? tabs[0].id : null);
      });
    });
  }

  function sendToTab(message, retry) {
    return activeTabId().then(function (tabId) {
      if (!tabId) { toast('No active tab to inspect'); return null; }
      return new Promise(function (resolve) {
        chrome.tabs.sendMessage(tabId, message, function (response) {
          if (chrome.runtime.lastError) {
            if (!retry && chrome.scripting && chrome.scripting.executeScript) {
              chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['engine/core.js', 'engine/features.js', 'extension/content.js']
              }, function () { resolve(sendToTab(message, true)); });
            } else {
              toast('Content script unavailable: ' + chrome.runtime.lastError.message);
              resolve(null);
            }
            return;
          }
          resolve(response);
        });
      });
    }).then(function (value) { return value && value.then ? value : value; });
  }

  function createStandaloneSession() {
    var win = frameWindow(), doc = frameDoc();
    if (!win || !doc || !doc.body) return;
    state.session = W.createSession(win, doc, {
      options: DB.options,
      saved: DB.saved,
      report: pushReport,
      persist: function (key, value) { DB.saved[key] = value; writeStorage(); },
      download: downloadBlob
    });
    Object.keys(DB.active).forEach(function (id) { if (DB.active[id]) state.session.enable(id); });
    updateStatus();
  }

  function onFrameLoad() {
    if (isExtension) return;
    state.session = null; // the old document is gone; its cleanup no longer matters
    createStandaloneSession();
  }

  function setActive(id, enabled) {
    var feature = W.byId(id);
    if (!feature || feature.mode !== 'toggle') return;
    DB.active[id] = !!enabled;
    writeStorage(); markChanged();
    if (isExtension) sendToTab({ type: 'set', id: id, enabled: !!enabled });
    else if (state.session) { if (enabled) state.session.enable(id); else state.session.disable(id); }
    renderCards(); updateActiveCount();
    toast(feature.label + (enabled ? ' enabled' : ' disabled'));
  }

  function runFeature(id, payload) {
    var feature = W.byId(id);
    if (!feature) return;
    if (feature.mode === 'ui') { handleUi(feature.ui, feature); return; }
    if (isExtension) sendToTab({ type: 'run', id: id, payload: payload || {} });
    else if (state.session) {
      var result = state.session.run(id, payload || {});
      if (result && result.toggled !== undefined) {
        DB.active[id] = !!result.toggled;
        writeStorage(); renderCards(); updateActiveCount();
      }
    } else toast('The inspected page is not ready yet');
  }

  function setAllActive(ids) {
    var wanted = {};
    ids.forEach(function (id) { var f = W.byId(id); if (f && f.mode === 'toggle') wanted[id] = true; });
    if (isExtension) sendToTab({ type: 'setAll', ids: Object.keys(wanted) });
    else if (state.session) {
      state.session.enabled().slice().forEach(function (id) { state.session.disable(id); });
      Object.keys(wanted).forEach(function (id) { state.session.enable(id); });
    }
    DB.active = wanted;
    writeStorage(); markChanged(); renderCards(); updateActiveCount();
  }

  /* ------------------------------------------------------------ reports */

  function pushReport(report) {
    if (!report) return;
    state.reports.unshift(report);
    if (state.reports.length > 40) state.reports.length = 40;
    renderReport(report);
    switchTab('output');
  }

  function renderReport(report) {
    var body = $('wd-output-body');
    if (!body) { toast(report.title + ': ' + String(report.text || '').slice(0, 100)); return; }
    var title = $('wd-output-title'), meta = $('wd-output-meta');
    if (title) title.textContent = report.title;
    if (meta) {
      var feature = W.byId(report.feature);
      meta.textContent = new Date().toLocaleTimeString() + (feature ? ' · ' + feature.label : '');
    }
    body.innerHTML = report.html || '<pre class="wd-pre">' + esc(report.text || '') + '</pre>';
    applyWrap();
  }

  function beautifyOutput() {
    var body = $('wd-output-body');
    if (!body) return;
    var editor = body.querySelector('textarea.wd-editor');
    if (editor) { editor.value = W.beautifyCss(editor.value); toast('CSS beautified'); return; }
    var block = body.querySelector('pre.wd-pre');
    if (block) { block.textContent = W.beautifyCss(block.textContent); toast('CSS beautified'); return; }
    toast('Run Edit CSS or a CSS validator first, then beautify its output');
  }

  function applyWrap() {
    var body = $('wd-output-body'), wrap = $('wd-wrap');
    if (wrap) wrap.checked = !!DB.options.wrapOutput;
    if (body) body.classList.toggle('wd-wrap', !!DB.options.wrapOutput);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', DB.options.darkMode ? 'dark' : 'light');
    if (isExtension && document.body) document.body.classList.add('is-extension');
    var toggle = $('wd-dark-toggle');
    if (toggle) toggle.textContent = DB.options.darkMode ? '☀ Light' : '◐ Dark';
  }

  /* ------------------------------------------------------------ UI features */

  var UI_TABS = {
    darkMode: 'options', warnOnClose: 'options', syncOptions: 'options', wrapOutput: 'options',
    importExport: 'options', reposition: 'options', formValues: 'options', validators: 'options',
    colorSort: 'options', menus: 'options', templates: 'templates', shortcuts: 'shortcuts',
    tools: 'tools', pins: 'output'
  };

  function info(title, html) { pushReport({ title: title, html: html, feature: '' }); }

  function handleUi(ui, feature) {
    switch (ui) {
      case 'darkMode':
        DB.options.darkMode = !DB.options.darkMode;
        writeStorage(); applyTheme(); renderOptions(); markChanged();
        toast('Dark mode ' + (DB.options.darkMode ? 'on' : 'off'));
        break;
      case 'beautifyCss': beautifyOutput(); switchTab('output'); break;
      case 'warnOnClose':
        switchTab('options');
        info('Close warning', '<p class="wd-note">The dashboard asks before closing while <b>Changes</b> is shown in the header. Use <b>✓ Saved</b> to acknowledge changes. Currently ' +
          (DB.options.warnOnClose ? 'enabled' : 'disabled') + '.</p>');
        break;
      case 'reposition': toggleDetach(); break;
      case 'wrapOutput':
        DB.options.wrapOutput = !DB.options.wrapOutput; writeStorage(); applyWrap(); renderOptions(); markChanged();
        toast('Text output wrapping ' + (DB.options.wrapOutput ? 'on' : 'off'));
        break;
      case 'syncOptions':
        switchTab('options');
        info('Options sync', '<p class="wd-note">Standalone mode mirrors options to other open tabs through a BroadcastChannel; extension mode uses <code>chrome.storage.sync</code>. Currently ' +
          (DB.options.syncOptions ? 'enabled' : 'disabled') + '.</p>');
        break;
      case 'importExport': switchTab('options'); toast('Export/import buttons are at the bottom of the Options tab'); break;
      case 'pins':
        state.filter = 'pinned'; renderMenu(); renderCards();
        toast('Star any feature to pin it here');
        break;
      case 'templates': switchTab('templates'); break;
      case 'shortcuts': switchTab('shortcuts'); break;
      case 'menus': switchTab('options'); toast('Menu labels, visibility and order are in the Options form'); break;
      case 'tools': switchTab('tools'); break;
      case 'jsStatus':
        info('JavaScript status icon', '<p class="wd-note">The header chip shows the JavaScript status. In extension mode the browser-action badge mirrors it. Current page: <code>' +
          esc(pageUrl() || 'unknown') + '</code>; JavaScript is enabled in this context.</p>');
        break;
      case 'quirksStatus':
        var doc = isExtension ? null : frameDoc();
        var compat = doc ? doc.compatMode : 'CSS1Compat';
        info('Quirks mode status icon', '<p class="wd-note">The inspected document reports <code>' + esc(compat) + '</code> — ' +
          (compat === 'BackCompat' ? '<b>quirks mode</b>' : '<b>standards mode</b>') + '. In extension mode the browser-action badge shows <code>Q</code> for quirks mode.</p>');
        break;
      case 'sameSiteCookies': runFeature('view-cookie-information'); break;
      case 'elementColors':
      case 'elementPosition':
        setActive('display-element-information', true);
        info(feature.label, '<p class="wd-note">Enabled <b>Display Element Information</b>. Hover an element in the inspected page to see ' +
          (ui === 'elementColors' ? 'computed text/background/border colours with swatches.' : 'x/y page position and width/height.') + '</p>');
        break;
      case 'lineGuides':
        setActive('display-line-guides', true); runFeature('display-line-guides', { save: true }); break;
      case 'editCssColorPicker':
      case 'editCssMime': runFeature('edit-css'); break;
      case 'adjustedDimensions': setActive('outline-images-with-adjusted-dimensions', true); break;
      case 'formValues': runFeature('populate-form-fields'); break;
      case 'validators': switchTab('options'); runFeature('validate-local-css'); break;
      case 'cookieCsv': runFeature('view-cookie-information', { csv: true }); break;
      case 'imageGrid': runFeature('view-image-information', { view: 'grid' }); break;
      case 'linkDetails':
      case 'linkSplit': runFeature('view-link-information'); break;
      case 'gradients': runFeature('view-color-information', { sort: DB.options.colorSort }); break;
      case 'colorSort': switchTab('options'); runFeature('view-color-information', { sort: DB.options.colorSort }); break;
      case 'idClass':
        state.filter = 'base'; renderMenu(); renderCards();
        info(feature.label, '<p class="wd-note"><b>Display Id Details</b> and <b>Display Class Details</b> are now two independent toggles in the Base features menu.</p>');
        break;
      default:
        switchTab(UI_TABS[ui] || 'output');
        toast(feature.label + ' — see the ' + (UI_TABS[ui] || 'output') + ' tab');
    }
  }

  /* ------------------------------------------------------------ rendering */

  function matchesFilter(feature, filter) {
    if (filter === 'all') return true;
    if (filter === 'pinned') return DB.pins.indexOf(feature.id) !== -1;
    if (filter === 'chrome') return feature.category === 'Chrome';
    return feature.group === filter;
  }

  function visibleFeatures() {
    var query = state.query.trim().toLowerCase();
    return W.FEATURES.filter(function (feature) {
      if (!matchesFilter(feature, state.filter)) return false;
      if (!query) return true;
      return (feature.label + ' ' + feature.id + ' ' + feature.description + ' ' + feature.group + ' ' + feature.category)
        .toLowerCase().indexOf(query) !== -1;
    }).sort(function (a, b) {
      var pinA = DB.pins.indexOf(a.id) !== -1 ? 0 : 1;
      var pinB = DB.pins.indexOf(b.id) !== -1 ? 0 : 1;
      if (pinA !== pinB) return pinA - pinB;
      return a.label.localeCompare(b.label);
    });
  }

  function renderMenu() {
    var menu = $('wd-menu');
    if (!menu) return;
    var counts = {};
    DEFAULT_MENUS.forEach(function (item) {
      counts[item.id] = W.FEATURES.filter(function (f) { return matchesFilter(f, item.id); }).length;
    });
    menu.innerHTML = menuConfig().map(function (item) {
      return '<button type="button" data-filter="' + esc(item.id) + '" class="' + (state.filter === item.id ? 'is-active' : '') +
        '">' + esc(item.label) + '<span>' + (counts[item.id] || 0) + '</span></button>';
    }).join('');
  }

  function renderCards() {
    var container = $('wd-features');
    if (!container) return;
    var list = visibleFeatures();
    var heading = $('wd-feature-heading'), count = $('wd-feature-count');
    var activeMenu = menuConfig().filter(function (m) { return m.id === state.filter; })[0];
    if (heading) heading.textContent = activeMenu ? activeMenu.label : 'All features';
    if (count) count.textContent = list.length + ' of ' + W.FEATURES.length + ' features';
    container.innerHTML = list.map(function (f) {
      var pinned = DB.pins.indexOf(f.id) !== -1;
      var active = !!DB.active[f.id];
      var label = f.url ? '<a href="' + esc(f.url) + '" target="_blank" rel="noopener" title="Upstream to-do item">' + esc(f.label) + ' ↗</a>' : esc(f.label);
      var control;
      if (f.mode === 'toggle') {
        control = '<label class="wd-switch" title="Enable ' + esc(f.label) + '"><input type="checkbox" data-toggle="' + esc(f.id) +
          '"' + (active ? ' checked' : '') + ' aria-label="Enable ' + esc(f.label) + '"><span></span></label>';
      } else if (f.mode === 'action') {
        control = '<button type="button" class="wd-btn wd-btn-primary" data-run="' + esc(f.id) + '">Run</button>';
      } else {
        control = '<button type="button" class="wd-btn" data-run="' + esc(f.id) + '">Open →</button>';
      }
      var tagClass = f.category === 'Chrome' ? 'is-chrome' : f.group === 'feature' ? 'is-new' : f.group === 'enhancement' ? 'is-enhancement' : '';
      return '<article class="wd-card' + (active ? ' is-active' : '') + '" data-card="' + esc(f.id) + '">' +
        '<div class="wd-card-head"><h3>' + label + '</h3>' +
        '<button type="button" class="wd-pin' + (pinned ? ' is-pinned' : '') + '" data-pin="' + esc(f.id) +
        '" title="Pin feature" aria-label="Pin ' + esc(f.label) + '">' + (pinned ? '★' : '☆') + '</button></div>' +
        '<div class="wd-tags"><span class="wd-tag ' + tagClass + '">' + esc(f.category) + '</span>' +
        '<span class="wd-tag">' + esc(f.group === 'ui' ? 'dashboard' : f.group) + '</span>' +
        '<span class="wd-tag">' + esc(f.mode) + '</span></div>' +
        '<p>' + esc(f.description) + '</p>' +
        '<div class="wd-card-foot">' + control + '<small>' + esc(f.how || '') + '</small></div>' +
        '</article>';
    }).join('') || '<p class="wd-note">No features match this search.</p>';
  }

  function updateActiveCount() {
    var el = $('wd-active-count');
    if (el) el.textContent = Object.keys(DB.active).filter(function (id) { return DB.active[id]; }).length + ' active';
  }

  function updateStatus() {
    var js = $('wd-status-js'), quirks = $('wd-status-quirks');
    var status = null;
    if (!isExtension) {
      var win = frameWindow(), doc = frameDoc();
      if (win && doc) status = W.statusOf(win, doc);
    }
    if (js) js.textContent = 'JS: on';
    if (quirks) {
      var isQuirks = status ? status.quirks : false;
      quirks.textContent = isQuirks ? 'Quirks mode' : 'Standards';
      quirks.classList.toggle('is-warn', isQuirks);
    }
    var label = $('wd-mode-label');
    if (label) label.textContent = isExtension
      ? 'Extension mode · inspecting the active tab'
      : 'Standalone dashboard · inspecting the demo page';
    var url = $('wd-preview-url');
    if (url) url.textContent = isExtension ? (state.tabUrl || 'active tab') : 'demo.html';
  }

  function switchTab(tab) {
    state.tab = tab;
    var tabs = document.querySelectorAll('.wd-tab');
    Array.prototype.forEach.call(tabs, function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-tab') === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.wd-panel'), function (panel) {
      panel.classList.toggle('is-active', panel.id === 'wd-panel-' + tab);
    });
    if (tab === 'tools') renderTools();
    if (tab === 'shortcuts') renderShortcuts();
    if (tab === 'templates') renderTemplates();
  }

  /* ------------------------------------------------------------ options */

  var OPTION_FIELDS = [
    { key: 'autoReloadSeconds', label: 'Auto Reload interval (seconds)', type: 'number', min: 3, max: 3600 },
    { key: 'baselineHeight', label: 'Baseline grid height (px)', type: 'number', min: 6, max: 200 },
    { key: 'baselineColor', label: 'Baseline grid colour', type: 'text' },
    { key: 'flipDirection', label: 'Flip images direction', type: 'select', options: ['horizontal', 'vertical', 'both'] },
    { key: 'magnifierScale', label: 'Page magnifier scale', type: 'number', min: 1.25, max: 6, step: '0.25' },
    { key: 'magnifierSize', label: 'Page magnifier lens size (px)', type: 'number', min: 120, max: 600 },
    { key: 'colorSort', label: 'View Color Information sorting', type: 'select', options: ['alphabetical', 'color'] },
    { key: 'validatorHtmlUrl', label: 'Validate Local HTML endpoint (blank = local checks)', type: 'text' },
    { key: 'validatorCssUrl', label: 'Validate Local CSS endpoint (blank = local checks)', type: 'text' },
    { key: 'wrapOutput', label: 'Wrap text output', type: 'checkbox' },
    { key: 'darkMode', label: 'Dark mode', type: 'checkbox' },
    { key: 'warnOnClose', label: 'Warn before closing after changes', type: 'checkbox' },
    { key: 'syncOptions', label: 'Sync options across tabs / devices', type: 'checkbox' },
    { key: 'repositionDashboard', label: 'Allow repositioning panels and overlays', type: 'checkbox' }
  ];

  function fieldHtml(field, value, path) {
    var name = path || field.key;
    if (field.type === 'checkbox') {
      return '<div class="wd-field wd-field-check"><input type="checkbox" id="opt-' + esc(name) + '" data-option="' + esc(name) + '"' +
        (value ? ' checked' : '') + '><label for="opt-' + esc(name) + '">' + esc(field.label) + '</label></div>';
    }
    var input;
    if (field.type === 'select') {
      input = '<select class="wd-input" id="opt-' + esc(name) + '" data-option="' + esc(name) + '">' + field.options.map(function (option) {
        return '<option value="' + esc(option) + '"' + (String(value) === option ? ' selected' : '') + '>' + esc(option) + '</option>';
      }).join('') + '</select>';
    } else {
      input = '<input class="wd-input" id="opt-' + esc(name) + '" type="' + esc(field.type) + '" data-option="' + esc(name) + '" value="' + esc(value) + '"' +
        (field.min !== undefined ? ' min="' + field.min + '"' : '') + (field.max !== undefined ? ' max="' + field.max + '"' : '') +
        (field.step !== undefined ? ' step="' + field.step + '"' : '') + '>';
    }
    return '<div class="wd-field"><label for="opt-' + esc(name) + '">' + esc(field.label) + '</label>' + input + '</div>';
  }

  function renderOptions() {
    var form = $('wd-options-form');
    if (!form) return;
    var html = '<h3 class="wd-fieldset-title">Behaviour</h3>' + OPTION_FIELDS.map(function (field) {
      return fieldHtml(field, DB.options[field.key]);
    }).join('');
    html += '<h3 class="wd-fieldset-title">Populate Form Fields — sample values</h3>';
    Object.keys(DB.options.formValues || {}).forEach(function (key) {
      var value = DB.options.formValues[key];
      var type = (key === 'checkbox' || key === 'radio') ? 'checkbox' : 'text';
      html += fieldHtml({ key: key, label: key, type: type }, value, 'formValues.' + key);
    });
    form.innerHTML = html;
    renderMenuSettings();
  }

  function renderMenuSettings() {
    var container = $('wd-menu-settings');
    if (!container) return;
    var custom = DB.options.customizableMenus || {};
    container.innerHTML = DEFAULT_MENUS.map(function (menu) {
      var cfg = Object.assign({}, menu, custom[menu.id] || {});
      return '<div class="wd-field"><label>Menu label</label><input class="wd-input" data-option="menus.' + esc(menu.id) +
        '.label" value="' + esc(cfg.label) + '"></div>' +
        '<div class="wd-field"><label>Order</label><input class="wd-input" type="number" data-option="menus.' + esc(menu.id) +
        '.order" value="' + esc(cfg.order) + '"></div>' +
        '<div class="wd-field wd-field-check"><input type="checkbox" data-option="menus.' + esc(menu.id) + '.visible"' +
        (cfg.visible === false ? '' : ' checked') + '><label>Show "' + esc(menu.label) + '"</label></div>';
    }).join('');
  }

  function collectOptions() {
    var options = JSON.parse(JSON.stringify(DB.options));
    Array.prototype.forEach.call(document.querySelectorAll('[data-option]'), function (el) {
      var parts = el.getAttribute('data-option').split('.');
      var value = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value);
      if (parts[0] === 'formValues') options.formValues[parts[1]] = value;
      else if (parts[0] === 'menus') {
        if (!options.customizableMenus[parts[1]]) options.customizableMenus[parts[1]] = {};
        options.customizableMenus[parts[1]][parts[2]] = parts[2] === 'visible' ? !!(value) : value;
      } else options[parts[0]] = value;
    });
    return options;
  }

  function saveOptions() {
    DB.options = collectOptions();
    writeStorage(); applyTheme(); applyWrap(); markChanged();
    if (state.session) state.session.setOptions(DB.options);
    if (isExtension) sendToTab({ type: 'options', options: DB.options });
    renderAll();
    toast('Options saved');
  }

  function exportOptions() {
    var payload = { app: 'web-developer', version: 1, exportedAt: new Date().toISOString(),
      options: DB.options, pins: DB.pins, templates: DB.templates, active: DB.active, saved: DB.saved };
    downloadBlob({ filename: 'web-developer-options.json', text: JSON.stringify(payload, null, 2), mime: 'application/json' });
  }

  function copyOptions() {
    var payload = { app: 'web-developer', version: 1, options: DB.options, pins: DB.pins, templates: DB.templates, active: DB.active, saved: DB.saved };
    var text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Options JSON copied'); });
    else toast('Clipboard unavailable — use Export JSON instead');
  }

  function importOptions(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var payload;
      try { payload = JSON.parse(String(reader.result)); }
      catch (error) { toast('Invalid JSON: ' + error.message); return; }
      if (!payload || typeof payload !== 'object' || !payload.options) { toast('Not a Web Developer options file'); return; }
      mergeDB(payload);
      writeStorage(); applyTheme(); applyWrap(); renderAll();
      if (state.session) state.session.setOptions(DB.options);
      if (isExtension) sendToTab({ type: 'options', options: DB.options });
      markChanged(); toast('Options imported');
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------ templates */

  function renderTemplates() {
    var list = $('wd-template-list');
    if (!list) return;
    if (!DB.templates.length) { list.innerHTML = '<p class="wd-note">No templates saved yet.</p>'; return; }
    list.innerHTML = DB.templates.map(function (template, index) {
      return '<div class="wd-card-row"><strong>' + esc(template.name) + '</strong><code>' + (template.features || []).length + ' features</code>' +
        '<button type="button" class="wd-btn wd-btn-primary" data-template-load="' + index + '">Load</button>' +
        '<button type="button" class="wd-btn" data-template-delete="' + index + '">Delete</button></div>';
    }).join('');
  }

  function saveTemplate() {
    var input = $('wd-template-name');
    if (!input) return;
    var name = input.value.trim();
    if (!name) { toast('Give the template a name'); return; }
    var features = Object.keys(DB.active).filter(function (id) { return DB.active[id]; });
    DB.templates = DB.templates.filter(function (t) { return t.name !== name; });
    DB.templates.push({ name: name, features: features, savedAt: new Date().toISOString() });
    input.value = '';
    writeStorage(); markChanged(); renderTemplates();
    toast('Template "' + name + '" saved with ' + features.length + ' feature(s)');
  }

  /* ------------------------------------------------------------ shortcuts */

  function renderShortcuts() {
    var list = $('wd-shortcut-list');
    if (!list) return;
    var query = state.shortcutFilter.trim().toLowerCase();
    var features = W.FEATURES.filter(function (f) {
      return f.mode !== 'ui' && (!query || (f.label + f.id).toLowerCase().indexOf(query) !== -1);
    });
    var search = $('wd-shortcut-search');
    if (search && search.value !== state.shortcutFilter) search.value = state.shortcutFilter;
    list.innerHTML = features.map(function (f) {
      return '<div class="wd-shortcut-row"><span>' + esc(f.label) + '</span>' +
        '<input class="wd-input" data-shortcut="' + esc(f.id) + '" placeholder="e.g. Alt+Shift+D" value="' +
        esc((DB.options.shortcuts || {})[f.id] || '') + '"></div>';
    }).join('');
  }

  function saveShortcuts() {
    var shortcuts = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-shortcut]'), function (el) {
      var value = el.value.trim();
      if (value) shortcuts[el.getAttribute('data-shortcut')] = value;
    });
    DB.options.shortcuts = shortcuts;
    writeStorage(); markChanged();
    if (isExtension) sendToTab({ type: 'options', options: DB.options });
    toast(Object.keys(shortcuts).length + ' shortcut(s) saved');
  }

  function comboOf(event) {
    if (!event.altKey && !event.ctrlKey && !event.metaKey) return '';
    var parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    var key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    parts.push(key);
    return parts.join('+').toLowerCase();
  }

  function onShortcut(event) {
    var target = event.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')) return;
    var combo = comboOf(event);
    if (!combo) return;
    var found = Object.keys(DB.options.shortcuts || {}).filter(function (id) {
      return String(DB.options.shortcuts[id]).toLowerCase() === combo;
    })[0];
    if (!found) return;
    event.preventDefault();
    var feature = W.byId(found);
    if (feature && feature.mode === 'toggle') setActive(found, !DB.active[found]);
    else runFeature(found);
    toast(feature ? feature.label + ' (shortcut)' : found);
  }

  /* ------------------------------------------------------------ tools */

  function renderTools() {
    var list = $('wd-tool-list');
    if (!list) return;
    var url = pageUrl(), domain = pageDomain();
    list.innerHTML = (DB.options.tools || []).map(function (tool, index) {
      var expanded = W.expandToolUrl(tool.url, url, domain);
      return '<div class="wd-card-row" data-tool="' + index + '">' +
        '<input class="wd-input" data-tool-name value="' + esc(tool.name) + '" aria-label="Tool name">' +
        '<input class="wd-input" data-tool-url value="' + esc(tool.url) + '" aria-label="Tool URL template">' +
        '<a class="wd-btn" href="' + esc(expanded) + '" target="_blank" rel="noopener">Open ↗</a>' +
        '<button type="button" class="wd-btn" data-tool-remove="' + index + '">Remove</button>' +
        '<code>%s → ' + esc(url || '(no page)') + ' · %d → ' + esc(domain || '(no domain)') + '</code></div>';
    }).join('') || '<p class="wd-note">No tools configured.</p>';
  }

  function saveTools() {
    var tools = [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-tool]'), function (row) {
      var name = row.querySelector('[data-tool-name]').value.trim();
      var url = row.querySelector('[data-tool-url]').value.trim();
      if (name && url) tools.push({ name: name, url: url });
    });
    DB.options.tools = tools;
    writeStorage(); markChanged(); renderTools();
    toast(tools.length + ' tool(s) saved');
  }

  function addTool() {
    DB.options.tools = (DB.options.tools || []).concat([{ name: 'New tool', url: 'https://example.com/?url=%s&domain=%d' }]);
    renderTools();
  }

  /* ------------------------------------------------------------ detach */

  function toggleDetach() {
    var out = $('wd-output');
    if (!out) { toast('Repositioning is available in the dashboard'); return; }
    state.detached = !state.detached;
    out.classList.toggle('wd-floating', state.detached);
    var positions = (DB.saved.overlayPositions || {});
    if (state.detached && positions.outputPanel) {
      out.style.left = positions.outputPanel.x + 'px';
      out.style.top = positions.outputPanel.y + 'px';
      out.style.right = 'auto';
    } else if (!state.detached) {
      out.style.left = ''; out.style.top = ''; out.style.right = '';
    }
    toast(state.detached ? 'Output panel detached — drag its tab bar to move it' : 'Output panel docked');
  }

  function bindDetachDrag() {
    var head = $('wd-output-head'), out = $('wd-output');
    if (!head || !out) return;
    head.addEventListener('mousedown', function (event) {
      if (!out.classList.contains('wd-floating') || (event.target.closest && event.target.closest('button'))) return;
      state.drag = { x: event.clientX, y: event.clientY, left: out.offsetLeft, top: out.offsetTop };
      event.preventDefault();
    });
    document.addEventListener('mousemove', function (event) {
      if (!state.drag) return;
      out.style.left = Math.max(0, state.drag.left + event.clientX - state.drag.x) + 'px';
      out.style.top = Math.max(0, state.drag.top + event.clientY - state.drag.y) + 'px';
      out.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () {
      if (!state.drag) return;
      state.drag = null;
      var positions = Object.assign({}, DB.saved.overlayPositions || {});
      positions.outputPanel = { x: out.offsetLeft, y: out.offsetTop };
      DB.saved.overlayPositions = positions;
      writeStorage();
    });
  }

  /* ------------------------------------------------------------ events */

  function on(id, type, handler) {
    var el = $(id);
    if (el) el.addEventListener(type, handler);
  }

  function bindEvents() {
    on('wd-search', 'input', function (event) { state.query = event.target.value; renderCards(); });
    var menu = $('wd-menu');
    if (menu) menu.addEventListener('click', function (event) {
      var button = event.target.closest('[data-filter]');
      if (!button) return;
      state.filter = button.getAttribute('data-filter');
      renderMenu(); renderCards();
    });
    var cards = $('wd-features');
    if (cards) {
      cards.addEventListener('change', function (event) {
        var input = event.target.closest('[data-toggle]');
        if (input) setActive(input.getAttribute('data-toggle'), input.checked);
      });
      cards.addEventListener('click', function (event) {
        var pin = event.target.closest('[data-pin]');
        if (pin) {
          var id = pin.getAttribute('data-pin');
          var at = DB.pins.indexOf(id);
          if (at === -1) DB.pins.push(id); else DB.pins.splice(at, 1);
          writeStorage(); markChanged(); renderMenu(); renderCards();
          toast(at === -1 ? 'Pinned' : 'Unpinned');
          return;
        }
        var run = event.target.closest('[data-run]');
        if (run && !event.target.closest('a')) runFeature(run.getAttribute('data-run'));
      });
    }
    var tabs = $('wd-output-tabs');
    if (tabs) tabs.addEventListener('click', function (event) {
      var button = event.target.closest('[data-tab]');
      if (button) switchTab(button.getAttribute('data-tab'));
    });
    var body = $('wd-output-body');
    if (body) body.addEventListener('click', function (event) {
      var button = event.target.closest('[data-wd-feature]');
      if (!button) return;
      var id = button.getAttribute('data-wd-feature');
      var payload = {};
      try { payload = JSON.parse(button.getAttribute('data-wd-payload') || '{}'); } catch (_) { payload = {}; }
      var inputs = button.getAttribute('data-wd-input');
      if (inputs) inputs.split(',').forEach(function (spec) {
        var parts = spec.split(':');
        var el = $(parts[1]);
        payload[parts[0]] = el ? (el.value !== undefined ? el.value : el.textContent) : '';
      });
      runFeature(id, payload);
    });
    on('wd-wrap', 'change', function (event) {
      DB.options.wrapOutput = event.target.checked; writeStorage(); applyWrap(); markChanged();
    });
    on('wd-beautify', 'click', beautifyOutput);
    on('wd-clear', 'click', function () {
      if (body) body.innerHTML = '<p class="wd-note">Output cleared.</p>';
      var title = $('wd-output-title'); if (title) title.textContent = 'No report yet';
      var meta = $('wd-output-meta'); if (meta) meta.textContent = '';
    });
    on('wd-copy', 'click', function () {
      if (!body) return;
      var text = body.innerText || body.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Output copied'); });
      else toast('Clipboard unavailable in this context');
    });
    on('wd-detach', 'click', toggleDetach);
    on('wd-dark-toggle', 'click', function () {
      DB.options.darkMode = !DB.options.darkMode;
      writeStorage(); applyTheme(); renderOptions(); markChanged();
    });
    on('wd-ack', 'click', acknowledge);
    on('wd-close', 'click', function () {
      if (DB.options.warnOnClose && state.changed && !window.confirm('Changes have been made to the dashboard. Close anyway?')) return;
      window.close();
      toast('The browser may block closing a normal tab — use the tab close button.');
    });
    on('wd-demo-reload', 'click', function () { var f = frame(); if (f) f.src = f.src; });
    on('wd-demo-width', 'change', function (event) { var f = frame(); if (f) f.style.width = event.target.value; });
    on('wd-options-save', 'click', saveOptions);
    on('wd-menu-save', 'click', saveOptions);
    on('wd-options-reset', 'click', function () {
      var base = freshDB();
      DB.options = base.options;
      writeStorage(); applyTheme(); applyWrap(); markChanged(); renderAll();
      if (state.session) state.session.setOptions(DB.options);
      toast('Options reset to defaults');
    });
    on('wd-options-export', 'click', exportOptions);
    on('wd-options-copy', 'click', copyOptions);
    on('wd-options-import', 'change', function (event) {
      importOptions(event.target.files && event.target.files[0]);
      event.target.value = '';
    });
    on('wd-template-save', 'click', saveTemplate);
    var templateList = $('wd-template-list');
    if (templateList) templateList.addEventListener('click', function (event) {
      var load = event.target.closest('[data-template-load]');
      var remove = event.target.closest('[data-template-delete]');
      if (load) {
        var template = DB.templates[Number(load.getAttribute('data-template-load'))];
        if (template) { setAllActive(template.features || []); toast('Template "' + template.name + '" loaded'); }
      } else if (remove) {
        DB.templates.splice(Number(remove.getAttribute('data-template-delete')), 1);
        writeStorage(); markChanged(); renderTemplates();
      }
    });
    on('wd-shortcut-search', 'input', function (event) { state.shortcutFilter = event.target.value; renderShortcuts(); });
    on('wd-shortcut-save', 'click', saveShortcuts);
    on('wd-shortcut-reset', 'click', function () {
      DB.options.shortcuts = {}; writeStorage(); markChanged(); renderShortcuts(); toast('Shortcuts cleared');
    });
    on('wd-tool-add', 'click', addTool);
    on('wd-tool-save', 'click', saveTools);
    var toolList = $('wd-tool-list');
    if (toolList) toolList.addEventListener('click', function (event) {
      var remove = event.target.closest('[data-tool-remove]');
      if (!remove) return;
      DB.options.tools.splice(Number(remove.getAttribute('data-tool-remove')), 1);
      renderTools();
    });
    document.addEventListener('keydown', onShortcut);
    window.addEventListener('beforeunload', function (event) {
      if (!DB.options.warnOnClose || !state.changed) return;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });
    if (isExtension && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (message) {
        if (!message) return;
        if (message.type === 'report') pushReport(message.report);
        else if (message.type === 'status') {
          state.tabUrl = message.status && message.status.url ? message.status.url : state.tabUrl;
          var quirks = $('wd-status-quirks');
          if (quirks && message.status) {
            var isQuirks = !!message.status.quirks;
            quirks.textContent = isQuirks ? 'Quirks mode' : 'Standards';
            quirks.classList.toggle('is-warn', isQuirks);
          }
          updateStatus();
        } else if (message.type === 'state' && message.active) {
          DB.active = message.active; renderCards(); updateActiveCount();
        }
      });
    }
    var iframe = frame();
    if (iframe && !isExtension) iframe.addEventListener('load', onFrameLoad);
    bindDetachDrag();
  }

  function renderAll() {
    renderMenu(); renderCards(); renderOptions(); renderTemplates(); renderShortcuts(); renderTools();
    updateActiveCount(); updateStatus();
  }

  /* ------------------------------------------------------------ boot */

  readStorage().then(function (raw) {
    mergeDB(raw);
    applyTheme(); applyWrap();
    bindEvents();
    renderAll();
    if (isExtension) {
      activeTabId().then(function (id) {
        if (!id) return;
        chrome.tabs.get(id, function (tab) { state.tabUrl = tab && tab.url ? tab.url : ''; updateStatus(); renderTools(); });
      });
      sendToTab({ type: 'status' }).then(function (response) {
        if (response && response.status) {
          state.tabUrl = response.status.url || state.tabUrl;
          var quirks = $('wd-status-quirks');
          if (quirks) {
            quirks.textContent = response.status.quirks ? 'Quirks mode' : 'Standards';
            quirks.classList.toggle('is-warn', !!response.status.quirks);
          }
          updateStatus();
        }
      });
      sendToTab({ type: 'state' }).then(function (response) {
        if (response && response.active) { DB.active = response.active; renderCards(); updateActiveCount(); }
      });
    } else {
      var demoFrame = frame();
      if (demoFrame) demoFrame.src = 'demo.html';
      // About:blank already has a usable document; the load handler replaces this
      // session with one bound to the demo document as soon as it is ready.
      var doc = frameDoc();
      if (doc && doc.body) createStandaloneSession();
    }
  });
})();
