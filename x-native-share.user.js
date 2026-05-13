// ==UserScript==
// @name         X Native Share
// @namespace    local.x.native-share
// @version      0.1.0
// @description  Adds a "Share via system…" entry to X/Twitter's share dropdown that opens the OS share sheet (iOS Safari) with the post text and URL.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://*.twitter.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const MARKER_ATTR = 'data-tm-x-native-share';

  // Track which post's share button was last clicked. The dropdown renders in
  // a portal with no DOM link back to the post, so we cache the owning
  // <article> at click time (capture phase, before React handles it) and read
  // it back when the user picks our menu entry.
  const context = {
    article: null,
    url: '',
    at: 0,
  };

  document.addEventListener(
    'click',
    (event) => {
      const path = event.composedPath ? event.composedPath() : [event.target];
      for (const node of path) {
        if (!(node instanceof Element)) continue;
        if (isShareTrigger(node)) {
          context.article = node.closest('article');
          context.url = location.href;
          context.at = Date.now();
          return;
        }
      }
    },
    true,
  );

  function isShareTrigger(node) {
    if (!node.matches) return false;
    // X's share affordance has used both of these over time; cover both.
    if (node.matches('button[aria-label="Share post" i], button[aria-label*="share post" i]')) return true;
    if (node.matches('[data-testid="share"], [data-testid="Share"]')) return true;
    return false;
  }

  // Continuously scan for share dropdowns. React may re-render the menu while
  // it's open, so a single addedNodes check isn't enough — we re-inject any
  // time our marker is missing from a live dropdown.
  const observer = new MutationObserver(() => {
    for (const dropdown of document.querySelectorAll('[data-testid="Dropdown"]')) {
      if (!dropdown.querySelector(`[${MARKER_ATTR}]`)) injectMenuItem(dropdown);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function injectMenuItem(dropdown) {
    const template = dropdown.querySelector('[role="menuitem"]');
    if (!template) return;

    const item = template.cloneNode(true);
    item.setAttribute(MARKER_ATTR, '1');

    const svg = item.querySelector('svg');
    if (svg) {
      // iOS-style share glyph: square box with an upward arrow rising out of
      // it. Distinct from X's existing "Share post via …" up-arrow.
      svg.innerHTML =
        '<g><path d="M12 2 8 6h3v10h2V6h3l-4-4zM20 8h-4v2h4v10H4V10h4V8H4c-1.1 0-2 .9-2 2v10c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z"/></g>';
    }

    const label = item.querySelector('span');
    if (label) label.textContent = 'Share via system…';

    item.addEventListener('click', onMenuItemClick, true);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') onMenuItemClick(event);
    }, true);

    dropdown.insertBefore(item, dropdown.firstElementChild);
  }

  function onMenuItemClick(event) {
    // Block React's delegated handlers on sibling items; they only run on the
    // originals, but stopping propagation here also keeps clicks from leaking
    // through to backdrop dismissers before we've built the share payload.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const data = buildShareData();

    // Close the dropdown — Escape is what X's menu listens for. We do this
    // before .share() so the menu disappears as the iOS share sheet animates
    // in, rather than peeking out behind it.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }),
    );

    // navigator.share() MUST be invoked synchronously from inside the user
    // gesture stack. Don't await anything above this line.
    if (typeof navigator.share === 'function') {
      const promise = navigator.share(data);
      if (promise && typeof promise.catch === 'function') {
        promise.catch((err) => {
          if (err && err.name !== 'AbortError') {
            console.warn('[x-native-share] share failed:', err);
            fallbackCopy(data);
          }
        });
      }
    } else {
      fallbackCopy(data);
    }
  }

  function buildShareData() {
    const article = pickArticle();
    const text = extractText(article);
    const author = extractAuthor(article);
    const url = resolvePostUrl(article) || (Date.now() - context.at < 5000 ? context.url : location.href);

    // iOS Safari behaviour: if both `text` and `url` are present, some
    // receiving apps drop one or the other. Inline the URL into `text` so the
    // body is always self-contained, but keep `url` populated for apps that
    // specifically want the link (e.g. browsers, link-saving apps).
    const body = text ? `${text}\n\n${url}` : url;

    return {
      title: author || 'X post',
      text: body,
      url,
    };
  }

  function pickArticle() {
    if (context.article && context.article.isConnected && Date.now() - context.at < 5000) {
      return context.article;
    }
    // On dedicated /status/<id> or /article/<id> pages there's usually a
    // focused article with tabindex="-1". Fall back to the first <article>.
    return document.querySelector('article[tabindex="-1"]') || document.querySelector('article');
  }

  function extractText(article) {
    if (!article) return '';

    // Standard tweet body. Multiple nodes appear when the post quotes another
    // tweet; join with a blank line so the quoted body reads as its own
    // paragraph in the share sheet.
    const tweetTexts = article.querySelectorAll('[data-testid="tweetText"]');
    if (tweetTexts.length > 0) {
      return Array.from(tweetTexts)
        .map((el) => el.innerText.trim())
        .filter(Boolean)
        .join('\n\n');
    }

    // Long-form X Articles use a different layout. Sweep the article for
    // anything paragraph-shaped and stitch it together.
    const paras = article.querySelectorAll('h1, h2, h3, p, [data-testid="article-content"] *');
    if (paras.length > 0) {
      const seen = new Set();
      const lines = [];
      for (const el of paras) {
        const t = el.innerText && el.innerText.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        lines.push(t);
      }
      if (lines.length > 0) return lines.join('\n\n');
    }

    return (article.innerText || '').trim();
  }

  function extractAuthor(article) {
    if (!article) return '';
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    if (!nameEl) return '';
    return nameEl.innerText.replace(/\s+/g, ' ').trim();
  }

  function resolvePostUrl(article) {
    if (article) {
      // The status/article URL is the parent <a> of the timestamp <time> node.
      const timeEl = article.querySelector('time');
      const link = timeEl && timeEl.closest('a[href*="/status/"], a[href*="/article/"]');
      if (link) {
        try {
          return new URL(link.getAttribute('href'), location.origin).href;
        } catch {
          /* fall through */
        }
      }
    }

    // Last resort: location.href is canonical when we're on a status/article page.
    if (/\/(status|article)\/\d+/.test(location.pathname)) return location.href;
    return '';
  }

  function fallbackCopy(data) {
    const text = data.text || data.url || '';
    if (!text || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard
      .writeText(text)
      .then(() => console.info('[x-native-share] Web Share unavailable — copied to clipboard.'))
      .catch(() => {});
  }
})();
