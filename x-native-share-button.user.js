// ==UserScript==
// @name         X Native Share Button
// @namespace    local.x.native-share-button
// @version      1.1.0
// @description  Adds an inline native share button to X/Twitter posts and articles, sharing the post text and canonical URL through the OS share sheet.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://*.twitter.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var TAG = '[x-native-share-button]';
  var BUTTON_ATTR = 'data-tm-x-native-share-button';
  var BUTTON_LABEL = 'Native share';
  var SCAN_DELAY_MS = 80;
  var scanTimer = null;

  console.info(TAG, 'v1.1.0 ready');

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(function () {
      scanTimer = null;
      scan();
    }, SCAN_DELAY_MS);
  }

  function scan() {
    var shareButtons = document.querySelectorAll('button, [role="button"]');

    for (var i = 0; i < shareButtons.length; i++) {
      injectForShareButton(shareButtons[i]);
    }
  }

  function injectForShareButton(shareButton) {
    if (!(shareButton instanceof Element)) return;
    if (shareButton.closest('[' + BUTTON_ATTR + ']')) return;
    if (!isShareTrigger(shareButton)) return;

    var article = findArticleForButton(shareButton);
    var scope = article || shareButton.parentElement || document;
    var insertionPoint = findActionWrapper(shareButton);
    if (!insertionPoint || !insertionPoint.parentNode) return;

    var existing = scope.querySelector('[' + BUTTON_ATTR + ']');
    if (existing && existing.parentNode === insertionPoint.parentNode) return;

    var nativeButton = createNativeShareButton(shareButton, article);
    insertionPoint.parentNode.insertBefore(nativeButton, insertionPoint.nextSibling);
  }

  function findArticleForButton(button) {
    var article = button.closest('article');
    if (article) return article;

    var readView = document.querySelector('[data-testid="twitterArticleReadView"]');
    if (readView) return readView;

    return null;
  }

  function isShareTrigger(node) {
    if (!node || !node.matches) return false;

    var testId = (node.getAttribute('data-testid') || '').toLowerCase();
    if (testId === 'share') return true;

    var label = (node.getAttribute('aria-label') || node.getAttribute('title') || '').toLowerCase();
    return label.indexOf('share') !== -1;
  }

  function findActionWrapper(button) {
    var node = button;

    for (var depth = 0; node && depth < 4; depth++) {
      if (node.parentElement && looksLikeActionWrapper(node.parentElement)) {
        return node.parentElement;
      }
      node = node.parentElement;
    }

    return button;
  }

  function looksLikeActionWrapper(node) {
    if (!(node instanceof Element)) return false;
    if (node.matches('[role="button"], button')) return false;

    var childButton = node.querySelector('button, [role="button"]');
    if (!childButton) return false;

    var text = (node.innerText || '').trim();
    return text.length < 32;
  }

  function createNativeShareButton(templateButton, article) {
    var wrapper = templateButton.closest('div') || templateButton;
    var clone = wrapper.cloneNode(true);
    var button = clone.matches('button, [role="button"]') ? clone : clone.querySelector('button, [role="button"]');

    clone.setAttribute(BUTTON_ATTR, '1');
    clone.setAttribute('data-testid', 'nativeShare');

    if (!button) {
      button = document.createElement('button');
      clone.appendChild(button);
    }

    resetInteractiveState(clone);
    button.setAttribute('aria-label', BUTTON_LABEL);
    button.setAttribute('title', BUTTON_LABEL);
    button.setAttribute('type', 'button');

    replaceIcon(clone);
    replaceVisibleText(clone);

    clone.addEventListener('click', function (event) {
      onNativeShareClick(event, article);
    }, true);

    clone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        onNativeShareClick(event, article);
      }
    }, true);

    return clone;
  }

  function resetInteractiveState(root) {
    var nodes = root.querySelectorAll('[id], [aria-expanded], [aria-haspopup], [data-testid]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('id');
      nodes[i].removeAttribute('aria-expanded');
      nodes[i].removeAttribute('aria-haspopup');
      if (nodes[i].getAttribute('data-testid') !== 'nativeShare') {
        nodes[i].removeAttribute('data-testid');
      }
    }
  }

  function replaceIcon(root) {
    var svg = root.querySelector('svg');
    if (!svg) return;

    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var ns = 'http://www.w3.org/2000/svg';
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 3.25 7.75 7.5l1.06 1.06 2.44-2.44V15h1.5V6.12l2.44 2.44 1.06-1.06L12 3.25ZM5 11h3v1.5H5.5v6h13v-6H16V11h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z');
    svg.appendChild(path);
  }

  function replaceVisibleText(root) {
    var spans = root.querySelectorAll('span');

    for (var i = 0; i < spans.length; i++) {
      var text = (spans[i].textContent || '').trim();
      if (!text || /^share$/i.test(text) || /^\d+[KMB]?$/.test(text)) {
        spans[i].textContent = '';
      }
    }
  }

  function onNativeShareClick(event, article) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    var shareData = buildShareData(article);
    console.info(TAG, 'sharing', shareData);

    if (typeof navigator.share === 'function' && canShare(shareData)) {
      navigator.share(shareData).catch(function (err) {
        if (err && err.name !== 'AbortError') {
          console.warn(TAG, 'native share failed, falling back to clipboard', err);
          fallbackCopy(shareData);
        }
      });
      return;
    }

    fallbackCopy(shareData);
  }

  function canShare(shareData) {
    if (typeof navigator.canShare !== 'function') return true;

    try {
      return navigator.canShare(shareData);
    } catch (err) {
      return false;
    }
  }

  function buildShareData(article) {
    var currentArticle = article && article.isConnected ? article : pickArticle();
    var text = cleanText(extractText(currentArticle));
    var author = cleanText(extractAuthor(currentArticle));
    var url = resolvePostUrl(currentArticle) || stripTracking(location.href);
    var title = author || getArticleTitle() || 'X post';

    return {
      title: title,
      text: text ? text + '\n\n' + url : url,
      url: url
    };
  }

  function pickArticle() {
    var focused = document.querySelector('article[tabindex="-1"]');
    if (focused) return focused;

    if (location.pathname.indexOf('/article/') !== -1) {
      return document.querySelector('[data-testid="twitterArticleReadView"]');
    }

    return document.querySelector('article');
  }

  function extractText(article) {
    var articleTitle = getArticleTitle();
    var richArticle = getRichArticleText();

    if (richArticle) {
      return joinParts([articleTitle, richArticle]);
    }

    if (!article) return '';

    var tweetTexts = article.querySelectorAll('[data-testid="tweetText"]');
    if (tweetTexts.length > 0) {
      return joinNodeText(tweetTexts);
    }

    var quotedTweetTexts = article.querySelectorAll('[data-testid="tweetText"], [data-testid="quotedTweet"] [dir="auto"]');
    if (quotedTweetTexts.length > 0) {
      return joinNodeText(quotedTweetTexts);
    }

    return trimUiText(article.innerText || '');
  }

  function getArticleTitle() {
    var title = document.querySelector('[data-testid="twitter-article-title"]');
    return title ? title.innerText : '';
  }

  function getRichArticleText() {
    var richView = document.querySelector('[data-testid="twitterArticleRichTextView"]');
    return richView ? richView.innerText : '';
  }

  function extractAuthor(article) {
    if (!article) return '';

    var userName = article.querySelector('[data-testid="User-Name"]');
    if (!userName) return '';

    return firstUsefulLine(userName.innerText || '');
  }

  function resolvePostUrl(article) {
    if (article) {
      var links = article.querySelectorAll('a[href*="/status/"], a[href*="/article/"]');

      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href') || '';
        if (href.indexOf('/analytics') !== -1) continue;

        try {
          var url = new URL(href, location.origin);
          if (url.pathname.indexOf('/status/') !== -1 || url.pathname.indexOf('/article/') !== -1) {
            return stripTracking(url.href);
          }
        } catch (err) {}
      }
    }

    if (location.pathname.indexOf('/status/') !== -1 || location.pathname.indexOf('/article/') !== -1) {
      return stripTracking(location.href);
    }

    return '';
  }

  function stripTracking(rawUrl) {
    try {
      var url = new URL(rawUrl, location.origin);
      url.search = '';
      url.hash = '';
      return url.href;
    } catch (err) {
      return rawUrl;
    }
  }

  function joinNodeText(nodes) {
    var parts = [];

    for (var i = 0; i < nodes.length; i++) {
      var text = cleanText(nodes[i].innerText || '');
      if (text && parts.indexOf(text) === -1) parts.push(text);
    }

    return parts.join('\n\n');
  }

  function joinParts(parts) {
    var result = [];

    for (var i = 0; i < parts.length; i++) {
      var text = cleanText(parts[i] || '');
      if (text && result.indexOf(text) === -1) result.push(text);
    }

    return result.join('\n\n');
  }

  function cleanText(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function trimUiText(text) {
    var lines = cleanText(text).split('\n');
    var kept = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || isUiLine(line)) continue;
      kept.push(line);
    }

    return kept.join('\n');
  }

  function firstUsefulLine(text) {
    var lines = cleanText(text).split('\n');

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line && line.charAt(0) !== '@') return line;
    }

    return '';
  }

  function isUiLine(line) {
    return /^(Reply|Repost|Quote|Like|Bookmark|Share|Views|View post analytics|Show more|Translate post)$/i.test(line) ||
      /^\d+[,.]?\d*[KMB]?$/i.test(line);
  }

  function fallbackCopy(shareData) {
    var text = shareData.text || shareData.url || '';

    if (!text) return;

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        console.info(TAG, 'copied share text to clipboard');
      }).catch(function (err) {
        console.warn(TAG, 'clipboard fallback failed', err);
      });
    }
  }

  var observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
