// ==UserScript==
// @name         YouTube Enhancements
// @namespace    local.youtube.enhancements
// @version      0.8.5
// @description  Remove YouTube thumbnails and Shorts, auto-unmute video pages, keep iOS background playback alive, and rotate-to-landscape fake fullscreen on iOS (manual trigger).
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'tm-youtube-enhancements-style';
  const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const IS_IOS = /iP(ad|hone|od)/.test(navigator.platform)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const BACKGROUND_PLAY_EVENTS = [
    'visibilitychange',
    'webkitvisibilitychange',
    'pagehide',
    'freeze',
    'blur'
  ];

  const THUMBNAIL_CONTAINER_SELECTOR = [
    'ytd-thumbnail',
    'ytd-playlist-thumbnail',
    'ytd-video-preview',
    'ytd-moving-thumbnail-renderer',
    'yt-thumbnail-view-model',
    'ytm-thumbnail',
    '.media-item-thumbnail-container',
    '.compact-media-item-image'
  ].join(',');

  const THUMBNAIL_IMAGE_SELECTOR = [
    'ytd-thumbnail img',
    'ytd-playlist-thumbnail img',
    'ytd-video-preview img',
    'ytd-moving-thumbnail-renderer img',
    'ytm-thumbnail img',
    '.media-item-thumbnail-container img',
    '.compact-media-item-image img',
    'a[href^="/watch"] img[src*="ytimg.com/vi"]',
    'a[href^="/shorts"] img[src*="ytimg.com/vi"]'
  ].join(',');

  const SHORTS_HIDE_SELECTOR = [
    // Dedicated Shorts shelves and the sections wrapping them
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-rich-section-renderer:has(ytd-reel-shelf-renderer)',
    'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    'ytd-reel-item-renderer',
    // Sidebar / mini-sidebar nav entries
    'ytd-guide-entry-renderer:has(a[title="Shorts"])',
    'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
    // Feed items (home grid, search, channel grid, watch-page sidebar) that point to a Short
    'ytd-rich-item-renderer:has(a[href*="/shorts/"])',
    'ytd-video-renderer:has(a[href*="/shorts/"])',
    'ytd-grid-video-renderer:has(a[href*="/shorts/"])',
    'ytd-compact-video-renderer:has(a[href*="/shorts/"])',
    // Mobile (m.youtube.com)
    'ytm-reel-shelf-renderer',
    'ytm-shorts-lockup-view-model',
    // Bottom pivot-bar Shorts tab — these *do* fire in the iOS Safari render
    // (verified: removing them in v0.7.5 left the tab tappable). Don't remove
    // them again without confirming via DevTools that they match nothing.
    'ytm-pivot-bar-item-renderer[tab-identifier="FEshorts"]',
    'ytm-pivot-bar-item-renderer:has(a[href^="/shorts"])',
    'ytm-pivot-bar-item-renderer:has([aria-label="Shorts" i])',
    'ytm-pivot-bar-item-renderer:has([role="tab"][aria-label="Shorts" i])'
  ].join(',');

  // Stable semantic signals YouTube has to keep for accessibility/routing,
  // regardless of how often they rename the wrapper element.
  const SHORTS_TAB_ANCHOR_SELECTOR = '[aria-label="Shorts" i],[tab-identifier="FEshorts"]';
  // Walk up to one of these when hiding the Shorts tab — keep all variants:
  // the v0.7.5 attempt at consolidation regressed clicks on iOS Safari, where
  // a narrower pattern is the one actually reaching the tappable slot.
  const SHORTS_TAB_SLOT_SELECTOR = [
    'ytm-pivot-bar-item-renderer',
    'ytd-guide-entry-renderer',
    'ytd-mini-guide-entry-renderer',
    '[role="tab"]',
    '[class*="pivot-bar-item"]',
    '[class*="pivot-shorts"]',
    '[class*="bottom-bar-item"]',
    '[class*="pivot"]',
    '[class*="bottom-nav"]'
  ].join(',');
  // Renderers that wrap actual video content — never hide one of these even if
  // a descendant happens to have the text "Shorts" (e.g. a video titled "Shorts").
  const SHORTS_TAB_CONTENT_BLOCKLIST = [
    'ytd-video-renderer',
    'ytd-rich-item-renderer',
    'ytd-grid-video-renderer',
    'ytd-compact-video-renderer',
    'ytm-video-with-context-renderer',
    'ytm-compact-video-renderer'
  ].join(',');

  // Fake-fullscreen: bypass iOS native fullscreen (which strips our enhancements
  // and forces the system video player UI). Move the <video> into our own
  // wrapper appended to <body>, then rotate the wrapper. Two iOS pitfalls
  // motivate the reparent: (1) `position: fixed` is scoped to the nearest
  // transformed ancestor, and YouTube has plenty of those — leaving the video
  // in-place puts the rotated element off-screen even though audio plays;
  // (2) iOS Safari's compositor occasionally drops CSS transforms applied
  // directly to <video>, so we transform a div wrapper instead.
  const FAKE_FS_STYLE_ID = 'tm-youtube-fake-fullscreen-style';
  const FAKE_FS_WRAPPER_ID = 'tm-youtube-fake-fullscreen-wrapper';
  const FAKE_FS_DOC_CLASS = 'tm-youtube-fake-fullscreen-active';
  const FAKE_FS_BACKDROP_ID = 'tm-youtube-fake-fullscreen-backdrop';
  const FAKE_FS_EXIT_BTN_ID = 'tm-youtube-fake-fullscreen-exit';

  const FULLSCREEN_BUTTON_SELECTOR = [
    '.fullscreen-icon',
    '.ytp-fullscreen-button',
    '.player-controls-fullscreen-button',
    'button[aria-label*="Fullscreen" i]',
    'button[aria-label*="Full screen" i]',
    '[role="button"][aria-label*="Fullscreen" i]',
    '[role="button"][aria-label*="Full screen" i]'
  ].join(',');

  let scheduled = false;
  let unmuteTimer = null;
  let backgroundResumeUntil = 0;
  let backgroundResumeTimer = null;
  let fakeFullscreenActive = false;
  // { video, placeholder, wrapper } — captured on enter so exit can put the
  // video back exactly where YouTube had it. Placeholder is a comment node.
  let fakeFullscreenOrigin = null;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      ${THUMBNAIL_CONTAINER_SELECTOR},
      img[data-youtube-enhancements-thumbnail-disabled="true"] {
        display: none !important;
      }

      ${SHORTS_HIDE_SELECTOR} {
        display: none !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function isVideoPage() {
    return location.pathname === '/watch' || location.pathname.startsWith('/shorts/');
  }

  function redirectShortsToWatch() {
    const { pathname, search, hash } = location;

    if (pathname === '/shorts' || pathname === '/shorts/') {
      location.replace('/' + hash);
      return true;
    }

    const match = pathname.match(/^\/shorts\/([^/?#]+)/);
    if (!match) return false;

    const params = new URLSearchParams(search);
    params.set('v', match[1]);
    location.replace(`/watch?${params.toString()}${hash}`);
    return true;
  }

  function findShortsClickTarget(eventTarget) {
    if (!(eventTarget instanceof Element)) return null;
    // Anything pointing at /shorts via href — most reliable signal.
    const link = eventTarget.closest('a[href^="/shorts"], a[href*="youtube.com/shorts"]');
    if (link) return link;
    // Tab-shaped ancestor whose visible label is exactly "Shorts" — covers the
    // iOS Safari pivot-bar case where the tap target is a non-anchor element.
    const tab = eventTarget.closest('[role="tab"], [role="link"], [role="button"], button, ytm-pivot-bar-item-renderer');
    if (!tab) return null;
    const text = (tab.textContent || '').trim().toLowerCase();
    return text === 'shorts' ? tab : null;
  }

  function blockShortsClicks(event) {
    const target = findShortsClickTarget(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const href = target.getAttribute('href') || '';
    const idMatch = href.match(/\/shorts\/([^/?#]+)/);
    if (idMatch) {
      location.assign(`/watch?v=${encodeURIComponent(idMatch[1])}`);
    } else if (location.pathname !== '/') {
      location.assign('/');
    }
  }

  function shouldKeepBackgroundPlaybackAlive() {
    return IS_IOS && isVideoPage();
  }

  function isBackgroundResumeWindowActive() {
    return shouldKeepBackgroundPlaybackAlive() && Date.now() < backgroundResumeUntil;
  }

  function removeThumbnailElement(el) {
    if (!(el instanceof HTMLElement)) return;
    el.dataset.youtubeEnhancementsThumbnailRemoved = 'true';
    el.setAttribute('aria-hidden', 'true');
    el.style.setProperty('display', 'none', 'important');
  }

  function getThumbnailContainer(img) {
    if (!(img instanceof HTMLElement)) return null;
    return img.closest(THUMBNAIL_CONTAINER_SELECTOR) || img;
  }

  function disableThumbnailImage(img) {
    if (!(img instanceof HTMLImageElement)) return;

    img.dataset.youtubeEnhancementsThumbnailDisabled = 'true';
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    img.removeAttribute('data-srcset');
    img.removeAttribute('data-thumb');

    if (img.src !== BLANK_IMAGE) {
      img.src = BLANK_IMAGE;
    }

    removeThumbnailElement(getThumbnailContainer(img));
  }

  function disableThumbnails() {
    document.querySelectorAll(THUMBNAIL_CONTAINER_SELECTOR).forEach(removeThumbnailElement);
    document.querySelectorAll(THUMBNAIL_IMAGE_SELECTOR).forEach(disableThumbnailImage);
  }

  function hideShortsTabSlot(el) {
    if (!(el instanceof HTMLElement)) return;
    const slot = el.closest(SHORTS_TAB_SLOT_SELECTOR) || el;
    if (slot instanceof HTMLElement) {
      slot.dataset.youtubeEnhancementsShortsHidden = 'true';
      slot.style.setProperty('display', 'none', 'important');
    }
  }

  function hideShortsTabs() {
    // Pass 1: stable anchors (aria-label / tab-identifier).
    document.querySelectorAll(SHORTS_TAB_ANCHOR_SELECTOR).forEach(hideShortsTabSlot);

    // Pass 2: text-node sweep. Catches the iOS Safari mobile case where the
    // pivot-bar tab is a plain element (div / span / custom element) labeled
    // only by its visible text "Shorts" — element tag-agnostic by design.
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = (node.nodeValue || '').trim().toLowerCase();
        return text === 'shorts' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest(SHORTS_TAB_CONTENT_BLOCKLIST)) continue;
      hideShortsTabSlot(parent);
    }
  }

  function getActiveVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.find(video => !video.paused || video.readyState > 0) || videos[0] || null;
  }

  function unmuteVideo(video) {
    if (!isVideoPage() || !video) return false;

    video.defaultMuted = false;
    video.muted = false;
    video.removeAttribute('muted');

    return !video.muted;
  }

  function playVideo(video) {
    if (!video) return;

    try {
      const result = video.play();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      // Ignore browser-level play blocks.
    }
  }

  function resumeBackgroundVideo(video) {
    if (!isBackgroundResumeWindowActive() || !video) return;
    unmuteVideo(video);
    if (video.paused) playVideo(video);
  }

  function startBackgroundResumeWindow() {
    if (!shouldKeepBackgroundPlaybackAlive()) return;

    backgroundResumeUntil = Date.now() + 6000;
    if (backgroundResumeTimer) return;

    let tries = 0;
    backgroundResumeTimer = setInterval(() => {
      tries++;
      resumeBackgroundVideo(getActiveVideo());

      if (!isBackgroundResumeWindowActive() || tries >= 24) {
        clearInterval(backgroundResumeTimer);
        backgroundResumeTimer = null;
      }
    }, 250);
  }

  function preventBackgroundPauseEvent(event) {
    if (!shouldKeepBackgroundPlaybackAlive()) return;

    startBackgroundResumeWindow();
    event.stopImmediatePropagation();

    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  function hookVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.dataset.youtubeEnhancementsUnmuteHooked === 'true') return;

    video.dataset.youtubeEnhancementsUnmuteHooked = 'true';
    const maybeUnmute = () => unmuteVideo(video);

    video.addEventListener('loadedmetadata', maybeUnmute);
    video.addEventListener('canplay', maybeUnmute);
    video.addEventListener('playing', maybeUnmute);
    video.addEventListener('pause', () => resumeBackgroundVideo(video), true);
  }

  function hookVideos() {
    document.querySelectorAll('video').forEach(hookVideo);
  }

  function unmuteCurrentVideo() {
    return unmuteVideo(getActiveVideo());
  }

  function stopUnmuteTimer() {
    if (!unmuteTimer) return;
    clearInterval(unmuteTimer);
    unmuteTimer = null;
  }

  function startUnmuteWindow() {
    stopUnmuteTimer();
    if (!isVideoPage()) return;

    let tries = 0;
    unmuteTimer = setInterval(() => {
      hookVideos();

      tries++;
      if (unmuteCurrentVideo() || tries >= 24) {
        stopUnmuteTimer();
      }
    }, 250);
  }

  function ensureFakeFullscreenStyles() {
    if (document.getElementById(FAKE_FS_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = FAKE_FS_STYLE_ID;
    // The wrapper carries the rotation. Wrapper is appended to <body>, so
    // it has no transformed ancestor — `position: fixed` resolves to the
    // viewport. Video inside is a plain block sized to fill the wrapper;
    // the inline `width`/`height`/`top`/`left` YouTube sets on the <video>
    // are explicitly cleared so they don't fight our flex/fill rules.
    style.textContent = `
      html.${FAKE_FS_DOC_CLASS},
      html.${FAKE_FS_DOC_CLASS} body {
        overflow: hidden !important;
      }

      #${FAKE_FS_BACKDROP_ID} {
        position: fixed !important;
        inset: 0 !important;
        background: #000 !important;
        z-index: 2147483645 !important;
      }

      #${FAKE_FS_WRAPPER_ID} {
        position: fixed !important;
        top: 50vh !important;
        left: 50vw !important;
        top: 50dvh !important;
        left: 50dvw !important;
        width: 100vh !important;
        height: 100vw !important;
        width: 100dvh !important;
        height: 100dvw !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        transform: translate(-50%, -50%) rotate(90deg) !important;
        transform-origin: center center !important;
        background: #000 !important;
        z-index: 2147483646 !important;
        overflow: hidden !important;
      }

      #${FAKE_FS_WRAPPER_ID} video {
        display: block !important;
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        bottom: auto !important;
        transform: none !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        object-fit: contain !important;
        background: #000 !important;
      }

      #${FAKE_FS_EXIT_BTN_ID} {
        position: fixed !important;
        top: 16px !important;
        right: 16px !important;
        width: 44px !important;
        height: 44px !important;
        border-radius: 50% !important;
        border: 0 !important;
        background: rgba(0, 0, 0, 0.65) !important;
        color: #fff !important;
        font: 22px/44px -apple-system, system-ui, sans-serif !important;
        text-align: center !important;
        padding: 0 !important;
        cursor: pointer !important;
        z-index: 2147483647 !important;
        transform: rotate(90deg) !important;
        transform-origin: center !important;
        -webkit-tap-highlight-color: transparent !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBackdrop() {
    let backdrop = document.getElementById(FAKE_FS_BACKDROP_ID);
    if (backdrop) return backdrop;

    backdrop = document.createElement('div');
    backdrop.id = FAKE_FS_BACKDROP_ID;
    (document.body || document.documentElement).appendChild(backdrop);
    return backdrop;
  }

  function removeBackdrop() {
    const backdrop = document.getElementById(FAKE_FS_BACKDROP_ID);
    if (backdrop) backdrop.remove();
  }

  function ensureExitButton() {
    let btn = document.getElementById(FAKE_FS_EXIT_BTN_ID);
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = FAKE_FS_EXIT_BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Exit fake fullscreen');
    btn.textContent = '✕';
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      exitFakeFullscreen();
    }, true);

    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  function removeExitButton() {
    const btn = document.getElementById(FAKE_FS_EXIT_BTN_ID);
    if (btn) btn.remove();
  }

  function enterFakeFullscreen() {
    if (fakeFullscreenActive) return;
    const video = getActiveVideo();
    if (!video || !video.parentNode || !document.body) return;

    ensureFakeFullscreenStyles();
    fakeFullscreenActive = true;
    document.documentElement.classList.add(FAKE_FS_DOC_CLASS);
    ensureBackdrop();

    const wasPlaying = !video.paused;
    const placeholder = document.createComment('tm-yt-fakefs');
    video.parentNode.insertBefore(placeholder, video);

    const wrapper = document.createElement('div');
    wrapper.id = FAKE_FS_WRAPPER_ID;
    wrapper.appendChild(video);
    document.body.appendChild(wrapper);

    fakeFullscreenOrigin = { video, placeholder, wrapper };

    // Reparenting briefly detaches the <video>; some iOS Safari builds pause
    // it. Resume immediately to keep playback continuous.
    if (wasPlaying && video.paused) playVideo(video);

    ensureExitButton();
  }

  function exitFakeFullscreen() {
    if (!fakeFullscreenActive) return;
    fakeFullscreenActive = false;
    document.documentElement.classList.remove(FAKE_FS_DOC_CLASS);

    if (fakeFullscreenOrigin) {
      const { video, placeholder, wrapper } = fakeFullscreenOrigin;
      const wasPlaying = !video.paused;
      if (placeholder.parentNode) {
        placeholder.parentNode.insertBefore(video, placeholder);
        placeholder.remove();
      }
      if (wrapper.parentNode) wrapper.remove();
      fakeFullscreenOrigin = null;
      if (wasPlaying && video.paused) playVideo(video);
    }

    removeBackdrop();
    removeExitButton();
  }

  function handleFullscreenButtonClick(event) {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest(FULLSCREEN_BUTTON_SELECTOR);
    if (!target) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (fakeFullscreenActive) {
      exitFakeFullscreen();
    } else {
      enterFakeFullscreen();
    }
  }

  function patchFullscreenAPIs() {
    // YouTube's mobile player sometimes calls webkitEnterFullscreen() directly
    // on the <video>, bypassing the fullscreen button entirely. Redirect it.
    if (typeof HTMLVideoElement === 'undefined') return;
    const proto = HTMLVideoElement.prototype;

    if (typeof proto.webkitEnterFullscreen === 'function') {
      overrideMethod(proto, 'webkitEnterFullscreen', function () {
        enterFakeFullscreen();
      });
    }
    if (typeof proto.requestFullscreen === 'function') {
      overrideMethod(proto, 'requestFullscreen', function () {
        enterFakeFullscreen();
        return Promise.resolve();
      });
    }
  }

  function installFakeFullscreen() {
    if (!IS_IOS) return;
    ensureFakeFullscreenStyles();
    patchFullscreenAPIs();
    document.addEventListener('click', handleFullscreenButtonClick, true);
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && fakeFullscreenActive) exitFakeFullscreen();
    });
  }

  function runEnhancements() {
    ensureStyles();
    disableThumbnails();
    hideShortsTabs();
    hookVideos();
    unmuteCurrentVideo();
  }

  function scheduleEnhancements() {
    if (scheduled) return;

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      runEnhancements();
    });
  }

  function handleNavigation() {
    if (fakeFullscreenActive) exitFakeFullscreen();
    if (redirectShortsToWatch()) return;
    scheduleEnhancements();
    startUnmuteWindow();
  }

  function overrideProperty(target, name, value) {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        get: () => value
      });
    } catch {
      // Some browser properties are not configurable.
    }
  }

  function overrideMethod(target, name, fn) {
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        value: fn
      });
    } catch {
      // Some browser methods are not configurable.
    }
  }

  function forceVisiblePageState() {
    overrideProperty(document, 'hidden', false);
    overrideProperty(document, 'visibilityState', 'visible');
    overrideProperty(document, 'webkitHidden', false);
    overrideProperty(document, 'webkitVisibilityState', 'visible');
    overrideMethod(document, 'hasFocus', () => true);

    if (typeof Document !== 'undefined') {
      overrideProperty(Document.prototype, 'hidden', false);
      overrideProperty(Document.prototype, 'visibilityState', 'visible');
      overrideProperty(Document.prototype, 'webkitHidden', false);
      overrideProperty(Document.prototype, 'webkitVisibilityState', 'visible');
      overrideMethod(Document.prototype, 'hasFocus', () => true);
    }
  }

  function patchMediaPause() {
    const originalPause = HTMLMediaElement.prototype.pause;

    HTMLMediaElement.prototype.pause = function (...args) {
      if (this instanceof HTMLVideoElement && isBackgroundResumeWindowActive()) {
        resumeBackgroundVideo(this);
        return undefined;
      }

      return originalPause.apply(this, args);
    };
  }

  function installBackgroundPlaybackGuards() {
    if (!IS_IOS) return;

    forceVisiblePageState();
    patchMediaPause();

    BACKGROUND_PLAY_EVENTS.forEach(eventName => {
      window.addEventListener(eventName, preventBackgroundPauseEvent, true);
      document.addEventListener(eventName, preventBackgroundPauseEvent, true);
    });
  }

  function patchHistory() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      setTimeout(handleNavigation, 150);
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      setTimeout(handleNavigation, 150);
      return result;
    };
  }

  function startObserver() {
    if (!document.body) return;

    const observer = new MutationObserver(scheduleEnhancements);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style']
    });
  }

  function start() {
    ensureStyles();
    patchHistory();
    startObserver();
    handleNavigation();
  }

  window.addEventListener('yt-navigate-finish', handleNavigation);
  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('hashchange', handleNavigation);

  // Capture-phase click guard: even if every hide pass missed the Shorts tab,
  // intercept the click before YouTube's bubble-phase handlers see it.
  document.addEventListener('click', blockShortsClicks, true);

  installBackgroundPlaybackGuards();
  installFakeFullscreen();
  ensureStyles();

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
