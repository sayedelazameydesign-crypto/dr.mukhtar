/*!
 * Web Developer extension service worker.
 *
 * Responsibilities the content script cannot take on: reading cookie metadata
 * (including SameSite), starting downloads, and drawing the JavaScript / quirks
 * mode status badge on the browser action.
 */
'use strict';

function toBase64(text) {
  var bytes = new TextEncoder().encode(String(text));
  var binary = '';
  for (var i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function cookieRecord(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '',
    path: cookie.path || '/',
    expires: cookie.expirationDate ? new Date(cookie.expirationDate * 1000).toISOString() : 'session',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: cookie.sameSite || 'unspecified',
    size: (cookie.name || '').length + (cookie.value || '').length
  };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return false;

  if (message.type === 'getCookies') {
    var url = message.url || (sender.tab && sender.tab.url) || 'https://example.com/';
    chrome.cookies.getAll({ url: url }, function (cookies) {
      sendResponse({ cookies: (cookies || []).map(cookieRecord) });
    });
    return true;
  }

  if (message.type === 'download') {
    var mime = /^[\w.+/-]+$/.test(message.mime || '') ? message.mime : 'text/plain';
    var dataUrl = 'data:' + mime + ';base64,' + toBase64(message.text || '');
    chrome.downloads.download({ url: dataUrl, filename: message.filename || 'web-developer.txt', saveAs: true }, function () {
      sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
    });
    return true;
  }

  if (message.type === 'pageStatus') {
    var tabId = sender.tab && sender.tab.id;
    var status = message.status || {};
    if (tabId !== undefined && chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeText({ tabId: tabId, text: status.quirks ? 'Q' : 'JS' });
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: status.quirks ? '#b45309' : '#4338ca' });
      chrome.action.setTitle({
        tabId: tabId,
        title: 'Web Developer — JavaScript on, ' + (status.quirks ? 'quirks mode' : 'standards mode')
      });
    }
    return false;
  }

  if (message.type === 'status') {
    // contentSettings can report a disabled-JavaScript setting even when no content
    // script is running (in which case the popup gets no per-page status message).
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) { sendResponse({ status: null }); return; }
      var result = { url: tab.url || '', jsEnabled: true, quirks: null };
      var finish = function () {
        if (chrome.action && chrome.action.setBadgeText) {
          chrome.action.setBadgeText({ tabId: tab.id, text: result.jsEnabled ? 'JS' : 'OFF' });
          chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: result.jsEnabled ? '#4338ca' : '#b91c1c' });
        }
        sendResponse({ status: result });
      };
      if (chrome.contentSettings && chrome.contentSettings.javascript && tab.url) {
        try {
          chrome.contentSettings.javascript.get({ primaryUrl: tab.url }, function (details) {
            result.jsEnabled = details && details.setting !== 'block';
            finish();
          });
          return;
        } catch (_) { /* fall through to finish() below */ }
      }
      finish();
    });
    return true;
  }

  return false;
});
