/*!
 * Web Developer tool — feature registry and implementations.
 *
 * One registry drives the standalone dashboard, the Chrome extension popup and the Node
 * test suite. Every item on the Web Developer "to do" list that was requested is present
 * here with its original upstream anchor, plus the base features those enhancements build
 * on. `apply` = stateful toggle (returns/register a cleanup), `execute` = one-shot action,
 * `ui` = a dashboard-level capability implemented in dashboard.js.
 */
(function (root, factory) {
  'use strict';
  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.WebDeveloperCore;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WebDeveloper = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  var escapeHtml = core.escapeHtml;
  var TODO = 'https://chrispederick.com/work/web-developer/to-do/#to-do-';
  var F = [];

  function add(def) { F.push(def); return def; }
  function feature(id, label, anchor, description, extra) {
    return add(Object.assign({
      id: id, label: label, url: TODO + anchor, category: 'Common', group: 'feature',
      mode: 'toggle', description: description, how: 'Toggle it on, hover the demo page, toggle it off to restore.'
    }, extra || {}));
  }
  function enhancement(id, label, anchor, description, ui) {
    return add({
      id: id, label: label, url: TODO + anchor, category: 'Common', group: 'enhancement',
      mode: 'ui', ui: ui, description: description,
      how: 'Delivered as part of the upgraded feature; see the linked base feature in the catalog.'
    });
  }
  function platform(id, label, anchor, description, ui, category) {
    return add({
      id: id, label: label, url: TODO + anchor, category: category || 'Common', group: 'platform',
      mode: 'ui', ui: ui, description: description,
      how: 'Dashboard-level capability: configure it in the Options / Templates / Tools tabs.'
    });
  }
  function base(id, label, description, mode) {
    return add({
      id: id, label: label, url: '', category: 'Common', group: 'base', mode: mode || 'toggle',
      description: description, how: 'Base feature rebuilt so the requested enhancement has a real implementation.'
    });
  }

  /* ------------------------------------------------------------ small helpers */

  function table(headers, rows, className) {
    var head = '<thead><tr>' + headers.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join('') + '</tr></thead>';
    var body = '<tbody>' + rows.map(function (row) {
      return '<tr>' + row.map(function (cell) { return '<td>' + (cell === null || cell === undefined ? '' : cell) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    return '<table class="wd-table ' + (className || '') + '">' + head + body + '</table>';
  }

  function chip(color) {
    var safe = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+\([^)'";]*\)|[a-zA-Z]+)$/.test(String(color || '').trim()) ? color : '#ccc';
    return '<span class="wd-chip" style="background:' + escapeHtml(safe) + '"></span>';
  }

  function pre(text) { return '<pre class="wd-pre">' + escapeHtml(text) + '</pre>'; }
  function note(text) { return '<p class="wd-note">' + escapeHtml(text) + '</p>'; }
  function actions(items) { return '<div class="wd-panel-actions">' + items.join('') + '</div>'; }
  function fmt(value) { return Math.round((Number(value) || 0) * 100) / 100; }

  function pageUrl(ctx) {
    try { return ctx.win.location.href || ''; } catch (_) { return ''; }
  }

  /* Build a lens snapshot with DOM nodes, never with an HTML string: regex-stripping
     <script> out of markup misses closing tags with whitespace and leaves inline
     handlers behind. Cloned nodes are imported into the lens document and scripts /
     on* attributes are removed through the DOM API before insertion. */
  function stripInteractive(root) {
    if (!root.querySelectorAll) return;
    Array.prototype.slice.call(root.querySelectorAll('script')).forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function (el) {
      Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
        if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  function fillMagnifier(ctx, frame) {
    var target = frame.contentDocument;
    if (!target || !target.head || !target.body || target.body.hasAttribute('data-wd-snapshot')) return;
    target.body.setAttribute('data-wd-snapshot', '');
    Array.prototype.slice.call(ctx.doc.head.querySelectorAll('style, link[rel~="stylesheet"]')).forEach(function (node) {
      var copy = target.importNode(node, true);
      stripInteractive(copy);
      target.head.appendChild(copy);
    });
    Array.prototype.slice.call(ctx.doc.body.childNodes).forEach(function (node) {
      if (node.nodeType !== 1) return;
      if (node.tagName === 'SCRIPT' || node.hasAttribute('data-wd-ui')) return;
      var copy = target.importNode(node, true);
      stripInteractive(copy);
      target.body.appendChild(copy);
    });
  }

  function stylesheets(ctx) {
    var list = [];
    Array.prototype.slice.call(ctx.doc.querySelectorAll('link[rel~="stylesheet"]')).forEach(function (el, index) {
      list.push({ type: 'link', el: el, index: index, label: el.getAttribute('href') || '(inline link)', href: el.href || el.getAttribute('href') });
    });
    Array.prototype.slice.call(ctx.doc.querySelectorAll('style')).forEach(function (el, index) {
      if (el.id && el.id.indexOf('wd-style-') === 0) return;
      list.push({ type: 'style', el: el, index: index, label: 'Inline <style> #' + (index + 1), href: '' });
    });
    return list;
  }

  function sheetDisabled(sheet) {
    if (sheet.type === 'link') return sheet.el.disabled === true || sheet.el.getAttribute('media') === 'not all';
    return sheet.el.getAttribute('data-wd-disabled') === 'true';
  }

  function setSheetDisabled(ctx, sheet, disabled) {
    if (sheet.type === 'link') {
      if (disabled) {
        if (sheet.el.getAttribute('data-wd-media') === null) sheet.el.setAttribute('data-wd-media', sheet.el.getAttribute('media') || '');
        sheet.el.setAttribute('media', 'not all');
        sheet.el.disabled = true;
      } else {
        sheet.el.disabled = false;
        var media = sheet.el.getAttribute('data-wd-media');
        if (media === null || media === '') sheet.el.removeAttribute('media');
        else sheet.el.setAttribute('media', media);
        sheet.el.removeAttribute('data-wd-media');
      }
    } else {
      if (disabled) {
        if (!sheet.el.hasAttribute('data-wd-original-css')) sheet.el.setAttribute('data-wd-original-css', sheet.el.textContent);
        sheet.el.textContent = '';
        sheet.el.setAttribute('data-wd-disabled', 'true');
      } else {
        sheet.el.textContent = sheet.el.getAttribute('data-wd-original-css') || '';
        sheet.el.removeAttribute('data-wd-original-css');
        sheet.el.removeAttribute('data-wd-disabled');
      }
    }
  }

  /** MIME-type warning for Edit CSS / Disable Individual Stylesheet (async, best effort). */
  function checkMimeTypes(ctx, title) {
    var links = stylesheets(ctx).filter(function (sheet) { return sheet.type === 'link' && sheet.href; });
    var fetchFn = ctx.win.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn || !links.length) return;
    Promise.all(links.map(function (sheet) {
      return fetchFn.call(ctx.win, sheet.href, { method: 'HEAD' }).then(function (response) {
        var type = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
        return type && !/text\/css/i.test(type) ? { sheet: sheet, type: type } : null;
      }).catch(function () { return null; });
    })).then(function (warnings) {
      if (!ctx.state.alive) return;
      var found = warnings.filter(Boolean);
      if (!found.length) return;
      ctx.html(title + ' — stylesheet MIME types',
        '<p class="wd-warning">These stylesheets were not served as <code>text/css</code>; browsers may ignore them:</p>' +
        table(['Stylesheet', 'Content-Type'], found.map(function (w) {
          return [escapeHtml(w.sheet.label), '<code>' + escapeHtml(w.type) + '</code>'];
        })), title);
    });
  }

  function cookieRecords(ctx) {
    if (ctx.state.cookies && ctx.state.cookies.length) return ctx.state.cookies;
    var raw = '';
    try { raw = ctx.doc.cookie || ''; } catch (_) { raw = ''; }
    return raw.split(';').map(function (part) { return part.trim(); }).filter(Boolean).map(function (part) {
      var at = part.indexOf('=');
      return {
        name: at === -1 ? part : part.slice(0, at),
        value: at === -1 ? '' : decodeURIComponent(part.slice(at + 1)),
        domain: '', path: '/', expires: '', secure: false, httpOnly: false,
        sameSite: 'unavailable (document.cookie)'
      };
    });
  }

  function linkRecords(ctx) {
    return ctx.elements('a[href]').map(function (el) {
      return {
        href: el.getAttribute('href') || '', text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        title: el.getAttribute('title') || '', target: el.getAttribute('target') || '',
        rel: el.getAttribute('rel') || '', id: el.id || ''
      };
    });
  }

  function imageRecords(ctx) {
    return ctx.elements('img').map(function (el) {
      var rect = ctx.rectOf(el);
      return {
        src: el.getAttribute('src') || '', alt: el.getAttribute('alt') || '', title: el.getAttribute('title') || '',
        natural: (el.naturalWidth || 0) + ' × ' + (el.naturalHeight || 0),
        displayed: rect.width + ' × ' + rect.height,
        width: el.getAttribute('width') || '', height: el.getAttribute('height') || '',
        loading: el.getAttribute('loading') || '', srcset: el.getAttribute('srcset') || ''
      };
    });
  }

  function colorRecords(ctx) {
    var found = {}, gradients = core.extractGradients(ctx.cssText());
    function put(value, source) {
      var text = String(value || '').trim();
      if (!text || text === 'transparent' || !core.parseColor(text)) return;
      var key = text.toLowerCase();
      if (!found[key]) found[key] = { value: text, count: 0, sources: [] };
      found[key].count += 1;
      if (found[key].sources.indexOf(source) === -1) found[key].sources.push(source);
    }
    ctx.elements('*').forEach(function (el) {
      var cs = ctx.computed(el);
      ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor'].forEach(function (prop) {
        var value = cs[prop];
        if (value && String(value).indexOf('gradient') === -1) put(value, 'computed style');
      });
      if (el.hasAttribute('style')) {
        var inline = el.getAttribute('style');
        (inline.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || []).forEach(function (value) { put(value, 'inline style'); });
      }
    });
    (ctx.cssText().match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || []).forEach(function (value) { put(value, 'stylesheet'); });
    return { colors: Object.keys(found).map(function (key) { return found[key]; }), gradients: gradients };
  }

  function effectiveBackground(ctx, el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var bg = ctx.computed(node).backgroundColor;
      if (bg && core.parseColor(bg) && core.parseColor(bg)[3] > 0) return bg;
      node = node.parentNode;
    }
    return 'rgb(255, 255, 255)';
  }

  function a11yIssues(ctx) {
    var issues = [];
    function push(severity, rule, element, detail) { issues.push({ severity: severity, rule: rule, element: element, detail: detail }); }
    if (!ctx.doc.documentElement.hasAttribute('lang')) push('error', 'html lang', 'html', 'Document language is missing.');
    if (!ctx.elements('h1').length) push('warning', 'h1', 'document', 'No level-one heading found.');
    ctx.elements('img').forEach(function (el) {
      if (!el.hasAttribute('alt')) push('error', 'image alt', ctx.describe(el), 'Image has no alt attribute.');
    });
    ctx.elements('input, select, textarea').forEach(function (el) {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset'].indexOf(type) !== -1) return;
      var id = el.getAttribute('id');
      var labelled = (id && ctx.doc.querySelector('label[for="' + id + '"]')) || (el.closest && el.closest('label')) ||
        el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title');
      if (!labelled) push('error', 'form label', ctx.describe(el), 'Control has no associated label.');
    });
    ctx.elements('a[href]').forEach(function (el) {
      if (!(el.textContent || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !ctx.elements('img[alt]', el).length) {
        push('error', 'link text', ctx.describe(el), 'Link has no discernible text.');
      }
    });
    ctx.elements('button').forEach(function (el) {
      if (!(el.textContent || '').trim() && !el.getAttribute('aria-label')) push('warning', 'button text', ctx.describe(el), 'Button has no text.');
    });
    var seen = {};
    ctx.elements('[id]').forEach(function (el) {
      var id = el.id;
      if (seen[id]) push('error', 'duplicate id', ctx.describe(el), 'Duplicate id "' + id + '".');
      seen[id] = true;
    });
    ctx.elements('table').forEach(function (el) {
      if (!ctx.elements('th, [scope]', el).length) push('warning', 'table headers', ctx.describe(el), 'Table has no header cells.');
    });
    ctx.elements('p, span, a, li, h1, h2, h3, h4, h5, h6, button, label').forEach(function (el) {
      var text = (el.textContent || '').trim();
      if (!text) return;
      var ratio = core.contrastRatio(ctx.computed(el).color, effectiveBackground(ctx, el));
      if (ratio !== null && ratio < 4.5) push('warning', 'contrast', ctx.describe(el), 'Contrast ' + ratio + ':1 is below WCAG AA (4.5:1).');
    });
    return issues;
  }

  function htmlIssues(ctx, source) {
    var issues = [];
    if (!/^\s*<!doctype/i.test(ctx.doc.doctype ? '<!doctype html>' : source || '')) issues.push('Missing doctype declaration (standards mode may be lost).');
    if (ctx.doc.compatMode === 'BackCompat') issues.push('Document is in quirks mode.');
    var seen = {};
    ctx.elements('[id]').forEach(function (el) {
      if (seen[el.id]) issues.push('Duplicate id "' + el.id + '".');
      seen[el.id] = true;
    });
    ctx.elements('p > div, span > div, p > p').forEach(function (el) { issues.push('Invalid nesting near ' + ctx.describe(el) + '.'); });
    ['font', 'center', 'marquee', 'blink', 'big'].forEach(function (tag) {
      var found = ctx.elements(tag);
      if (found.length) issues.push('Obsolete element <' + tag + '> used ' + found.length + ' time(s).');
    });
    ctx.elements('img').forEach(function (el) { if (!el.hasAttribute('alt')) issues.push('Image ' + ctx.describe(el) + ' has no alt attribute.'); });
    return issues;
  }

  function cssIssues(ctx, css) {
    var issues = [];
    var opens = (css.match(/{/g) || []).length, closes = (css.match(/}/g) || []).length;
    if (opens !== closes) issues.push('Unbalanced braces: ' + opens + ' opening, ' + closes + ' closing.');
    if (/!important\s*!important/.test(css)) issues.push('Duplicated !important declaration.');
    var unknown = css.match(/([a-zA-Z-]+)\s*:\s*[^;{}]*;?/g) || [];
    if (unknown.length > 400) issues.push('Very large stylesheet (' + unknown.length + ' declarations): consider splitting.');
    if (!css.trim()) issues.push('No CSS found on this page.');
    return issues;
  }

  function remoteValidate(ctx, url, kind, source) {
    var endpoint = core.expandToolUrl(url, pageUrl(ctx));
    var fetchFn = ctx.win.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) { ctx.text('Validate Local ' + kind, 'Remote validator configured but fetch is unavailable in this runtime.', 'validate-local-' + kind.toLowerCase()); return; }
    ctx.report({ title: 'Validate Local ' + kind, text: 'Contacting ' + endpoint + ' …', feature: 'validate-local-' + kind.toLowerCase() });
    fetchFn.call(ctx.win, endpoint, {
      method: 'POST', headers: { 'Content-Type': kind === 'CSS' ? 'text/css' : 'text/html' }, body: source
    }).then(function (response) {
      return response.text().then(function (body) { return { status: response.status, body: body }; });
    }).then(function (result) {
      if (!ctx.state.alive) return;
      ctx.html('Validate Local ' + kind + ' — validator response',
        note('Configured validator: ' + endpoint + ' (HTTP ' + result.status + ')') + pre(result.body.slice(0, 20000)),
        'validate-local-' + kind.toLowerCase());
    }).catch(function (error) {
      if (!ctx.state.alive) return;
      ctx.text('Validate Local ' + kind, 'Configured validator failed: ' + error.message + '. Falling back to local checks is available by clearing the validator URL.', 'validate-local-' + kind.toLowerCase());
    });
  }

  /* ---------------------------------------------- requested features (Common) */

  feature('auto-reload', 'Auto Reload', '81b599754b',
    'Reload the page automatically on a configurable interval, with a visible countdown and pause control.', {
      refreshOnOptions: true,
      apply: function (ctx) {
        var seconds = Math.max(3, Number(ctx.option('autoReloadSeconds', 30)) || 30);
        var remaining = seconds, paused = false;
        var panel = ctx.overlay('auto-reload', '', 'right:16px;bottom:16px;min-width:180px;');
        function paint() {
          panel.innerHTML = '<b>Auto Reload</b><br>' + (paused ? 'Paused' : 'Reload in ' + remaining + 's') +
            '<br><small>interval: ' + seconds + 's</small>';
        }
        paint();
        ctx.timer('auto-reload', function () {
          if (paused) { paint(); return; }
          remaining -= 1;
          if (remaining <= 0) {
            remaining = seconds;
            try { ctx.win.location.reload(); }
            catch (error) { ctx.text('Auto Reload', 'Reload blocked by this runtime (' + error.message + '). Countdown continues.', 'auto-reload'); }
          }
          paint();
        }, 1000);
        ctx.state.autoReload = {
          pause: function () { paused = !paused; paint(); return paused; },
          now: function () { try { ctx.win.location.reload(); } catch (error) { return error.message; } return 'reloading'; }
        };
        return function () { ctx.unoverlay('auto-reload'); delete ctx.state.autoReload; };
      },
      execute: function (ctx, payload) {
        if (payload.now) ctx.text('Auto Reload', ctx.state.autoReload ? ctx.state.autoReload.now() : 'Enable Auto Reload first.', 'auto-reload');
        else if (payload.pause !== undefined) ctx.text('Auto Reload', ctx.state.autoReload && ctx.state.autoReload.pause() ? 'Paused.' : 'Resumed.', 'auto-reload');
        ctx.html('Auto Reload', note('The countdown overlay lives in the inspected page.') + actions([
          ctx.actionButton('auto-reload', { pause: true }, 'Pause / resume'),
          ctx.actionButton('auto-reload', { now: true }, 'Reload now')
        ]), 'auto-reload');
      }
    });

  feature('check-spelling', 'Check Spelling', '2f1912628a',
    'Turn on browser spellcheck for editable fields and highlight common misspellings in page text.', {
      apply: function (ctx) {
        var edits = [], replacements = [], found = [];
        ctx.elements('input, textarea, [contenteditable]').forEach(function (el) {
          edits.push([el, el.getAttribute('spellcheck')]);
          el.setAttribute('spellcheck', 'true');
        });
        var typoPattern = new RegExp('\\b(' + Object.keys(core.TYPOS).join('|') + ')\\b', 'gi');
        var filter = ctx.win.NodeFilter ? ctx.win.NodeFilter.SHOW_TEXT : 4;
        var walker = ctx.doc.createTreeWalker(ctx.doc.body, filter, null, false);
        var nodes = [], node;
        while ((node = walker.nextNode())) nodes.push(node);
        nodes.forEach(function (textNode) {
          if (!textNode.parentNode || !ctx.notUi(textNode.parentNode)) return;
          if (/^(script|style|textarea)$/i.test(textNode.parentNode.tagName || '')) return;
          var value = textNode.nodeValue || '';
          typoPattern.lastIndex = 0;
          if (!typoPattern.test(value)) return;
          typoPattern.lastIndex = 0;
          var html = value.replace(typoPattern, function (word) {
            found.push(word + ' → ' + core.TYPOS[word.toLowerCase()]);
            return '<span class="wd-typo">' + escapeHtml(word) + '</span>';
          });
          var span = ctx.doc.createElement('span');
          span.setAttribute('data-wd-ui', '');
          span.innerHTML = html;
          textNode.parentNode.replaceChild(span, textNode);
          replacements.push([span, textNode]);
        });
        ctx.text('Check Spelling',
          'Spellcheck enabled on ' + edits.length + ' editable field(s). ' +
          (found.length ? 'Possible misspellings: ' + found.join(', ') : 'No common misspellings found.'), 'check-spelling');
        return function () {
          edits.forEach(function (entry) {
            if (entry[1] === null) entry[0].removeAttribute('spellcheck');
            else entry[0].setAttribute('spellcheck', entry[1]);
          });
          replacements.forEach(function (entry) {
            if (entry[0].parentNode) entry[0].parentNode.replaceChild(entry[1], entry[0]);
          });
        };
      }
    });

  feature('clean-submit', 'Clean Submit', '96f6b3e49f',
    'Strip inline JavaScript handlers and javascript: actions from forms so a form can be submitted cleanly.', {
      apply: function (ctx) {
        var saved = [], attrs = ['onsubmit', 'onreset', 'onclick', 'onchange', 'oninput', 'onfocus', 'onblur'];
        ctx.elements('form, form *').forEach(function (el) {
          attrs.forEach(function (attr) {
            if (el.hasAttribute(attr)) { saved.push([el, attr, el.getAttribute(attr)]); el.removeAttribute(attr); }
          });
          if (/^javascript:/i.test(el.getAttribute('action') || '')) {
            saved.push([el, 'action', el.getAttribute('action')]);
            el.setAttribute('action', '');
          }
        });
        ctx.text('Clean Submit', 'Removed ' + saved.length + ' inline handler(s) / javascript: action(s) from forms.', 'clean-submit');
        return function () { saved.forEach(function (entry) { entry[0].setAttribute(entry[1], entry[2]); }); };
      }
    });

  feature('disable-css3-styles', 'Disable CSS3 Styles', 'c5890226a7',
    'Override CSS3 visuals (radius, shadows, transforms, transitions, animations, gradients, grid/flex, filters).', {
      apply: function (ctx) {
        ctx.style('disable-css3-styles', [
          '*:not([data-wd-ui]){',
          'border-radius:0!important;box-shadow:none!important;text-shadow:none!important;',
          'transform:none!important;transition:none!important;animation:none!important;',
          'background-image:none!important;filter:none!important;backdrop-filter:none!important;',
          'opacity:1!important;columns:auto!important;column-count:auto!important;',
          'text-overflow:clip!important;appearance:auto!important;',
          'mask-image:none!important;clip-path:none!important;mix-blend-mode:normal!important;}',
          /* Flex/grid are CSS3 layout modes: flatten them to normal block flow, but never
             touch <head>, scripts or the tool's own overlay elements. */
          'body *:not([data-wd-ui]):not(script):not(style){display:block!important;}'
        ].join(''));
        return function () { ctx.unstyle('disable-css3-styles'); };
      }
    });

  feature('disable-html5-form-validation', 'Disable HTML5 Form Validation', '0992cb467b',
    'Add novalidate to every form and formnovalidate to submit controls; restore the original attributes on disable.', {
      apply: function (ctx) {
        var saved = [];
        ctx.elements('form').forEach(function (el) {
          saved.push([el, 'novalidate', el.getAttribute('novalidate')]);
          el.setAttribute('novalidate', '');
        });
        ctx.elements('button, input').forEach(function (el) {
          if ((el.getAttribute('type') || '').toLowerCase() === 'submit' || el.tagName === 'BUTTON') {
            saved.push([el, 'formnovalidate', el.getAttribute('formnovalidate')]);
            el.setAttribute('formnovalidate', '');
          }
        });
        return function () {
          saved.forEach(function (entry) {
            if (entry[2] === null) entry[0].removeAttribute(entry[1]); else entry[0].setAttribute(entry[1], entry[2]);
          });
        };
      }
    });

  feature('disable-individual-stylesheet', 'Disable Individual Stylesheet', 'd03ac8b65e',
    'List every linked and inline stylesheet and disable/enable them one at a time, with MIME-type diagnostics.', {
      mode: 'action',
      execute: function (ctx, payload) {
        var sheets = stylesheets(ctx), changed = null;
        if (payload && payload.index !== undefined) {
          var sheet = sheets[Number(payload.index)];
          if (sheet) {
            var next = payload.disabled === undefined ? !sheetDisabled(sheet) : !!payload.disabled;
            setSheetDisabled(ctx, sheet, next);
            changed = sheet.label + (next ? ' disabled' : ' enabled');
          }
        }
        checkMimeTypes(ctx, 'Disable Individual Stylesheet');
        var rows = sheets.map(function (item, index) {
          var disabled = sheetDisabled(item);
          return [
            escapeHtml(item.label), item.type,
            disabled ? '<span class="wd-state-off">disabled</span>' : '<span class="wd-state-on">active</span>',
            ctx.actionButton('disable-individual-stylesheet', { index: index, disabled: !disabled }, disabled ? 'Enable' : 'Disable')
          ];
        });
        ctx.html('Disable Individual Stylesheet',
          (changed ? note(changed) : note(sheets.length + ' stylesheet(s) on this page. MIME warnings, if any, appear as a follow-up report.')) +
          table(['Stylesheet', 'Type', 'State', ''], rows) +
          actions([ctx.actionButton('edit-css', {}, 'Open Edit CSS →')]), 'disable-individual-stylesheet');
      }
    });

  feature('display-aria-attributes', 'Display ARIA Attributes', '7091c34a42',
    'Show every aria-* attribute (roles, labels and relationships) as an inline badge on its element.', {
      apply: function (ctx) {
        function predicate(el) {
          return Array.prototype.slice.call(el.attributes || []).some(function (a) { return /^aria-|^role$/i.test(a.name); });
        }
        function label(el) {
          return Array.prototype.slice.call(el.attributes || []).filter(function (a) { return /^aria-|^role$/i.test(a.name); })
            .slice(0, 2).map(function (a) { return a.name + '=' + a.value; }).join(' ');
        }
        return ctx.badges('display-aria-attributes', predicate, label, 'wd-badge-purple');
      }
    });

  feature('display-aria-states-properties', 'Display ARIA States and Properties', 'a4a8e3a66f',
    'Show only ARIA states and properties (checked, expanded, selected, hidden, value, …) as inline badges.', {
      apply: function (ctx) {
        var names = core.ARIA_STATES;
        function predicate(el) { return names.some(function (name) { return el.hasAttribute(name); }); }
        function label(el) {
          return names.filter(function (name) { return el.hasAttribute(name); }).slice(0, 2)
            .map(function (name) { return name + '=' + el.getAttribute(name); }).join(' ');
        }
        return ctx.badges('display-aria-states-properties', predicate, label, 'wd-badge-blue');
      }
    });

  feature('display-baseline-grid', 'Display Baseline Grid', '4f71d25cdd',
    'Overlay a repeating horizontal baseline with a configurable height and colour.', {
      refreshOnOptions: true,
      apply: function (ctx) {
        var height = Math.max(6, Number(ctx.option('baselineHeight', 24)) || 24);
        var color = ctx.option('baselineColor', 'rgba(220,38,38,.35)');
        ctx.overlay('baseline-grid', '',
          'left:0;top:0;right:0;bottom:0;border:0;border-radius:0;padding:0;background:' + color +
          ' repeating-linear-gradient(to bottom,' + color + ' 0,' + color + ' 1px,transparent 1px,transparent ' + height + 'px);' +
          'background-size:100% ' + height + 'px;pointer-events:none;');
        ctx.text('Display Baseline Grid', 'Baseline height: ' + height + 'px. Change it in Options and re-toggle.', 'display-baseline-grid');
        return function () { ctx.unoverlay('baseline-grid'); };
      }
    });

  feature('display-canonical-url', 'Display Canonical URL', '1800680305',
    'Show the canonical <link> URL (and <base> URL) in a floating, draggable overlay.', {
      apply: function (ctx) {
        var canonical = ctx.doc.querySelector('link[rel~="canonical"]');
        var base = ctx.doc.querySelector('base[href]');
        var href = canonical ? canonical.getAttribute('href') : '(no canonical URL declared)';
        var panel = ctx.overlay('canonical-url',
          '<span class="wd-drag-handle" data-wd-drag>⠿ Canonical URL</span><br><code>' + escapeHtml(href) + '</code>' +
          (base ? '<br><small>base: ' + escapeHtml(base.getAttribute('href')) + '</small>' : ''),
          'right:16px;top:16px;max-width:60vw;word-break:break-all;');
        var off = ctx.option('repositionDashboard', true) ? ctx.draggable('display-canonical-url', panel, 'canonical') : function () {};
        return function () { off(); ctx.unoverlay('canonical-url'); };
      }
    });

  feature('display-event-information', 'Display Event Information', 'e1b1e5ebaf',
    'Badge inline event handlers, log click/change/input/focus/submit events, and show them in the hover inspector.', {
      apply: function (ctx) {
        var log = [];
        function predicate(el) {
          return Array.prototype.slice.call(el.attributes || []).some(function (a) { return /^on/i.test(a.name); });
        }
        function label(el) {
          return Array.prototype.slice.call(el.attributes || []).filter(function (a) { return /^on/i.test(a.name); })
            .map(function (a) { return a.name; }).join(', ');
        }
        var offBadges = ctx.badges('display-event-information', predicate, label, 'wd-badge-blue');
        var types = ['click', 'change', 'input', 'focus', 'submit', 'mouseover'];
        types.forEach(function (type) {
          ctx.listen('display-event-information', ctx.doc, type, function (event) {
            if (!ctx.notUi(event.target)) return;
            var key = ctx.describe(event.target);
            var entry = log.filter(function (item) { return item.key === key && item.type === type; })[0];
            if (entry) entry.count += 1;
            else log.push({ key: key, type: type, count: 1 });
            if (log.length > 40) log.shift();
          }, true);
        });
        var offInspector = ctx.inspector('display-event-information', function (el) {
          var inline = Array.prototype.slice.call(el.attributes || []).filter(function (a) { return /^on/i.test(a.name); })
            .map(function (a) { return a.name + '=' + a.value; });
          var observed = log.filter(function (item) { return item.key === ctx.describe(el); });
          return '<div>' + (inline.length ? '<code>' + escapeHtml(inline.join(' · ')) + '</code>' : '<i>no inline handlers</i>') + '</div>' +
            (observed.length ? '<div>observed: ' + escapeHtml(observed.map(function (i) { return i.type + ' ×' + i.count; }).join(', ')) + '</div>' : '');
        });
        return function () { offBadges(); offInspector(); };
      }
    });

  feature('display-margin-padding', 'Display Margin & Padding', '2e27dad059',
    'Draw translucent bands for the hovered element’s margin (orange) and padding (blue) and list the computed values.', {
      apply: function (ctx) {
        var offInspector = ctx.inspector('display-margin-padding', function (el) {
          var cs = ctx.computed(el);
          return '<div>margin: ' + escapeHtml([cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].join(' ')) +
            '</div><div>padding: ' + escapeHtml([cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' ')) + '</div>';
        });
        ctx.listen('display-margin-padding', ctx.doc, 'mousemove', function (event) {
          var target = event.target;
          if (target && target.closest && target.closest('[data-wd-ui]')) { ctx.unoverlay('bands'); return; }
          ctx.drawBands(target);
        }, true);
        return function () { offInspector(); ctx.unoverlay('bands'); };
      }
    });

  feature('display-page-magnifier', 'Display Page Magnifier', '2b9b0d928e',
    'Follow the pointer with a lens that shows a scaled snapshot of the page (scripts stripped).', {
      refreshOnOptions: true,
      apply: function (ctx) {
        var scale = Math.max(1.25, Number(ctx.option('magnifierScale', 2)) || 2);
        var size = Math.max(120, Number(ctx.option('magnifierSize', 220)) || 220);
        var lens = ctx.overlay('magnifier', '',
          'width:' + size + 'px;height:' + size + 'px;padding:0;overflow:hidden;border-radius:50%;border:3px solid #4338ca;pointer-events:none;');
        var frame = ctx.doc.createElement('iframe');
        frame.setAttribute('data-wd-ui', '');
        frame.setAttribute('title', 'Page magnifier');
        frame.setAttribute('style', 'border:0;position:absolute;top:0;left:0;transform-origin:0 0;pointer-events:none;');
        frame.style.width = (ctx.win.innerWidth || 1024) + 'px';
        frame.style.height = (ctx.win.innerHeight || 768) + 'px';
        // A fixed, empty srcdoc: page content reaches the lens only as cloned DOM nodes.
        frame.setAttribute('srcdoc', '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
        var snapshot = function () { fillMagnifier(ctx, frame); };
        frame.addEventListener('load', snapshot);
        lens.appendChild(frame);
        snapshot();
        var mouse = ctx.lastMouse();
        function move(event) {
          var x = event.clientX || 0, y = event.clientY || 0;
          mouse.x = x; mouse.y = y;
          lens.style.left = Math.min(x + 18, (ctx.win.innerWidth || 1024) - size - 8) + 'px';
          lens.style.top = Math.min(y + 18, (ctx.win.innerHeight || 768) - size - 8) + 'px';
          frame.style.transform = 'scale(' + scale + ') translate(' + (size / (2 * scale) - x) + 'px,' + (size / (2 * scale) - y) + 'px)';
        }
        ctx.listen('display-page-magnifier', ctx.doc, 'mousemove', move, true);
        return function () { ctx.unoverlay('magnifier'); };
      }
    });

  feature('display-screen-size-overlay', 'Display Screen Size Overlay', '42aec15c1f',
    'Show live viewport size, device pixel ratio and orientation in a draggable overlay.', {
      apply: function (ctx) {
        var panel = ctx.overlay('screen-size', '', 'right:16px;top:16px;min-width:150px;');
        function paint() {
          var w = ctx.win.innerWidth || 0, h = ctx.win.innerHeight || 0;
          panel.innerHTML = '<span class="wd-drag-handle" data-wd-drag>⠿ Screen Size</span><br><b>' + w + ' × ' + h + '</b>' +
            '<br><small>DPR ' + (ctx.win.devicePixelRatio || 1) + ' · ' + (w >= h ? 'landscape' : 'portrait') + '</small>';
        }
        paint();
        ctx.listen('display-screen-size-overlay', ctx.win, 'resize', paint, false);
        var off = ctx.option('repositionDashboard', true) ? ctx.draggable('display-screen-size-overlay', panel, 'screenSize') : function () {};
        return function () { off(); ctx.unoverlay('screen-size'); };
      }
    });

  feature('display-style-information', 'Display Style Information', '73827da105',
    'Hover any element to see its inline style, matching stylesheet rules and computed highlights.', {
      apply: function (ctx) {
        return ctx.inspector('display-style-information', function (el) {
          var rules = ctx.matchedRules(el);
          var cs = ctx.computed(el);
          return '<div>inline: <code>' + escapeHtml(el.getAttribute('style') || '(none)') + '</code></div>' +
            '<div>display: ' + escapeHtml(cs.display) + ' · position: ' + escapeHtml(cs.position) + '</div>' +
            (rules.length ? '<div>' + rules.slice(0, 5).map(function (rule) { return '<code>' + escapeHtml(rule) + '</code>'; }).join('<br>') + '</div>' : '<div><i>no matching stylesheet rules</i></div>');
        });
      }
    });

  feature('edit-html', 'Edit HTML', '31472327c6',
    'Edit the document body source in a live editor, then apply or discard the change.', {
      mode: 'action',
      execute: function (ctx, payload) {
        if (payload && typeof payload.html === 'string') {
          ctx.doc.body.innerHTML = payload.html;
          ctx.text('Edit HTML', 'Body source replaced (' + payload.html.length + ' characters). Toggle features off/on to refresh their markers.', 'edit-html');
          return;
        }
        var source = ctx.doc.body.innerHTML;
        ctx.html('Edit HTML',
          note('Editing the body of the inspected page. Scripts are not re-executed; use the preview reload button to restore the demo.') +
          '<textarea id="wd-edit-html" class="wd-editor" spellcheck="false">' + escapeHtml(source) + '</textarea>' +
          actions([
            ctx.actionButton('edit-html', { html: '' }, 'Apply changes', 'html:wd-edit-html', 'wd-btn wd-btn-primary'),
            ctx.actionButton('edit-html', {}, 'Cancel')
          ]), 'edit-html');
      }
    });

  feature('enable-paste', 'Enable Paste', 'e2f346b5b9',
    'Remove copy/paste blockers and stop page handlers from swallowing paste, copy, cut and context-menu events.', {
      apply: function (ctx) {
        var saved = [], attrs = ['onpaste', 'oncopy', 'oncut', 'oncontextmenu', 'onbeforeinput'];
        ctx.elements('*').forEach(function (el) {
          attrs.forEach(function (attr) {
            if (el.hasAttribute(attr)) { saved.push([el, attr, el.getAttribute(attr)]); el.removeAttribute(attr); }
          });
        });
        ['paste', 'copy', 'cut', 'contextmenu'].forEach(function (type) {
          ctx.listen('enable-paste', ctx.doc, type, function (event) { event.stopPropagation(); }, true);
        });
        ctx.text('Enable Paste', 'Removed ' + saved.length + ' clipboard blocker(s); paste/copy/cut events now reach the browser default.', 'enable-paste');
        return function () { saved.forEach(function (entry) { entry[0].setAttribute(entry[1], entry[2]); }); };
      }
    });

  feature('flip-images', 'Flip Images', '8b6abcbc53',
    'Flip every image horizontally, vertically or both (configurable in Options).', {
      refreshOnOptions: true,
      apply: function (ctx) {
        var direction = ctx.option('flipDirection', 'horizontal');
        var transform = direction === 'vertical' ? 'scaleY(-1)' : direction === 'both' ? 'scale(-1,-1)' : 'scaleX(-1)';
        ctx.style('flip-images', 'img:not([data-wd-ui]){transform:' + transform + '!important;}');
        return function () { ctx.unstyle('flip-images'); };
      }
    });

  feature('make-content-editable', 'Make Content Editable', '05f78ad514',
    'Toggle body contenteditable on, preserving the previous value when it is switched off.', {
      apply: function (ctx) {
        var body = ctx.doc.body, previous = body.getAttribute('contenteditable');
        body.setAttribute('contenteditable', 'true');
        ctx.text('Make Content Editable', 'The whole body is editable; changes are local to this page view.', 'make-content-editable');
        return function () {
          if (previous === null) body.removeAttribute('contenteditable'); else body.setAttribute('contenteditable', previous);
        };
      }
    });

  feature('make-element-resizable', 'Make Element Resizable', '1c696e38b4',
    'Alt-click any element to give it a CSS resize handle; Alt-click again (or switch off) to restore it.', {
      apply: function (ctx) {
        var saved = [];
        ctx.style('make-element-resizable',
          '[data-wd-resizable="true"]{resize:both!important;overflow:auto!important;outline:2px dashed #7c3aed!important;outline-offset:2px;}');
        ctx.listen('make-element-resizable', ctx.doc, 'click', function (event) {
          if (!event.altKey) return;
          var el = event.target;
          if (!ctx.notUi(el)) return;
          event.preventDefault();
          if (el.getAttribute('data-wd-resizable') === 'true') {
            el.removeAttribute('data-wd-resizable');
            var entry = saved.filter(function (item) { return item[0] === el; })[0];
            if (entry) { if (entry[1] === null) el.removeAttribute('style'); else el.setAttribute('style', entry[1]); }
            return;
          }
          saved.push([el, el.getAttribute('style')]);
          el.setAttribute('data-wd-resizable', 'true');
        }, true);
        ctx.text('Make Element Resizable', 'Alt-click an element in the inspected page to add a resize handle.', 'make-element-resizable');
        return function () {
          saved.forEach(function (entry) {
            entry[0].removeAttribute('data-wd-resizable');
            if (entry[1] === null) entry[0].removeAttribute('style'); else entry[0].setAttribute('style', entry[1]);
          });
          ctx.unstyle('make-element-resizable');
        };
      }
    });

  feature('outline-all-links', 'Outline All Links', '728a032f14', 'Draw a blue outline around every <a href> element.', {
    apply: function (ctx) {
      ctx.style('outline-all-links', 'a[href]:not([data-wd-ui]){outline:2px solid #2563eb!important;outline-offset:2px;}');
      return function () { ctx.unstyle('outline-all-links'); };
    }
  });

  feature('outline-custom-elements', 'Outline Custom Elements', 'df0c52eb36',
    'Detect autonomous/custom elements (tag names containing a hyphen) and outline them, including ones added later.', {
      apply: function (ctx) {
        ctx.style('outline-custom-elements', '[data-wd-custom]:not([data-wd-ui]){outline:2px dotted #16a34a!important;outline-offset:2px;}');
        var off = ctx.mark('outline-custom-elements', 'data-wd-custom', function (el) { return el.tagName.indexOf('-') !== -1; });
        return function () { off(); ctx.unstyle('outline-custom-elements'); };
      }
    });

  feature('outline-image-maps', 'Outline Image Maps', '40ec151a09',
    'Draw outlines over <area> coordinates of every image map using the associated image’s position.', {
      apply: function (ctx) {
        var panel = ctx.overlay('image-maps', '', 'left:0;top:0;right:0;bottom:0;border:0;border-radius:0;padding:0;background:transparent;box-shadow:none;pointer-events:none;');
        function draw() {
          panel.innerHTML = '';
          ctx.elements('img[usemap]').forEach(function (img) {
            var name = (img.getAttribute('usemap') || '').replace(/^#/, '');
            var map = ctx.doc.querySelector('map[name="' + name + '"]');
            if (!map) return;
            var rect = img.getBoundingClientRect();
            Array.prototype.slice.call(map.querySelectorAll('area[coords]')).forEach(function (area) {
              var coords = area.getAttribute('coords').split(',').map(Number);
              if (coords.length < 4) return;
              var left = rect.left + coords[0], top = rect.top + coords[1];
              var width = coords[2] - coords[0], height = coords[3] - coords[1];
              var div = ctx.doc.createElement('div');
              div.setAttribute('data-wd-ui', '');
              div.setAttribute('style', 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:' + Math.max(1, width) +
                'px;height:' + Math.max(1, height) + 'px;border:2px solid #db2777;background:rgba(219,39,119,.12);pointer-events:none;');
              div.title = area.getAttribute('alt') || area.getAttribute('href') || '';
              panel.appendChild(div);
            });
          });
        }
        draw();
        ctx.listen('outline-image-maps', ctx.win, 'resize', draw, false);
        ctx.listen('outline-image-maps', ctx.win, 'scroll', draw, true);
        return function () { ctx.unoverlay('image-maps'); };
      }
    });

  feature('outline-no-follow-links', 'Outline No Follow Links', 'e03e56401b',
    'Outline links carrying rel="nofollow" (and noindex/sponsored/ugc variants).', {
      apply: function (ctx) {
        ctx.style('outline-no-follow-links', 'a[rel~="nofollow"]:not([data-wd-ui]),a[rel~="sponsored"]:not([data-wd-ui]),a[rel~="ugc"]:not([data-wd-ui]){outline:3px dashed #dc2626!important;outline-offset:3px;}');
        return function () { ctx.unstyle('outline-no-follow-links'); };
      }
    });

  feature('outline-no-index-elements', 'Outline No Index Elements', '3612ecff61',
    'Outline regions marked noindex/nosnippet (or hidden from assistive technology) and label them.', {
      apply: function (ctx) {
        var predicate = function (el) {
          return el.hasAttribute('data-noindex') || el.hasAttribute('noindex') || el.hasAttribute('data-nosnippet') ||
            el.getAttribute('aria-hidden') === 'true' || /\bnoindex\b/.test(el.className || '');
        };
        ctx.style('outline-no-index-elements', '[data-wd-noindex]:not([data-wd-ui]){outline:3px double #ea580c!important;outline-offset:2px;}');
        var off = ctx.mark('outline-no-index-elements', 'data-wd-noindex', predicate);
        var badges = ctx.badges('outline-no-index-elements', predicate, function () { return 'noindex'; }, 'wd-badge-red');
        return function () { off(); badges(); ctx.unstyle('outline-no-index-elements'); };
      }
    });

  feature('remove-inline-styles', 'Remove Inline Styles', 'd0ad7b6da0',
    'Remove every style attribute and restore all of them when the feature is switched off.', {
      apply: function (ctx) {
        var saved = [];
        ctx.elements('[style]').forEach(function (el) {
          saved.push([el, el.getAttribute('style')]);
          el.removeAttribute('style');
        });
        return function () { saved.forEach(function (entry) { entry[0].setAttribute('style', entry[1]); }); };
      }
    });

  feature('replace-images-with-title-attributes', 'Replace Images With Title Attributes', 'fd98618e0e',
    'Replace every image with its title (falling back to alt, then src) so text-only layout can be checked.', {
      apply: function (ctx) {
        var replacements = [];
        ctx.elements('img').forEach(function (img) {
          var span = ctx.doc.createElement('span');
          span.setAttribute('data-wd-ui', '');
          span.setAttribute('data-wd-replaced-image', '');
          span.className = 'wd-replaced-image';
          span.textContent = '[' + (img.getAttribute('title') || img.getAttribute('alt') || img.getAttribute('src') || 'image') + ']';
          if (img.parentNode) { img.parentNode.replaceChild(span, img); replacements.push([span, img]); }
        });
        return function () {
          replacements.forEach(function (entry) {
            if (entry[0].parentNode) entry[0].parentNode.replaceChild(entry[1], entry[0]);
          });
        };
      }
    });

  feature('validate-local-accessibility', 'Validate Local Accessibility', '86772e1d5c',
    'Run local WCAG-oriented checks: alt text, labels, link/button text, lang, duplicate ids, table headers and contrast.', {
      mode: 'action',
      execute: function (ctx) {
        var issues = a11yIssues(ctx);
        var errors = issues.filter(function (i) { return i.severity === 'error'; }).length;
        var warnings = issues.length - errors;
        ctx.html('Validate Local Accessibility',
          note(errors + ' error(s), ' + warnings + ' warning(s). This is a local check; no page data leaves the browser.') +
          (issues.length ? table(['Severity', 'Rule', 'Element', 'Detail'], issues.map(function (i) {
            return ['<span class="wd-sev ' + (i.severity === 'error' ? 'wd-sev-error' : 'wd-sev-warn') + '">' + i.severity + '</span>',
              escapeHtml(i.rule), '<code>' + escapeHtml(i.element) + '</code>', escapeHtml(i.detail)];
          })) : '<p class="wd-note">No issues found by the local checks.</p>'), 'validate-local-accessibility');
      }
    });

  feature('validate-tidied-html', 'Validate Tidied HTML', 'fa214dbc83',
    'Tidy (indent and normalise) the document source, then report structural issues found in the tidied markup.', {
      mode: 'action',
      execute: function (ctx) {
        var source = '<!doctype html>\n' + ctx.doc.documentElement.outerHTML;
        var tidied = core.tidyHtml(source);
        var issues = htmlIssues(ctx, tidied);
        ctx.html('Validate Tidied HTML',
          note(issues.length + ' issue(s) found in the tidied source. The full tidied markup is shown below.') +
          (issues.length ? '<ul class="wd-list">' + issues.map(function (i) { return '<li>' + escapeHtml(i) + '</li>'; }).join('') + '</ul>' : '') +
          pre(tidied.slice(0, 40000)), 'validate-tidied-html');
      }
    });

  feature('view-color-contrast-information', 'View Color Contrast Information', 'eff8c3c069',
    'List foreground/background pairs for text elements with WCAG AA/AAA contrast verdicts.', {
      mode: 'action',
      execute: function (ctx) {
        var rows = [];
        ctx.elements('p, span, a, li, h1, h2, h3, h4, h5, h6, button, label, td, th').forEach(function (el) {
          var text = (el.textContent || '').trim();
          if (!text) return;
          var fg = ctx.computed(el).color, bg = effectiveBackground(ctx, el);
          var ratio = core.contrastRatio(fg, bg);
          if (ratio === null) return;
          rows.push([
            '<code>' + escapeHtml(ctx.describe(el)) + '</code>',
            chip(fg) + '<code>' + escapeHtml(fg) + '</code>',
            chip(bg) + '<code>' + escapeHtml(bg) + '</code>',
            '<b>' + ratio + ':1</b>',
            ratio >= 7 ? '<span class="wd-state-on">AAA</span>' : ratio >= 4.5 ? '<span class="wd-state-on">AA</span>' : '<span class="wd-state-off">fail</span>'
          ]);
        });
        ctx.html('View Color Contrast Information', note(rows.length + ' text element(s) measured.') +
          table(['Element', 'Foreground', 'Background', 'Ratio', 'WCAG'], rows.slice(0, 200)), 'view-color-contrast-information');
      }
    });

  feature('view-computed-style', 'View Computed Style', 'd96213c8a1',
    'Show the computed style of the hovered element (box, text, colour, position and flex/grid properties).', {
      apply: function (ctx) {
        return ctx.inspector('view-computed-style', function (el) {
          var cs = ctx.computed(el);
          var props = ['display', 'position', 'width', 'height', 'margin', 'padding', 'border', 'color',
            'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
            'visibility', 'opacity', 'z-index', 'flex-direction', 'grid-template-columns', 'overflow'];
          return '<div class="wd-kv">' + props.map(function (prop) {
            var value = cs[prop] || (cs.getPropertyValue ? cs.getPropertyValue(prop) : '');
            return '<div><b>' + escapeHtml(prop) + '</b><code>' + escapeHtml(value || '—') + '</code></div>';
          }).join('') + '</div>';
        });
      }
    });

  feature('view-font-information', 'View Font Information', '59f8124a7b',
    'Group every rendered element by computed font family, size and weight, with usage counts.', {
      mode: 'action',
      execute: function (ctx) {
        var groups = {};
        ctx.elements('*').forEach(function (el) {
          if (!(el.textContent || '').trim()) return;
          var cs = ctx.computed(el);
          var key = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.fontStyle, cs.lineHeight].join(' | ');
          if (!groups[key]) groups[key] = { key: key.split(' | '), count: 0, sample: (el.textContent || '').trim().slice(0, 60) };
          groups[key].count += 1;
        });
        var rows = Object.keys(groups).sort(function (a, b) { return groups[b].count - groups[a].count; }).map(function (key) {
          var g = groups[key];
          return g.key.map(escapeHtml).concat([g.count, escapeHtml(g.sample)]);
        });
        ctx.html('View Font Information', note(rows.length + ' distinct font combination(s) in use.') +
          table(['Family', 'Size', 'Weight', 'Style', 'Line height', 'Elements', 'Sample text'], rows), 'view-font-information');
      }
    });

  feature('view-formatting', 'View Formatting', '442185b33a',
    'Badge and outline HTML formatting elements (b, i, em, strong, u, s, mark, small, sub, sup, …).', {
      apply: function (ctx) {
        var tags = ['b', 'i', 'em', 'strong', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'big', 'sub', 'sup', 'tt', 'code', 'abbr', 'cite', 'q'];
        ctx.style('view-formatting', tags.map(function (t) { return t + ':not([data-wd-ui])'; }).join(',') +
          '{outline:1px solid #9333ea!important;outline-offset:1px;}');
        var off = ctx.badges('view-formatting', function (el) { return tags.indexOf(el.tagName.toLowerCase()) !== -1; },
          function (el) { return '<' + el.tagName.toLowerCase() + '>'; }, 'wd-badge-purple');
        return function () { off(); ctx.unstyle('view-formatting'); };
      }
    });

  /* ------------------------------------------------ requested enhancements */

  enhancement('display-element-information-color',
    "'Display Element Information' should display color information", '9044c968ef',
    'The element inspector now shows computed text, background and border colours with swatches.', 'elementColors');
  enhancement('display-line-guides-save',
    "'Display Line Guides' should allow saving the line guide positions", '4d332ec41e',
    'Guides are draggable, persist across reloads, and can be added, saved or cleared from the output panel.', 'lineGuides');
  enhancement('edit-css-color-picker',
    "'Edit CSS' should have a color picker", '2d79ad6048',
    'The CSS editor has a native colour input that inserts a hex colour at the caret.', 'editCssColorPicker');
  enhancement('edit-css-mime-warning',
    "'Edit CSS' should notify when style sheets have invalid MIME types", '9cf7d382e8',
    'Linked stylesheets are probed for Content-Type; non-text/css responses raise a visible warning.', 'editCssMime');
  enhancement('outline-images-adjusted-dimensions',
    "'Outline Images With Adjusted Dimensions' should display the image dimensions", '0607efd71b',
    'Adjusted images are badged with natural × displayed dimensions alongside the outline.', 'adjustedDimensions');
  enhancement('populate-form-fields-configurable',
    "'Populate Form Fields' should be configurable", '13706f4d43',
    'Every field type has an editable sample value in Options; overrides can also be passed per run.', 'formValues');
  enhancement('validators-configurable',
    "'Validate Local CSS' and 'Validate Local HTML' validators should be configurable", '41b6911430',
    'Both validators accept a configurable endpoint (with %s/%d placeholders) and fall back to local checks.', 'validators');
  enhancement('view-cookie-information-csv',
    "'View Cookie Information' should allow information to be exported as a CSV file", 'dc06e91703',
    'The cookie report has a CSV export button and shows the exact CSV payload.', 'cookieCsv');
  enhancement('view-image-information-grid',
    "'View Image Information' should display results as a grid", 'f33d09b550',
    'Image results render as a responsive thumbnail grid, with a list view available too.', 'imageGrid');
  enhancement('view-link-information-details',
    "'View Link Information' should display the link text title and target", '02f956ba6a',
    'The link report includes link text, title and target for every anchor.', 'linkDetails');
  enhancement('view-link-information-split',
    "'View Link Information' should separate internal and external links", '39bfe44fa9',
    'Internal and external anchors are grouped into separate sections with counts.', 'linkSplit');

  /* --------------------------------------------------- platform + Chrome items */

  platform('dashboard-close-warning', 'Add a warning when closing the dashboard after changes have been made', '138e93a163',
    'The dashboard tracks unsaved option/feature changes and asks before closing or unloading.', 'warnOnClose');
  platform('beautify-css', 'Add support for beautifying CSS', 'ae5e490787',
    'Any CSS in the output panel or the CSS editor can be reformatted with one click.', 'beautifyCss');
  platform('keyboard-shortcuts', 'Add support for customizable keyboard shortcuts', 'cce62b5b1f',
    'Bind any feature to a key combination in the Shortcuts tab; bindings work in the dashboard and content script.', 'shortcuts');
  platform('dark-mode', 'Add support for dark mode', '74f49eeb73',
    'A persisted dark theme for the dashboard, the options page and generated reports.', 'darkMode');
  platform('display-element-information-position', 'Add support for element position in \u2018Display Element Information\u2019', 'b6e9cd5694',
    'The element inspector reports page x/y coordinates plus width and height.', 'elementPosition');
  platform('view-color-information-gradients', 'Add support for gradients in \u2018View Color Information\u2019', '226ebc5e14',
    'Linear, radial, conic and repeating gradients are extracted, previewed and listed with their colour stops.', 'gradients');
  platform('options-import-export', 'Add support for importing and exporting of the extension options', '17a5cc4500',
    'Options, pins, templates, shortcuts and tools export to a JSON file and import back with validation.', 'importExport');
  platform('pinning-features', 'Add support for pinning features', 'ccfb74882d',
    'Star any feature to keep it in the Pinned view at the top of the menu.', 'pins');
  platform('reposition-dashboard', 'Add support for repositioning the dashboard', '22591cb62a',
    'The output panel can be detached into a draggable floating window; overlay positions are saved too.', 'reposition');
  platform('sort-color-information', "Add support for sorting 'View Color Information' by color instead of alphabetically", 'e81fb0f091',
    'Colour reports sort alphabetically or by hue/chromaticity; the choice is persisted.', 'colorSort');
  platform('sync-options', 'Add support for syncing the extension options', '5883a5b7c0',
    'Extension mode uses chrome.storage.sync; standalone mode mirrors changes to other open tabs via BroadcastChannel.', 'syncOptions');
  platform('wrap-text-output', 'Add support for wrapping text output', 'f38b66d24f',
    'Long source, validator and CSV output can be wrapped instead of scrolling horizontally.', 'wrapOutput');
  platform('feature-templates', 'Allow templates of activated features to be saved and loaded', '132c63ed2d',
    'Save the current set of active features as a named template and load or delete it later.', 'templates');
  platform('customizable-menus', 'Allow the Web Developer menus to be customized', '9f6adff442',
    'Rename, hide and reorder the sidebar menus in the Options tab.', 'menus');
  platform('split-id-class-details', "Separate 'Display Id & Class Details' into two features", '3c7b4fe999',
    'Display Id Details and Display Class Details are independent toggles.', 'idClass');
  platform('tool-url-placeholders', 'Use %s and %d placeholders for the site URL and domain in a tool URL', '6d5f04281f',
    'Custom tool URLs expand %s to the full page URL and %d to its domain, with a live preview.', 'tools');
  platform('javascript-status-icon', 'Add JavaScript status icon', '7b426afd5c',
    'A status chip shows the JavaScript setting; in extension mode the browser action badge reflects it too.', 'jsStatus', 'Chrome');
  platform('quirks-mode-status-icon', 'Add quirks mode status icon', '340ec931fc',
    'A status chip shows standards/quirks mode (document.compatMode), mirrored in the extension badge.', 'quirksStatus', 'Chrome');
  platform('same-site-cookies', 'Add support for same site cookies', '1268fd0b55',
    'The cookie report includes the SameSite attribute when the extension’s cookies API supplies it.', 'sameSiteCookies', 'Chrome');

  /* ------------------------------------- base features (enhancement targets) */

  base('display-element-information', 'Display Element Information',
    'Hover inspector with tag, id, class, page position, dimensions and colour information.').apply = function (ctx) {
      return ctx.inspector('display-element-information', function (el) {
        var r = ctx.rectOf(el), cs = ctx.computed(el);
        var colors = [['color', cs.color], ['background', cs.backgroundColor], ['border', cs.borderTopColor]]
          .map(function (pair) { return '<div>' + chip(pair[1]) + '<code>' + escapeHtml(pair[0] + ': ' + pair[1]) + '</code></div>'; }).join('');
        return '<div>id: <code>' + escapeHtml(el.id || '(none)') + '</code> · class: <code>' + escapeHtml(el.className || '(none)') + '</code></div>' +
          '<div>position: x ' + r.x + ', y ' + r.y + ' · size ' + r.width + ' × ' + r.height + '</div>' + colors;
      });
    };

  base('display-line-guides', 'Display Line Guides',
    'Draggable horizontal/vertical ruler guides whose positions are saved and restored.').apply = function (ctx) {
      var guides = ctx.restore('lineGuides', []) || [];
      var panel = ctx.overlay('line-guides', '', 'left:0;top:0;right:0;bottom:0;border:0;border-radius:0;padding:0;background:transparent;box-shadow:none;');
      function draw() {
        panel.innerHTML = '';
        guides.forEach(function (guide, index) {
          var line = ctx.doc.createElement('div');
          line.setAttribute('data-wd-ui', '');
          line.setAttribute('data-wd-guide', index);
          line.setAttribute('style', 'position:fixed;pointer-events:auto;background:#db2777;' + (guide.axis === 'v'
            ? 'left:' + guide.pos + 'px;top:0;width:2px;height:100vh;cursor:col-resize;'
            : 'top:' + guide.pos + 'px;left:0;height:2px;width:100vw;cursor:row-resize;') + 'z-index:2147483000;');
          line.title = (guide.axis === 'v' ? 'vertical' : 'horizontal') + ' guide at ' + guide.pos + 'px (drag to move)';
          panel.appendChild(line);
        });
      }
      draw();
      var dragging = null;
      ctx.listen('display-line-guides', ctx.doc, 'mousedown', function (event) {
        var line = event.target && event.target.closest ? event.target.closest('[data-wd-guide]') : null;
        if (!line) return;
        dragging = Number(line.getAttribute('data-wd-guide'));
        event.preventDefault();
      }, true);
      ctx.listen('display-line-guides', ctx.doc, 'mousemove', function (event) {
        if (dragging === null || !guides[dragging]) return;
        guides[dragging].pos = Math.max(0, guides[dragging].axis === 'v' ? event.clientX : event.clientY);
        draw();
        // Re-attach drag state: draw() replaced the node, so use the index only.
      }, true);
      ctx.listen('display-line-guides', ctx.doc, 'mouseup', function () {
        if (dragging !== null) ctx.persist('lineGuides', guides);
        dragging = null;
      }, true);
      ctx.state.lineGuides = {
        add: function (axis) {
          guides.push({ axis: axis === 'v' ? 'v' : 'h', pos: axis === 'v' ? 200 : 160 });
          draw(); ctx.persist('lineGuides', guides);
        },
        save: function () { ctx.persist('lineGuides', guides); },
        clear: function () { guides = []; draw(); ctx.persist('lineGuides', guides); }
      };
      ctx.reportGuides = function (message) {
        ctx.html('Display Line Guides', note((message || '') + guides.length + ' guide(s). Drag a line to move it; positions are saved automatically.') +
          actions([
            ctx.actionButton('display-line-guides', { add: 'h' }, '+ Horizontal'),
            ctx.actionButton('display-line-guides', { add: 'v' }, '+ Vertical'),
            ctx.actionButton('display-line-guides', { save: true }, 'Save positions'),
            ctx.actionButton('display-line-guides', { clear: true }, 'Clear all')
          ]), 'display-line-guides');
      };
      ctx.reportGuides('');
      return function () { ctx.unoverlay('line-guides'); delete ctx.state.lineGuides; delete ctx.reportGuides; };
    };
  F[F.length - 1].execute = function (ctx, payload) {
    if (!ctx.state.lineGuides) { ctx.text('Display Line Guides', 'Enable Display Line Guides first.', 'display-line-guides'); return; }
    if (payload.add) ctx.state.lineGuides.add(payload.add);
    else if (payload.clear) ctx.state.lineGuides.clear();
    else ctx.state.lineGuides.save();
    ctx.reportGuides(payload.clear ? 'All guides cleared. ' : 'Positions saved. ');
  };

  base('edit-css', 'Edit CSS', 'Edit all inline CSS, with a colour picker, beautifier, apply/reset and MIME warnings.', 'action').execute = function (ctx, payload) {
    var sheets = stylesheets(ctx).filter(function (sheet) { return sheet.type === 'style'; });
    if (ctx.state.cssDraft === null || payload.reset) {
      ctx.state.cssDraft = sheets.map(function (sheet) { return '/* ' + sheet.label + ' */\n' + (sheet.el.getAttribute('data-wd-original-css') || sheet.el.textContent); }).join('\n\n') || ctx.cssText();
    }
    if (payload.beautify) ctx.state.cssDraft = core.beautifyCss(ctx.state.cssDraft);
    if (payload.color) ctx.state.cssDraft = core.beautifyCss(ctx.state.cssDraft + '\n/* picked colour: ' + payload.color + ' */\n.wd-color-picker { color: ' + payload.color + '; }\n');
    if (payload.apply && typeof payload.css === 'string') {
      ctx.state.cssDraft = payload.css;
      if (sheets.length) {
        sheets.forEach(function (sheet) { sheet.el.setAttribute('data-wd-original-css', payload.css); sheet.el.textContent = payload.css; });
      } else {
        var style = ctx.doc.createElement('style');
        style.setAttribute('data-wd-user-css', '');
        style.textContent = payload.css;
        ctx.doc.head.appendChild(style);
      }
      ctx.text('Edit CSS', 'Applied ' + payload.css.length + ' characters of CSS to the page.', 'edit-css');
      return;
    }
    checkMimeTypes(ctx, 'Edit CSS');
    ctx.html('Edit CSS',
      note('Editing ' + sheets.length + ' inline stylesheet block(s). Linked stylesheets with an invalid MIME type are reported separately.') +
      '<div class="wd-editor-tools">' +
      '<label>Colour picker <input type="color" id="wd-color-picker" value="#7c3aed"></label>' +
      ctx.actionButton('edit-css', { color: '' }, 'Insert colour', 'color:wd-color-picker') +
      ctx.actionButton('edit-css', { beautify: true }, 'Beautify CSS') +
      ctx.actionButton('edit-css', { reset: true }, 'Reset from page') +
      '</div>' +
      '<textarea id="wd-edit-css" class="wd-editor" spellcheck="false">' + escapeHtml(ctx.state.cssDraft) + '</textarea>' +
      actions([
        ctx.actionButton('edit-css', { apply: true, css: '' }, 'Apply CSS', 'css:wd-edit-css', 'wd-btn wd-btn-primary'),
        ctx.actionButton('disable-individual-stylesheet', {}, 'Stylesheets →')
      ]), 'edit-css');
  };

  base('outline-images-with-adjusted-dimensions', 'Outline Images With Adjusted Dimensions',
    'Outline images whose rendered size differs from their natural size and badge both dimensions.').apply = function (ctx) {
      function adjusted(el) {
        var natural = el.naturalWidth || Number(el.getAttribute('data-natural-width')) || 0;
        var rect = ctx.rectOf(el);
        return natural > 0 && rect.width > 0 && (Math.abs(natural - rect.width) > 1);
      }
      ctx.style('outline-images-with-adjusted-dimensions', '[data-wd-adjusted]{outline:3px solid #f97316!important;outline-offset:2px;}');
      var offMark = ctx.mark('outline-images-with-adjusted-dimensions', 'data-wd-adjusted', adjusted);
      var offBadges = ctx.badges('outline-images-with-adjusted-dimensions', adjusted, function (el) {
        var rect = ctx.rectOf(el);
        return (el.naturalWidth || 0) + '×' + (el.naturalHeight || 0) + ' → ' + rect.width + '×' + rect.height;
      }, 'wd-badge-red', 'before');
      return function () { offBadges(); offMark(); ctx.unstyle('outline-images-with-adjusted-dimensions'); };
    };

  base('populate-form-fields', 'Populate Form Fields', 'Fill every form control using configurable per-type sample values.', 'action').execute = function (ctx, payload) {
    var values = Object.assign({}, core.DEFAULT_OPTIONS.formValues, ctx.option('formValues', {}), payload.values || {});
    var filled = 0;
    ctx.elements('input, textarea, select').forEach(function (el) {
      var type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
      var value = values[type];
      if (value === undefined) return;
      if (type === 'checkbox' || type === 'radio') {
        el.checked = !!value;
      } else if (el.tagName === 'SELECT') {
        var options = Array.prototype.slice.call(el.options || []);
        if (!options.length) return;
        var wanted = values.select;
        var option = options.filter(function (o) { return o.value === wanted || o.textContent.trim() === wanted; })[0] || options[0];
        el.value = option.value;
      } else {
        el.value = String(value);
      }
      ['input', 'change'].forEach(function (name) {
        var event = ctx.doc.createEvent ? ctx.doc.createEvent('HTMLEvents') : null;
        if (!event) return;
        event.initEvent(name, true, false);
        el.dispatchEvent(event);
      });
      filled += 1;
    });
    ctx.html('Populate Form Fields', note('Filled ' + filled + ' control(s). Values are configurable in Options → Form field values.') +
      table(['Type', 'Value'], Object.keys(values).map(function (key) { return [escapeHtml(key), '<code>' + escapeHtml(values[key]) + '</code>']; })) +
      actions([ctx.actionButton('populate-form-fields', { values: {} }, 'Fill again')]), 'populate-form-fields');
  };

  base('validate-local-html', 'Validate Local HTML', 'Local HTML checks, or a configurable remote validator URL.', 'action').execute = function (ctx) {
    var source = '<!doctype html>\n' + ctx.doc.documentElement.outerHTML;
    var endpoint = ctx.option('validatorHtmlUrl', '');
    var issues = htmlIssues(ctx, source);
    ctx.html('Validate Local HTML',
      note('Validator: ' + (endpoint || 'local checks only (configure validatorHtmlUrl in Options)') + '. Local checks found ' + issues.length + ' issue(s).') +
      (issues.length ? '<ul class="wd-list">' + issues.map(function (i) { return '<li>' + escapeHtml(i) + '</li>'; }).join('') + '</ul>' : '') +
      pre(core.tidyHtml(source).slice(0, 8000)), 'validate-local-html');
    if (endpoint) remoteValidate(ctx, endpoint, 'HTML', source);
  };

  base('validate-local-css', 'Validate Local CSS', 'Local CSS checks, or a configurable remote validator URL.', 'action').execute = function (ctx) {
    var css = ctx.cssText();
    var endpoint = ctx.option('validatorCssUrl', '');
    var issues = cssIssues(ctx, css);
    ctx.html('Validate Local CSS',
      note('Validator: ' + (endpoint || 'local checks only (configure validatorCssUrl in Options)') + '. Local checks found ' + issues.length + ' issue(s).') +
      (issues.length ? '<ul class="wd-list">' + issues.map(function (i) { return '<li>' + escapeHtml(i) + '</li>'; }).join('') + '</ul>' : '') +
      pre(core.beautifyCss(css).slice(0, 12000)), 'validate-local-css');
    if (endpoint) remoteValidate(ctx, endpoint, 'CSS', css);
  };

  base('view-cookie-information', 'View Cookie Information', 'List cookies (including SameSite) and export them as CSV.', 'action').execute = function (ctx, payload) {
    var cookies = cookieRecords(ctx);
    var csv = core.cookiesToCsv(cookies);
    if (payload && payload.csv) {
      ctx.download('web-developer-cookies.csv', csv, 'text/csv');
      ctx.html('View Cookie Information — CSV export',
        note('Downloaded web-developer-cookies.csv with ' + cookies.length + ' row(s).') + pre(csv), 'view-cookie-information');
      return;
    }
    var rows = cookies.map(function (c) {
      return [escapeHtml(c.name), '<code>' + escapeHtml(c.value) + '</code>', escapeHtml(c.domain || '(current)'),
        escapeHtml(c.path || ''), escapeHtml(c.expires || 'session'), c.secure ? 'yes' : 'no',
        c.httpOnly ? 'yes' : 'no', escapeHtml(c.sameSite || 'unspecified')];
    });
    ctx.html('View Cookie Information',
      note(cookies.length + ' cookie(s). In the Chrome extension, SameSite/HttpOnly/Secure come from the cookies API; in the standalone preview they come from document.cookie.') +
      table(['Name', 'Value', 'Domain', 'Path', 'Expires', 'Secure', 'HttpOnly', 'SameSite'], rows) +
      actions([ctx.actionButton('view-cookie-information', { csv: true }, 'Export as CSV', null, 'wd-btn wd-btn-primary')]), 'view-cookie-information');
  };

  base('view-image-information', 'View Image Information', 'Responsive thumbnail grid (or list) of every image with alt/title and dimensions.', 'action').execute = function (ctx, payload) {
    var images = imageRecords(ctx);
    var grid = !payload || payload.view !== 'list';
    var body;
    if (grid) {
      body = '<div class="wd-image-grid">' + images.map(function (img) {
        return '<figure class="wd-image-card"><div class="wd-image-thumb"><img src="' + escapeHtml(img.src) + '" alt=""></div>' +
          '<figcaption><code>' + escapeHtml(img.src) + '</code>' +
          '<span>alt: ' + escapeHtml(img.alt || '—') + '</span><span>title: ' + escapeHtml(img.title || '—') + '</span>' +
          '<span>natural: ' + escapeHtml(img.natural) + '</span><span>displayed: ' + escapeHtml(img.displayed) + '</span>' +
          (img.loading ? '<span>loading: ' + escapeHtml(img.loading) + '</span>' : '') + '</figcaption></figure>';
      }).join('') + '</div>';
    } else {
      body = table(['Source', 'Alt', 'Title', 'Natural', 'Displayed', 'Loading'], images.map(function (img) {
        return ['<code>' + escapeHtml(img.src) + '</code>', escapeHtml(img.alt), escapeHtml(img.title),
          escapeHtml(img.natural), escapeHtml(img.displayed), escapeHtml(img.loading)];
      }));
    }
    ctx.html('View Image Information', note(images.length + ' image(s) — ' + (grid ? 'grid' : 'list') + ' view.') + body +
      actions([
        ctx.actionButton('view-image-information', { view: 'grid' }, 'Grid view'),
        ctx.actionButton('view-image-information', { view: 'list' }, 'List view')
      ]), 'view-image-information');
  };

  base('view-link-information', 'View Link Information', 'Link text, title, target and href, split into internal and external sections.', 'action').execute = function (ctx) {
    var links = linkRecords(ctx), split = core.splitLinks(links, pageUrl(ctx));
    function section(title, items) {
      return '<h4>' + escapeHtml(title) + ' (' + items.length + ')</h4>' +
        (items.length ? table(['Link text', 'Title', 'Target', 'href', 'rel'], items.map(function (link) {
          return [escapeHtml(link.text || '(no text)'), escapeHtml(link.title || '—'), escapeHtml(link.target || '—'),
            '<code>' + escapeHtml(link.href) + '</code>', escapeHtml(link.rel || '—')];
        })) : '<p class="wd-note">No links in this section.</p>');
    }
    ctx.html('View Link Information',
      note(links.length + ' link(s) on ' + escapeHtml(pageUrl(ctx) || '(unknown URL)') + '. Internal and external links are separated.') +
      section('Internal links', split.internal) + section('External links', split.external), 'view-link-information');
  };

  base('view-color-information', 'View Color Information', 'All used colours and gradients, sortable alphabetically or by hue.', 'action').execute = function (ctx, payload) {
    var data = colorRecords(ctx);
    var mode = (payload && payload.sort) || ctx.option('colorSort', 'alphabetical');
    var colors = core.sortColors(data.colors, mode);
    var rows = colors.map(function (c) {
      return [chip(c.value) + '<code>' + escapeHtml(c.value) + '</code>', c.count, escapeHtml(c.sources.join(', ')), escapeHtml(core.toHex(core.parseColor(c.value)))];
    });
    var gradients = data.gradients.map(function (g) {
      return ['<div class="wd-gradient" style="background:' + escapeHtml(g.preview || g.value) + '"></div>',
        escapeHtml(g.type), escapeHtml(g.colors.join(', ') || '(image/named stops)'), '<code>' + escapeHtml(g.value.slice(0, 140)) + '</code>'];
    });
    ctx.html('View Color Information',
      note(colors.length + ' colour(s) and ' + gradients.length + ' gradient(s). Sort: ' + mode + '.') +
      actions([
        ctx.actionButton('view-color-information', { sort: 'alphabetical' }, 'Sort alphabetically'),
        ctx.actionButton('view-color-information', { sort: 'color' }, 'Sort by color'),
        ctx.actionButton('beautify-css', {}, 'Beautify CSS')
      ]) +
      table(['Colour', 'Uses', 'Source', 'Hex'], rows) +
      '<h4>Gradients</h4>' + (gradients.length ? table(['Preview', 'Type', 'Colour stops', 'Declaration'], gradients) : '<p class="wd-note">No gradients found.</p>'),
      'view-color-information');
  };

  base('display-id-details', 'Display Id Details', 'Badge elements that have an id (split from the old combined feature).').apply = function (ctx) {
    return ctx.badges('display-id-details', function (el) { return !!el.id; }, function (el) { return '#' + el.id; }, 'wd-badge-green');
  };

  base('display-class-details', 'Display Class Details', 'Badge elements that have classes (split from the old combined feature).').apply = function (ctx) {
    return ctx.badges('display-class-details', function (el) { return !!(el.className && String(el.className).trim()); },
      function (el) { return '.' + String(el.className).trim().split(/\s+/).join('.'); }, 'wd-badge-blue');
  };

  /* ------------------------------------------------------------ public API */

  return {
    FEATURES: F,
    DEFAULT_OPTIONS: core.DEFAULT_OPTIONS,
    byId: function (id) { return F.filter(function (f) { return f.id === id; })[0] || null; },
    groups: function () {
      var seen = {};
      return F.map(function (f) { return f.group; }).filter(function (g) { if (seen[g]) return false; seen[g] = true; return true; });
    },
    helpers: {
      table: table, chip: chip, pre: pre, note: note, actions: actions, fmt: fmt,
      stylesheets: stylesheets, sheetDisabled: sheetDisabled, setSheetDisabled: setSheetDisabled,
      cookieRecords: cookieRecords, linkRecords: linkRecords, imageRecords: imageRecords,
      colorRecords: colorRecords, a11yIssues: a11yIssues, htmlIssues: htmlIssues, cssIssues: cssIssues
    },
    core: core,
    createSession: function (win, doc, config) {
      return core.createSession(win, doc, Object.assign({ features: F }, config || {}));
    },
    // Re-export pure helpers so the dashboard, content script and tests share one implementation.
    escapeHtml: core.escapeHtml, parseColor: core.parseColor, toHex: core.toHex,
    contrastRatio: core.contrastRatio, sortColors: core.sortColors, extractGradients: core.extractGradients,
    beautifyCss: core.beautifyCss, expandToolUrl: core.expandToolUrl, cookiesToCsv: core.cookiesToCsv,
    splitLinks: core.splitLinks, tidyHtml: core.tidyHtml, statusOf: core.statusOf
  };
});
