// ==UserScript==
// @name         X Share Sheet
// @namespace    local.x.share-sheet
// @version      1.0.1
// @description  Adds an "Open share sheet…" button to X/Twitter's share menu that triggers iOS native share with post text and URL.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://*.twitter.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var TAG = '[x-share-sheet]';
  var MARKER_ATTR = 'data-tm-x-share-sheet';
  console.info(TAG, 'v1.0.0');

  var context = { article: null, url: '', at: 0 };

  // Capture share button clicks before React handles them
  document.addEventListener('click', function (event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!(node instanceof Element)) continue;
      if (isShareTrigger(node)) {
        context.article =
          node.closest('article') ||
          node.closest('[data-testid="twitterArticleReadView"]') ||
          null;
        context.url = location.href;
        context.at = Date.now();
        return;
      }
    }
  }, true);

  function isShareTrigger(node) {
    if (!node.matches) return false;
    if (node.matches('button[aria-label="Share post" i], button[aria-label*="share post" i]')) return true;
    if (node.matches('[data-testid="share"], [data-testid="Share"]')) return true;
    return false;
  }

  function scanMenus() {
    scanContainer('[role="menu"]');
    scanContainer('[data-testid="Dropdown"]');
  }

  function scanContainer(selector) {
    var containers = document.querySelectorAll(selector);
    for (var i = 0; i < containers.length; i++) {
      tryInject(containers[i]);
    }
  }

  function tryInject(container) {
    if (container.querySelector('[' + MARKER_ATTR + ']')) return;

    var template = container.querySelector('[role="menuitem"]');
    if (!template) return;

    var item = template.cloneNode(true);
    item.setAttribute(MARKER_ATTR, '1');

    // Replace SVG icon with share icon
    var svg = item.querySelector('svg');
    if (svg) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var ns = 'http://www.w3.org/2000/svg';
      var g = document.createElementNS(ns, 'g');
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', 'M12 2 8 6h3v10h2V6h3l-4-4zM20 8h-4v2h4v10H4V10h4V8H4c-1.1 0-2 .9-2 2v10c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z');
      g.appendChild(path);
      svg.appendChild(g);
    }

    var label = item.querySelector('span');
    if (label) label.textContent = 'Open share sheet…';

    item.addEventListener('click', onMenuItemClick, true);
    item.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') onMenuItemClick(e);
    }, true);

    container.insertBefore(item, container.firstElementChild);
    console.info(TAG, 'injected');
  }

  function onMenuItemClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    var data = buildShareData();
    console.info(TAG, 'share:', data.title, '(' + data.text.length + ' chars)');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    if (typeof navigator.share === 'function') {
      navigator.share(data).catch(function (err) {
        if (err && err.name !== 'AbortError') {
          console.warn(TAG, 'share failed:', err);
          fallbackCopy(data);
        }
      });
    } else {
      fallbackCopy(data);
    }
  }

  function buildShareData() {
    var article = pickArticle();
    var text = extractText(article);
    var author = extractAuthor(article);
    var url = resolvePostUrl(article) || (Date.now() - context.at < 5000 ? context.url : location.href);
    var body = text ? text + '\n\n' + url : url;
    return { title: author || 'X post', text: body, url: url };
  }

  function pickArticle() {
    if (context.article && context.article.isConnected && Date.now() - context.at < 5000) {
      return context.article;
    }
    if (location.pathname.indexOf('/article/') !== -1) {
      return document.querySelector('[data-testid="twitterArticleReadView"]');
    }
    return document.querySelector('article[tabindex="-1"]') || document.querySelector('article');
  }

  function extractText(container) {
    if (!container) return '';

    var richView = document.querySelector('[data-testid="twitterArticleRichTextView"]');
    if (richView) {
      var titleEl = document.querySelector('[data-testid="twitter-article-title"]');
      var title = titleEl ? titleEl.innerText.trim() : '';
      var body = (richView.innerText || '').trim();
      var parts = [];
      if (title) parts.push(title);
      if (body) parts.push(body);
      if (parts.length > 0) return parts.join('\n\n');
    }

    var texts = container.querySelectorAll('[data-testid="tweetText"]');
    if (texts.length > 0) {
      return Array.from(texts).map(function (el) { return el.innerText.trim(); }).filter(Boolean).join('\n\n');
    }

    return (container.innerText || '').trim();
  }

  function extractAuthor(article) {
    if (!article) return '';
    var el = article.querySelector('[data-testid="User-Name"]');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  }

  function resolvePostUrl(article) {
    if (!article) return '';
    var timeEl = article.querySelector('time');
    var link = timeEl && timeEl.closest('a[href*="/status/"], a[href*="/article/"]');
    if (link) {
      try { return new URL(link.getAttribute('href'), location.origin).href; } catch (e) {}
    }
    if (location.pathname.indexOf('/status/') !== -1 || location.pathname.indexOf('/article/') !== -1) return location.href;
    return '';
  }

  function fallbackCopy(data) {
    var t = data.text || data.url || '';
    if (!t || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(t).then(function () {}).catch(function () {});
  }

  // === DIAGNOSTIC VISUAL MARKER ===
  // Adds a "⇧📋" badge after usernames so you can tell the script is loaded.
  function markAuthors() {
    var names = document.querySelectorAll('[data-testid="User-Name"]');
    for (var i = 0; i < names.length; i++) {
      var el = names[i];
      if (el.querySelector('[data-ss-marker]')) continue;
      var badge = document.createElement('span');
      badge.setAttribute('data-ss-marker', '1');
      badge.textContent = ' ⇧📋';
      badge.style.cssText = 'font-size:11px;color:#1d9bf0;vertical-align:middle';
      el.appendChild(badge);
    }
  }

  var observer = new MutationObserver(function () {
    scanMenus();
    markAuthors();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scanMenus();
  markAuthors();
  console.info(TAG, 'ready');
})();
