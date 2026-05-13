// ==UserScript==
// @name         X Native Share
// @namespace    local.x.native-share
// @version      0.2.0
// @description  Adds an "Open share sheet…" entry to X/Twitter's share dropdown that opens the OS share sheet (iOS Safari) with the post text and URL.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @match        https://*.twitter.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[x-native-share]';
  const MARKER_ATTR = 'data-tm-x-native-share';
  console.info(TAG, 'script loaded, version 0.2.0');

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
          // On /status/ pages the focal post is wrapped in <article>. On
          // /article/ pages it's a <div data-testid="twitterArticleReadView">
          // with no <article> tag, so try both.
          context.article =
            node.closest('article') ||
            node.closest('[data-testid="twitterArticleReadView"]') ||
            null;
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
  function scanDropdowns() {
    const dropdowns = document.querySelectorAll('[data-testid="Dropdown"]');
    for (const dropdown of dropdowns) {
      if (dropdown.querySelector(`[${MARKER_ATTR}]`)) continue;
      try {
        injectMenuItem(dropdown);
      } catch (err) {
        console.warn(TAG, 'injection failed:', err);
      }
    }
  }

  const observer = new MutationObserver(scanDropdowns);
  // Observe documentElement rather than body — some runners attach the script
  // before body's subtree is stable, and X may render popovers into a portal
  // that briefly sits outside body during animation.
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Initial sweep in case a dropdown is already open when the script loads.
  scanDropdowns();
  console.info(TAG, 'observer attached');

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function injectMenuItem(dropdown) {
    const template = dropdown.querySelector('[role="menuitem"]');
    if (!template) {
      console.info(TAG, 'dropdown found but no menuitem template yet — waiting');
      return;
    }

    const item = template.cloneNode(true);
    item.setAttribute(MARKER_ATTR, '1');

    // Replace the cloned SVG's contents using the SVG namespace. Setting
    // innerHTML on an <svg> has worked in modern browsers for years, but
    // historical Safari quirks make namespaced construction the safer path.
    const svg = item.querySelector('svg');
    if (svg) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const g = document.createElementNS(SVG_NS, 'g');
      const path = document.createElementNS(SVG_NS, 'path');
      // iOS-style share glyph: square box with an upward arrow rising out.
      path.setAttribute(
        'd',
        'M12 2 8 6h3v10h2V6h3l-4-4zM20 8h-4v2h4v10H4V10h4V8H4c-1.1 0-2 .9-2 2v10c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z',
      );
      g.appendChild(path);
      svg.appendChild(g);
    }

    // Use a label that doesn't share a prefix with X's "Share post via …" so
    // it's obvious in the menu (and obvious in screenshots if it's missing).
    const label = item.querySelector('span');
    if (label) label.textContent = 'Open share sheet…';

    item.addEventListener('click', onMenuItemClick, true);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') onMenuItemClick(event);
    }, true);

    dropdown.insertBefore(item, dropdown.firstElementChild);
    console.info(TAG, 'menu item injected into dropdown');
  }

  function onMenuItemClick(event) {
    // Block React's delegated handlers on sibling items; they only run on the
    // originals, but stopping propagation here also keeps clicks from leaking
    // through to backdrop dismissers before we've built the share payload.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const data = buildShareData();
    console.info(TAG, 'menu item clicked; share payload:', {
      title: data.title,
      textChars: data.text ? data.text.length : 0,
      url: data.url,
    });

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
    // /article/<id> pages: the share button sits in a top toolbar that's not
    // a descendant of the read view, so closest() yielded nothing. Resolve
    // the body container directly from the page URL.
    if (/\/article\/\d+/.test(location.pathname)) {
      const readView = document.querySelector('[data-testid="twitterArticleReadView"]');
      if (readView) return readView;
    }
    // /status/<id> pages: the focused tweet has tabindex="-1".
    return document.querySelector('article[tabindex="-1"]') || document.querySelector('article');
  }

  function extractText(container) {
    if (!container) return '';

    // 1. Tweets — multiple [data-testid="tweetText"] nodes appear when the
    //    post quotes another tweet; join with a blank line so the quoted body
    //    reads as its own paragraph.
    const tweetTexts = container.querySelectorAll('[data-testid="tweetText"]');
    if (tweetTexts.length > 0) {
      return Array.from(tweetTexts)
        .map((el) => el.innerText.trim())
        .filter(Boolean)
        .join('\n\n');
    }

    // 2. Long-form X Articles — the rich-text view holds the body, the title
    //    is a sibling under the read view. Verified against kepano/defuddle
    //    and koredeycode/x-articles-exporter.
    const richTextView =
      container.querySelector('[data-testid="twitterArticleRichTextView"]') ||
      document.querySelector('[data-testid="twitterArticleRichTextView"]');
    if (richTextView) {
      const titleEl =
        container.querySelector('[data-testid="twitter-article-title"]') ||
        document.querySelector('[data-testid="twitter-article-title"]');
      const title = titleEl ? titleEl.innerText.trim() : '';
      const body = (richTextView.innerText || '').trim();
      const combined = [title, body].filter(Boolean).join('\n\n');
      if (combined) return combined;
    }

    // 3. DraftJS fallback — if X renames the rich-text testid, the body still
    //    renders into a DraftEditor surface.
    const editor =
      container.querySelector('.DraftEditor-editorContainer') ||
      document.querySelector('.DraftEditor-editorContainer');
    if (editor) {
      const body = (editor.innerText || '').trim();
      if (body) return body;
    }

    // 4. Last resort — whatever text the container itself yields.
    return (container.innerText || '').trim();
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
