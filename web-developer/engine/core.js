/*!
 * Web Developer tool — shared engine (helpers + session runtime).
 *
 * This file is deliberately dependency-free and ES2017-safe: it is loaded as a classic
 * script by the standalone dashboard and by the Chrome extension content script, and it
 * is required directly by the Node test suite. No network, no storage and no browser API
 * is used here that the host does not pass in through `createSession(win, doc, config)`.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WebDeveloperCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  var ARIA_STATES = [
    'aria-activedescendant', 'aria-atomic', 'aria-autocomplete', 'aria-busy', 'aria-checked',
    'aria-colcount', 'aria-colindex', 'aria-colspan', 'aria-controls', 'aria-current',
    'aria-describedby', 'aria-details', 'aria-disabled', 'aria-errormessage', 'aria-expanded',
    'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden', 'aria-invalid',
    'aria-keyshortcuts', 'aria-labelledby', 'aria-level', 'aria-live', 'aria-modal',
    'aria-multiline', 'aria-multiselectable', 'aria-orientation', 'aria-owns', 'aria-placeholder',
    'aria-posinset', 'aria-pressed', 'aria-readonly', 'aria-relevant', 'aria-required',
    'aria-roledescription', 'aria-rowcount', 'aria-rowindex', 'aria-rowspan', 'aria-selected',
    'aria-setsize', 'aria-sort', 'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'
  ];

  var TYPOS = {
    'teh': 'the', 'recieve': 'receive', 'adress': 'address', 'definately': 'definitely',
    'occured': 'occurred', 'seperate': 'separate', 'wich': 'which', 'lenght': 'length',
    'calender': 'calendar', 'comming': 'coming', 'succesful': 'successful', 'untill': 'until',
    'wierd': 'weird', 'accomodate': 'accommodate', 'begining': 'beginning', 'publically': 'publicly'
  };

  var NAMED_COLORS = {
    white: [255, 255, 255, 1], black: [0, 0, 0, 1], red: [255, 0, 0, 1],
    lime: [0, 255, 0, 1], blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1],
    cyan: [0, 255, 255, 1], aqua: [0, 255, 255, 1], magenta: [255, 0, 255, 1],
    fuchsia: [255, 0, 255, 1], silver: [192, 192, 192, 1], gray: [128, 128, 128, 1],
    grey: [128, 128, 128, 1], maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1],
    green: [0, 128, 0, 1], purple: [128, 0, 128, 1], teal: [0, 128, 128, 1],
    navy: [0, 0, 128, 1], orange: [255, 165, 0, 1], pink: [255, 192, 203, 1],
    rebeccapurple: [102, 51, 153, 1], transparent: [0, 0, 0, 0]
  };

  var DEFAULT_OPTIONS = {
    autoReloadSeconds: 30,
    baselineHeight: 24,
    baselineColor: 'rgba(220, 38, 38, 0.35)',
    flipDirection: 'horizontal',
    magnifierScale: 2,
    magnifierSize: 220,
    colorSort: 'alphabetical',
    wrapOutput: true,
    darkMode: false,
    warnOnClose: true,
    syncOptions: true,
    repositionDashboard: true,
    customizableMenus: {},
    shortcuts: {},
    tools: [
      { name: 'Validator — HTML', url: 'https://validator.w3.org/nu/?doc=%s' },
      { name: 'Validator — CSS', url: 'https://jigsaw.w3.org/css-validator/validator?uri=%s&profile=css3' },
      { name: 'Domain whois', url: 'https://www.whois.com/whois/%d' }
    ],
    validatorHtmlUrl: '',
    validatorCssUrl: '',
    formValues: {
      text: 'Web Developer', email: 'developer@example.com', tel: '+20 100 000 0000',
      number: '42', date: '2026-11-06', url: 'https://example.com/',
      password: 'test-password', textarea: 'Filled by Web Developer',
      checkbox: true, radio: true, select: 'first', color: '#7c3aed'
    },
    lineGuides: []
  };

  /* ------------------------------------------------------------ primitives */

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseColor(value) {
    if (!value) return null;
    var text = String(value).trim().toLowerCase();
    if (text === 'transparent' || text === 'none') return [0, 0, 0, 0];
    if (NAMED_COLORS[text]) return NAMED_COLORS[text].slice();
    var hex = /^#([0-9a-f]{3,8})$/.exec(text);
    if (hex) {
      var h = hex[1];
      if (h.length === 3 || h.length === 4) {
        var r = parseInt(h[0] + h[0], 16), g = parseInt(h[1] + h[1], 16), b = parseInt(h[2] + h[2], 16);
        var a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
        return [r, g, b, a];
      }
      if (h.length === 6 || h.length === 8) {
        return [
          parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
          h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
        ];
      }
    }
    var rgb = /^rgba?\(([^)]+)\)$/.exec(text);
    if (rgb) {
      var parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length >= 3) {
        var channel = function (v) {
          return v.indexOf('%') !== -1 ? Math.round(parseFloat(v) * 2.55) : Math.round(parseFloat(v));
        };
        var alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;
        if (parts[3] && parts[3].indexOf('%') !== -1) alpha = parseFloat(parts[3]) / 100;
        return [channel(parts[0]), channel(parts[1]), channel(parts[2]), isNaN(alpha) ? 1 : alpha];
      }
    }
    var hsl = /^hsla?\(([^)]+)\)$/.exec(text);
    if (hsl) {
      var hp = hsl[1].split(/[,\s/]+/).filter(Boolean);
      var hue = parseFloat(hp[0]) || 0, sat = parseFloat(hp[1]) / 100, light = parseFloat(hp[2]) / 100;
      var c = (1 - Math.abs(2 * light - 1)) * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = light - c / 2;
      var seg = Math.floor(hue / 60) % 6;
      var triples = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg] || [0, 0, 0];
      var ha = hp.length > 3 ? parseFloat(hp[3]) : 1;
      return triples.map(function (v) { return Math.round((v + m) * 255); }).concat([isNaN(ha) ? 1 : ha]);
    }
    return null;
  }

  function toHex(rgb) {
    if (!rgb) return '';
    return '#' + [rgb[0], rgb[1], rgb[2]].map(function (v) {
      return pad2(Math.max(0, Math.min(255, Math.round(v))).toString(16));
    }).join('').toUpperCase();
  }

  function luminance(rgb) {
    if (!rgb) return 0;
    var channels = [rgb[0], rgb[1], rgb[2]].map(function (v) {
      var c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /** WCAG 2.x contrast ratio; returns null for colours it cannot parse. */
  function contrastRatio(foreground, background) {
    var a = typeof foreground === 'string' ? parseColor(foreground) : foreground;
    var b = typeof background === 'string' ? parseColor(background) : background;
    if (!a || !b) return null;
    // Composite a translucent foreground over the background before measuring.
    if (a[3] < 1) {
      a = [0, 1, 2].map(function (i) { return a[i] * a[3] + b[i] * (1 - a[3]); });
    }
    var l1 = luminance(a), l2 = luminance(b);
    var high = Math.max(l1, l2), low = Math.min(l1, l2);
    return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
  }

  function hueOf(rgb) {
    if (!rgb) return -1;
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return -1; // greys sort to the front, in brightness order
    var h = 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  /** Sort colour records by name (alphabetical) or by hue/chromaticity (by color). */
  function sortColors(colors, mode) {
    var list = (colors || []).slice();
    if (mode === 'color' || mode === 'hue') {
      list.sort(function (a, b) {
        var ca = parseColor(a.value || a.color || a), cb = parseColor(b.value || b.color || b);
        var ha = hueOf(ca), hb = hueOf(cb);
        if (ha < 0 && hb >= 0) return -1;
        if (hb < 0 && ha >= 0) return 1;
        if (ha !== hb) return ha - hb;
        return (luminance(ca) - luminance(cb)) || String(a.value || a).localeCompare(String(b.value || b));
      });
    } else {
      list.sort(function (a, b) {
        return String(a.value || a.color || a).localeCompare(String(b.value || b.color || b), undefined, { sensitivity: 'base' });
      });
    }
    return list;
  }

  /** Extract gradient functions (with balanced parentheses) from any CSS text. */
  function extractGradients(text) {
    var source = String(text || ''), found = [], i = 0;
    var pattern = /(repeating-)?(linear|radial|conic)-gradient\s*\(/gi;
    while (i < source.length) {
      pattern.lastIndex = i;
      var match = pattern.exec(source);
      if (!match) break;
      var start = match.index, open = source.indexOf('(', start + match[0].length - 1);
      var depth = 0, end = -1;
      for (var p = open; p < source.length; p += 1) {
        if (source[p] === '(') depth += 1;
        else if (source[p] === ')') { depth -= 1; if (depth === 0) { end = p + 1; break; } }
      }
      if (end === -1) break;
      var declaration = source.slice(start, end);
      var colors = [];
      var colorPattern = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|teal|navy|transparent)\b)/g;
      var colorMatch;
      while ((colorMatch = colorPattern.exec(declaration)) !== null) colors.push(colorMatch[0]);
      found.push({
        type: (match[1] || '') + (match[2] || 'linear') + '-gradient',
        value: declaration,
        colors: colors,
        preview: declaration.indexOf('url(') === -1 ? declaration : ''
      });
      i = end;
    }
    return found;
  }

  /** A small, deterministic CSS beautifier (no dependencies, preserves comments loosely). */
  function beautifyCss(css) {
    var text = String(css || '').replace(/\r\n/g, '\n');
    var out = '', indent = 0, buffer = '', i = 0;
    var pad = function (n) { return new Array(Math.max(0, n) * 2 + 1).join(' '); };
    function flush(terminate) {
      var trimmed = buffer.trim();
      if (trimmed) {
        // A declaration without its final semicolon is still valid CSS; keep it valid when
        // a block closes immediately after it.
        if (terminate && trimmed.slice(-1) !== ';' && trimmed.slice(-1) !== '{') trimmed += ';';
        out += pad(indent) + trimmed + '\n';
      }
      buffer = '';
    }
    while (i < text.length) {
      var ch = text[i];
      if (ch === '{') {
        buffer += ' {'; flush(); indent += 1;
      } else if (ch === '}') {
        flush(true); indent = Math.max(0, indent - 1); out += pad(indent) + '}\n';
        // one blank line between blocks
        if (out.slice(-2) !== '\n\n') out += '\n';
      } else if (ch === ';') {
        buffer += ';'; flush();
      } else if (ch === '\n' || ch === '\t') {
        buffer += ' ';
      } else {
        buffer += ch;
      }
      i += 1;
    }
    flush();
    return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /** %s = full page URL, %d = domain. Both are encoded for use inside a URL. */
  function expandToolUrl(template, pageUrl, domain) {
    var url = String(pageUrl || '');
    var host = domain;
    if (!host) {
      try { host = new URL(url, 'https://example.com/').hostname; } catch (_) { host = ''; }
    }
    return String(template || '')
      .replace(/%s/g, encodeURIComponent(url))
      .replace(/%d/g, encodeURIComponent(host))
      .replace(/%S/g, url)
      .replace(/%D/g, host);
  }

  function csvCell(value) {
    var text = String(value === null || value === undefined ? '' : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  /** Cookie objects → RFC-4180-ish CSV (exportable from any runtime). */
  function cookiesToCsv(cookies) {
    var headers = ['name', 'value', 'domain', 'path', 'expires', 'secure', 'httpOnly', 'sameSite', 'size'];
    var lines = [headers.map(csvCell).join(',')];
    (cookies || []).forEach(function (cookie) {
      lines.push(headers.map(function (key) {
        var value = cookie[key];
        if (key === 'size') value = value || (String(cookie.name || '').length + String(cookie.value || '').length);
        if (key === 'expires' && typeof value === 'number') value = new Date(value * 1000).toISOString();
        if (typeof value === 'boolean') value = value ? 'true' : 'false';
        return csvCell(value);
      }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /** Link records → { internal, external } using the page URL as the boundary. */
  function splitLinks(links, pageUrl) {
    var host = '';
    try { host = new URL(pageUrl || '', 'https://example.com/').hostname; } catch (_) { host = ''; }
    var internal = [], external = [];
    (links || []).forEach(function (link) {
      var href = String(link.href || '');
      var target = href;
      try { target = new URL(href, pageUrl || 'https://example.com/').href; } catch (_) { /* keep raw */ }
      var candidate = host;
      try { candidate = new URL(target).hostname; } catch (_) { /* keep page host */ }
      var isInternal = /^(#|mailto:|tel:|javascript:|\/|\.\/|\.\.\/)/i.test(href) || (!host && !candidate) || candidate === host;
      (isInternal ? internal : external).push(link);
    });
    return { internal: internal, external: external };
  }

  /** Indent a flattened HTML string so a tidied source is readable in the output panel. */
  function tidyHtml(html) {
    var text = String(html || '').replace(/>\s*</g, '><').replace(/\s+/g, ' ').trim();
    var tokens = text.replace(/></g, '>\n<').split('\n');
    var voidTags = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
    var out = [], depth = 0;
    tokens.forEach(function (line) {
      var token = line.trim();
      if (!token) return;
      var closing = /^<\//.test(token);
      var tagMatch = /^<\/?([a-zA-Z0-9-]+)/.exec(token);
      var tag = tagMatch ? tagMatch[1].toLowerCase() : '';
      var selfClosing = /\/>$/.test(token) || voidTags.test(tag) || /^<(?:!doctype|\?|!--)/i.test(token);
      if (closing) depth = Math.max(0, depth - 1);
      out.push(new Array(depth * 2 + 1).join(' ') + token);
      if (!closing && !selfClosing) depth += 1;
    });
    return out.join('\n');
  }

  function statusOf(win, doc) {
    var compat = doc.compatMode || 'CSS1Compat';
    return {
      javascript: 'enabled',
      quirks: compat === 'BackCompat',
      compatMode: compat,
      url: (win.location && win.location.href) || '',
      title: doc.title || '',
      viewport: [win.innerWidth || 0, win.innerHeight || 0]
    };
  }

  /* ------------------------------------------------------------ session */

  function createSession(win, doc, config) {
    config = config || {};
    var byId = {};
    (config.features || []).forEach(function (feature) { byId[feature.id] = feature; });
    var state = {
      enabled: {},
      options: Object.assign({}, DEFAULT_OPTIONS, config.options || {}),
      saved: Object.assign({}, config.saved || {}),
      cookies: config.cookies || null,
      cssDraft: null,
      alive: true
    };
    var cleanups = {};
    var inspectors = {};
    var inspectorListeners = [];
    var lastMouse = { x: 20, y: 20 };
    var reportFn = config.report || function () {};
    var persistFn = config.persist || function () {};
    var downloadFn = config.download || function () {};
    var timers = [];

    function notUi(el) {
      return !!(el && el.nodeType === 1 && !el.hasAttribute('data-wd-ui') &&
        (!el.closest || !el.closest('[data-wd-ui]')));
    }

    function elements(selector, scope) {
      return Array.prototype.slice.call((scope || doc).querySelectorAll(selector)).filter(notUi);
    }

    function style(id, css) {
      var el = doc.getElementById('wd-style-' + id);
      if (!el) {
        el = doc.createElement('style');
        el.id = 'wd-style-' + id;
        el.setAttribute('data-wd-ui', '');
        (doc.head || doc.documentElement).appendChild(el);
      }
      el.textContent = css;
      return el;
    }

    function unstyle(id) {
      var el = doc.getElementById('wd-style-' + id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function overlay(id, html, cssText) {
      var el = doc.getElementById('wd-overlay-' + id);
      if (!el) {
        el = doc.createElement('div');
        el.id = 'wd-overlay-' + id;
        el.setAttribute('data-wd-ui', '');
        el.className = 'wd-overlay';
        (doc.body || doc.documentElement).appendChild(el);
      }
      el.innerHTML = html === undefined ? '' : html;
      el.setAttribute('style',
        'position:fixed;z-index:2147483000;font:12px/1.45 system-ui,sans-serif;color:#111;' +
        'background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 30px rgba(15,23,42,.18);' +
        'padding:8px 10px;pointer-events:none;' + (cssText || ''));
      return el;
    }

    function unoverlay(id) {
      var el = doc.getElementById('wd-overlay-' + id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function addCleanup(id, fn) {
      if (!cleanups[id]) cleanups[id] = [];
      cleanups[id].push(fn);
    }

    function runCleanup(id) {
      (cleanups[id] || []).forEach(function (fn) {
        try { fn(); } catch (error) { report({ title: 'Cleanup', text: id + ': ' + error.message }); }
      });
      delete cleanups[id];
    }

    function listen(id, target, type, handler, capture) {
      if (!target || !target.addEventListener) return function () {};
      var flag = capture === undefined ? true : capture;
      target.addEventListener(type, handler, flag);
      var off = function () { target.removeEventListener(type, handler, flag); };
      addCleanup(id, off);
      return off;
    }

    function timer(id, fn, ms) {
      var handle = win.setInterval(fn, ms);
      var off = function () { win.clearInterval(handle); };
      addCleanup(id, off);
      timers.push(off);
      return handle;
    }

    function report(payload) {
      var result = Object.assign({ title: 'Web Developer', text: '', html: '', feature: '' }, payload || {});
      try { reportFn(result); } catch (error) { /* reporting must never break a feature */ }
      return result;
    }

    function text(title, body, feature) { return report({ title: title, text: String(body), feature: feature || '' }); }
    function html(title, body, feature) { return report({ title: title, html: String(body), feature: feature || '' }); }

    function actionButton(feature, payload, label, inputSpec, className) {
      return '<button type="button" class="' + (className || 'wd-btn') + '" data-wd-feature="' + escapeHtml(feature) +
        '" data-wd-payload="' + escapeHtml(JSON.stringify(payload || {})) + '"' +
        (inputSpec ? ' data-wd-input="' + escapeHtml(inputSpec) + '"' : '') + '>' + escapeHtml(label) + '</button>';
    }

    function persist(key, value) {
      state.saved[key] = value;
      try { persistFn(key, value); } catch (error) { /* host storage is best effort */ }
    }

    function restore(key, fallback) {
      return Object.prototype.hasOwnProperty.call(state.saved, key)
        ? state.saved[key] : (state.options[key] !== undefined ? state.options[key] : fallback);
    }

    function download(filename, content, mime) {
      try { downloadFn({ filename: filename, text: String(content), mime: mime || 'text/plain' }); }
      catch (error) { text('Download', error.message); }
    }

    function describe(el) {
      if (!el || el.nodeType !== 1) return '';
      var name = el.tagName.toLowerCase();
      var id = el.id ? '#' + el.id : '';
      var classes = el.classList && el.classList.length ? '.' + Array.prototype.join.call(el.classList, '.') : '';
      return '<' + name + id + classes + '>';
    }

    function rectOf(el) {
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      return {
        x: Math.round(rect.left + (win.pageXOffset || 0)),
        y: Math.round(rect.top + (win.pageYOffset || 0)),
        left: rect.left, top: rect.top,
        width: Math.round(rect.width), height: Math.round(rect.height)
      };
    }

    function computed(el) { return win.getComputedStyle ? win.getComputedStyle(el) : {}; }

    /** Attribute-based marking with a MutationObserver (custom elements, noindex, ...). */
    function mark(id, attr, predicate) {
      var all = [];
      function apply(el) {
        if (!notUi(el) || !predicate(el)) return;
        if (el.hasAttribute(attr)) return;
        el.setAttribute(attr, id);
        all.push(el);
      }
      elements('*').forEach(apply);
      var Observer = win.MutationObserver || win.WebKitMutationObserver;
      var observer = null;
      if (Observer) {
        observer = new Observer(function (mutations) {
          mutations.forEach(function (mutation) {
            Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
              if (node.nodeType !== 1) return;
              apply(node);
              Array.prototype.slice.call(node.querySelectorAll('*')).forEach(apply);
            });
          });
        });
        observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      }
      return function () {
        if (observer) observer.disconnect();
        all.forEach(function (el) { if (el.hasAttribute(attr)) el.removeAttribute(attr); });
      };
    }

    /** Inline badges for matched elements; `place` may be 'before' for void elements. */
    function badges(id, predicate, label, className, place) {
      var all = [];
      function apply(el) {
        if (!notUi(el) || !predicate(el)) return;
        if (el.hasAttribute('data-wd-badged') && el.getAttribute('data-wd-badged').indexOf(id) !== -1) return;
        var badge = doc.createElement('span');
        badge.setAttribute('data-wd-ui', '');
        badge.setAttribute('data-wd-badge', id);
        badge.className = 'wd-badge ' + (className || '');
        badge.textContent = label(el);
        if (place === 'before' && el.parentNode) el.parentNode.insertBefore(badge, el);
        else el.insertBefore(badge, el.firstChild);
        el.setAttribute('data-wd-badged', (el.getAttribute('data-wd-badged') || '') + ' ' + id);
        all.push({ badge: badge, el: el });
      }
      elements('*').forEach(apply);
      var Observer = win.MutationObserver || win.WebKitMutationObserver;
      var observer = null;
      if (Observer) {
        observer = new Observer(function (mutations) {
          mutations.forEach(function (mutation) {
            Array.prototype.slice.call(mutation.addedNodes || []).forEach(function (node) {
              if (node.nodeType !== 1) return;
              apply(node);
              Array.prototype.slice.call(node.querySelectorAll('*')).forEach(apply);
            });
          });
        });
        observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      }
      return function () {
        if (observer) observer.disconnect();
        all.forEach(function (entry) {
          if (entry.badge.parentNode) entry.badge.parentNode.removeChild(entry.badge);
          var value = (entry.el.getAttribute('data-wd-badged') || '').replace(id, '').trim();
          if (value) entry.el.setAttribute('data-wd-badged', value);
          else entry.el.removeAttribute('data-wd-badged');
        });
        Array.prototype.slice.call(doc.querySelectorAll('[data-wd-badge="' + id + '"]')).forEach(function (el) {
          if (el.parentNode) el.parentNode.removeChild(el);
        });
      };
    }

    /** Hover inspector: every enabled feature contributes one row to a shared panel. */
    function inspector(id, renderer) {
      inspectors[id] = renderer;
      rebuildInspector();
      return function () { delete inspectors[id]; rebuildInspector(); };
    }

    function removeInspectorListeners() {
      inspectorListeners.forEach(function (off) { off(); });
      inspectorListeners = [];
    }

    function rebuildInspector() {
      removeInspectorListeners();
      var ids = Object.keys(inspectors);
      if (!ids.length) { unoverlay('inspector'); return; }
      var panel = overlay('inspector', '', 'left:20px;top:20px;max-width:420px;max-height:60vh;overflow:auto;pointer-events:none;');
      function render(el) {
        if (!el || !notUi(el)) return;
        var body = '<div class="wd-inspector-head">' + escapeHtml(describe(el)) + '</div>';
        ids.forEach(function (key) {
          var feature = byId[key];
          var content = '';
          try { content = inspectors[key](el, ctx, feature); } catch (error) { content = '<i>' + escapeHtml(error.message) + '</i>'; }
          body += '<div class="wd-inspector-row"><b>' + escapeHtml(feature ? feature.label : key) + '</b>' + content + '</div>';
        });
        panel.innerHTML = body;
        var x = Math.min(lastMouse.x + 18, Math.max(0, (win.innerWidth || 1024) - 440));
        var y = Math.min(lastMouse.y + 18, Math.max(0, (win.innerHeight || 768) - 260));
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
      }
      var move = function (event) {
        lastMouse.x = event.clientX || 0;
        lastMouse.y = event.clientY || 0;
        var target = event.target;
        if (target && target.closest) target = target.closest('[data-wd-ui]') ? null : target;
        render(target);
      };
      doc.addEventListener('mousemove', move, true);
      inspectorListeners.push(function () { doc.removeEventListener('mousemove', move, true); });
      var leave = function () { panel.innerHTML = ''; };
      doc.addEventListener('mouseleave', leave, true);
      inspectorListeners.push(function () { doc.removeEventListener('mouseleave', leave, true); });
    }

    /** Margin/padding band overlay for the hovered element. */
    function drawBands(el) {
      if (!el || !notUi(el)) { unoverlay('bands'); return; }
      var cs = computed(el), rect = el.getBoundingClientRect();
      if (!rect) { unoverlay('bands'); return; }
      var px = function (v) { return parseFloat(v) || 0; };
      var m = { t: px(cs.marginTop), r: px(cs.marginRight), b: px(cs.marginBottom), l: px(cs.marginLeft) };
      var p = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
      var box = overlay('bands', '', 'left:0;top:0;right:0;bottom:0;border:0;background:transparent;' +
        'box-shadow:none;padding:0;border-radius:0;pointer-events:none;');
      box.innerHTML = '';
      function band(left, top, width, height, color) {
        if (width <= 0 || height <= 0) return;
        var div = doc.createElement('div');
        div.setAttribute('data-wd-ui', '');
        div.setAttribute('style', 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:' + width +
          'px;height:' + height + 'px;background:' + color + ';pointer-events:none;');
        box.appendChild(div);
      }
      var L = rect.left, T = rect.top, W = rect.width, H = rect.height;
      band(L - m.l, T - m.t, W + m.l + m.r, m.t, 'rgba(249,115,22,.38)');
      band(L - m.l, T + H, W + m.l + m.r, m.b, 'rgba(249,115,22,.38)');
      band(L - m.l, T, m.l, H, 'rgba(249,115,22,.38)');
      band(L + W, T, m.r, H, 'rgba(249,115,22,.38)');
      band(L, T, W, p.t, 'rgba(37,99,235,.38)');
      band(L, T + H - p.b, W, p.b, 'rgba(37,99,235,.38)');
      band(L, T + p.t, p.l, H - p.t - p.b, 'rgba(37,99,235,.38)');
      band(L + W - p.r, T + p.t, p.r, H - p.t - p.b, 'rgba(37,99,235,.38)');
    }

    /** Drag any overlay by its [data-wd-drag] handle, persisting the position. */
    function draggable(id, el, key) {
      if (!el) return function () {};
      var saved = restore('overlayPositions', {}) || {};
      if (saved[key]) {
        el.style.left = saved[key].x + 'px';
        el.style.top = saved[key].y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
      var start = null;
      var down = function (event) {
        if (!event.target.closest || !event.target.closest('[data-wd-drag]')) return;
        start = { x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop };
        event.preventDefault();
      };
      var move = function (event) {
        if (!start) return;
        el.style.left = Math.max(0, start.left + event.clientX - start.x) + 'px';
        el.style.top = Math.max(0, start.top + event.clientY - start.y) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      };
      var up = function () {
        if (!start) return;
        start = null;
        var positions = Object.assign({}, restore('overlayPositions', {}) || {});
        positions[key] = { x: el.offsetLeft, y: el.offsetTop };
        persist('overlayPositions', positions);
      };
      el.style.pointerEvents = 'auto';
      el.addEventListener('mousedown', down);
      doc.addEventListener('mousemove', move, true);
      doc.addEventListener('mouseup', up, true);
      return function () {
        el.removeEventListener('mousedown', down);
        doc.removeEventListener('mousemove', move, true);
        doc.removeEventListener('mouseup', up, true);
      };
    }

    function cssText(docArg) {
      var source = docArg || doc, parts = [];
      Array.prototype.slice.call(source.querySelectorAll('style')).forEach(function (el) { parts.push(el.textContent || ''); });
      Array.prototype.slice.call(source.styleSheets || []).forEach(function (sheet) {
        try {
          Array.prototype.slice.call(sheet.cssRules || []).forEach(function (rule) { parts.push(rule.cssText || ''); });
        } catch (_) { /* cross-origin sheet: the caller sees inline CSS only */ }
      });
      return parts.join('\n');
    }

    function matchedRules(el) {
      var found = [];
      Array.prototype.slice.call(doc.styleSheets || []).forEach(function (sheet) {
        var rules;
        try { rules = sheet.cssRules || []; } catch (_) { return; }
        Array.prototype.slice.call(rules).forEach(function (rule) {
          if (!rule.selectorText) return;
          try { if (el.matches(rule.selectorText)) found.push(rule.selectorText + ' { ' + (rule.style ? rule.style.cssText : '') + ' }'); }
          catch (_) { /* unsupported selector */ }
        });
      });
      return found;
    }

    var ctx = {
      win: win, doc: doc, state: state, byId: byId,
      helpers: {
        escapeHtml: escapeHtml, parseColor: parseColor, toHex: toHex, contrastRatio: contrastRatio,
        hueOf: hueOf, sortColors: sortColors, extractGradients: extractGradients, beautifyCss: beautifyCss,
        expandToolUrl: expandToolUrl, cookiesToCsv: cookiesToCsv, splitLinks: splitLinks, tidyHtml: tidyHtml,
        statusOf: statusOf, ARIA_STATES: ARIA_STATES, TYPOS: TYPOS, DEFAULT_OPTIONS: DEFAULT_OPTIONS
      },
      option: function (key, fallback) {
        return state.options[key] === undefined ? fallback : state.options[key];
      },
      report: report, text: text, html: html, actionButton: actionButton,
      persist: persist, restore: restore, download: download,
      style: style, unstyle: unstyle, overlay: overlay, unoverlay: unoverlay,
      listen: listen, timer: timer, cleanup: addCleanup, elements: elements, notUi: notUi,
      mark: mark, badges: badges, inspector: inspector, drawBands: drawBands, draggable: draggable,
      describe: describe, rectOf: rectOf, computed: computed, cssText: cssText, matchedRules: matchedRules,
      lastMouse: function () { return lastMouse; },
      isEnabled: function (id) { return !!state.enabled[id]; },
      setOptions: function (options) { Object.assign(state.options, options || {}); },
      setCookies: function (cookies) { state.cookies = cookies; },
      /** Re-run an enabled toggle when its configuration changed. */
      refresh: function (id) {
        if (!state.enabled[id]) return false;
        runCleanup(id);
        delete state.enabled[id];
        return session.enable(id);
      }
    };

    function enable(id, payload) {
      var feature = byId[id];
      if (!feature || typeof feature.apply !== 'function') return false;
      if (state.enabled[id]) return true;
      var cleanup = null;
      try { cleanup = feature.apply(ctx, payload || {}); }
      catch (error) {
        runCleanup(id);
        text(feature.label, 'Could not enable: ' + error.message, id);
        return false;
      }
      if (typeof cleanup === 'function') addCleanup(id, cleanup);
      state.enabled[id] = true;
      return true;
    }

    function disable(id) {
      if (!state.enabled[id]) return false;
      runCleanup(id);
      delete state.enabled[id];
      return true;
    }

    function run(id, payload) {
      var feature = byId[id];
      if (!feature) return { ok: false, reason: 'unknown feature' };
      if (typeof feature.execute === 'function') {
        try { feature.execute(ctx, payload || {}); return { ok: true }; }
        catch (error) { text(feature.label, 'Could not run: ' + error.message, id); return { ok: false, reason: error.message }; }
      }
      if (typeof feature.apply === 'function') {
        return { ok: true, toggled: state.enabled[id] ? (disable(id), false) : (enable(id, payload), true) };
      }
      return { ok: true, ui: feature.ui || id, delegated: true };
    }

    function destroy() {
      state.alive = false;
      Object.keys(state.enabled).forEach(disable);
      Object.keys(cleanups).forEach(runCleanup);
      removeInspectorListeners();
      timers.forEach(function (off) { off(); });
      ['core', 'inspector', 'bands'].forEach(unoverlay);
      Array.prototype.slice.call(doc.querySelectorAll('[data-wd-ui]')).forEach(function (el) {
        if (el.parentNode && /^wd-(style|overlay)-/.test(el.id || '')) el.parentNode.removeChild(el);
      });
    }

    var session = {
      enable: enable, disable: disable, run: run, toggle: function (id, payload) {
        return state.enabled[id] ? disable(id) : enable(id, payload);
      },
      isEnabled: function (id) { return !!state.enabled[id]; },
      enabled: function () { return Object.keys(state.enabled); },
      setOptions: function (options) { ctx.setOptions(options); Object.keys(state.enabled).forEach(function (id) {
        var feature = byId[id];
        if (feature && feature.refreshOnOptions) ctx.refresh(id);
      }); },
      setCookies: function (cookies) { ctx.setCookies(cookies); if (state.enabled['view-cookie-information']) run('view-cookie-information'); },
      options: function () { return Object.assign({}, state.options); },
      saved: function () { return Object.assign({}, state.saved); },
      report: report, text: text, html: html, ctx: ctx, destroy: destroy
    };

    style('core', [
      '.wd-badge{display:inline-block!important;margin:0 3px!important;padding:1px 5px!important;',
      'font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace!important;border-radius:4px!important;',
      'background:#fef08a!important;color:#422006!important;border:1px solid #ca8a04!important;',
      'vertical-align:middle!important;text-transform:none!important;letter-spacing:0!important;}',
      '.wd-badge.wd-badge-blue{background:#dbeafe!important;border-color:#2563eb!important;color:#1e3a8a!important;}',
      '.wd-badge.wd-badge-green{background:#dcfce7!important;border-color:#16a34a!important;color:#14532d!important;}',
      '.wd-badge.wd-badge-purple{background:#ede9fe!important;border-color:#7c3aed!important;color:#4c1d95!important;}',
      '.wd-badge.wd-badge-red{background:#fee2e2!important;border-color:#dc2626!important;color:#7f1d1d!important;}',
      '.wd-typo{background:#fecaca!important;color:#7f1d1d!important;text-decoration:underline wavy #dc2626!important;}',
      '.wd-inspector-head{font-weight:700;color:#0f172a;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:6px;}',
      '.wd-inspector-row{padding:3px 0;border-bottom:1px dashed #e2e8f0;}',
      '.wd-inspector-row b{display:block;color:#4338ca;font-size:10px;text-transform:uppercase;letter-spacing:.04em;}',
      '.wd-drag-handle{cursor:move;user-select:none;color:#475569;font-weight:700;}'
    ].join(''));

    return session;
  }

  return {
    ARIA_STATES: ARIA_STATES, TYPOS: TYPOS, DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    escapeHtml: escapeHtml, parseColor: parseColor, toHex: toHex, luminance: luminance,
    contrastRatio: contrastRatio, hueOf: hueOf, sortColors: sortColors,
    extractGradients: extractGradients, beautifyCss: beautifyCss, expandToolUrl: expandToolUrl,
    cookiesToCsv: cookiesToCsv, splitLinks: splitLinks, tidyHtml: tidyHtml, statusOf: statusOf,
    createSession: createSession
  };
});
