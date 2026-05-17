// ==UserScript==
// @name         Image File Saver
// @namespace    local.image-file-saver
// @version      0.2.4
// @description  Adds an upper-right Save button to web images so iPhone Safari can save/share them as image files instead of only adding them to Photos.
// @match        https://*/*
// @match        http://*/*
// @grant        GM_download
// @grant        GM.download
// @run-at       document-idle
// ==/UserScript==

/* global GM_download, GM */

(function () {
  'use strict';

  const TAG = '[image-file-saver]';
  const STYLE_ID = 'tm-imgfs-style';
  const HOST_CLASS = 'tm-imgfs-host';
  const BUTTON_CLASS = 'tm-imgfs-button';
  const TOAST_CLASS = 'tm-imgfs-toast';
  const ENHANCED_ATTR = 'data-tm-imgfs-enhanced';
  const LOAD_LISTENER_ATTR = 'data-tm-imgfs-load-listener';
  const MIN_IMAGE_SIZE = 80;

  const toastTimers = new WeakMap();
  let scanScheduled = false;

  injectStyles();
  start();

  function start() {
    scan();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style', 'data-testid']
    });

    window.addEventListener('load', scheduleScan, { once: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scan();
    });
  }

  function scan() {
    for (const image of document.querySelectorAll('img')) {
      enhanceImage(image);
    }

    for (const node of document.querySelectorAll('[style*="background-image"]')) {
      const url = getBackgroundImageUrl(node);
      if (url) enhanceImage(makeVirtualImage(node, url));
    }
  }

  function enhanceImage(image) {
    watchImageLoad(image);
    if (!image || !image.isConnected || !isUsableImage(image)) return;

    const host = findOverlayHost(image);
    if (!host) return;

    const existingButton = findExistingButton(host);
    if (existingButton) {
      updateButtonSource(existingButton, image);
      updateButtonPlacement(existingButton, image, host);
      return;
    }

    if (host.getAttribute(ENHANCED_ATTR) === '1') return;

    host.classList.add(HOST_CLASS);
    host.setAttribute(ENHANCED_ATTR, '1');

    const button = createButton();
    updateButtonSource(button, image);
    updateButtonPlacement(button, image, host);
    host.append(button);
  }

  function watchImageLoad(image) {
    if (!(image instanceof HTMLImageElement) || image.complete || image.getAttribute(LOAD_LISTENER_ATTR) === '1') return;
    image.setAttribute(LOAD_LISTENER_ATTR, '1');
    image.addEventListener('load', scheduleScan, { once: true });
  }

  function findExistingButton(host) {
    return [...host.children].find(child => child.classList?.contains(BUTTON_CLASS)) || null;
  }

  function updateButtonSource(button, image) {
    const url = getImageUrl(image);
    if (url) button.dataset.sourceUrl = url;
    button.dataset.alt = image.alt || '';
  }

  function updateButtonPlacement(button, image, host) {
    const sourceNode = getSourceElement(image);
    if (!(button instanceof HTMLElement) || !(host instanceof HTMLElement) || !sourceNode?.getBoundingClientRect) return;

    const imageRect = sourceNode.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height || !hostRect.width || !hostRect.height) return;

    const top = clamp(imageRect.top - hostRect.top + 10, 10, Math.max(10, hostRect.height - 42));
    const right = clamp(hostRect.right - imageRect.right + 10, 10, Math.max(10, hostRect.width - 42));
    button.style.setProperty('--tm-imgfs-top', Math.round(top) + 'px');
    button.style.setProperty('--tm-imgfs-right', Math.round(right) + 'px');
  }

  function isUsableImage(image) {
    const rect = image.getBoundingClientRect();
    return rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE && Boolean(getImageUrl(image));
  }

  function getImageUrl(image) {
    return image?.currentSrc || image?.src || image?.getAttribute?.('src') || '';
  }

  function getBackgroundImageUrl(node) {
    if (!(node instanceof HTMLElement)) return '';
    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_IMAGE_SIZE || rect.height < MIN_IMAGE_SIZE) return '';

    const match = (getComputedStyle(node).backgroundImage || '').match(/url\((['"]?)(.*?)\1\)/);
    return match ? match[2] : '';
  }

  function makeVirtualImage(node, url) {
    return {
      __tmImgFsVirtual: true,
      currentSrc: url,
      src: url,
      alt: node.getAttribute('aria-label') || node.getAttribute('title') || '',
      getBoundingClientRect: () => node.getBoundingClientRect(),
      parentElement: node,
      isConnected: node.isConnected
    };
  }

  function findOverlayHost(image) {
    const sourceNode = getSourceElement(image);
    if (!(sourceNode instanceof HTMLElement)) return null;

    const xMediaHost = sourceNode.closest('[data-testid="tweetPhoto"], [data-testid="card.layoutLarge.media"], [data-testid="card.layoutSmall.media"]');
    if (xMediaHost instanceof HTMLElement) return xMediaHost;

    const anchor = sourceNode.closest('a');
    if (anchor instanceof HTMLElement) {
      const rect = anchor.getBoundingClientRect();
      if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE) return anchor;
    }

    return sourceNode.parentElement instanceof HTMLElement ? sourceNode.parentElement : sourceNode;
  }

  function getSourceElement(image) {
    return image?.__tmImgFsVirtual ? image.parentElement : image;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.setAttribute('aria-label', 'Save image file');
    button.title = 'Save image file';
    button.innerHTML = [
      '<svg class="tm-imgfs-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none">',
      '<path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
      '</svg>'
    ].join('');
    button.addEventListener('click', onSaveClick, true);
    return button;
  }

  async function onSaveClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const button = event.currentTarget;
    const host = button.parentElement || document.body;
    const image = host.querySelector('img');
    const liveUrl = getImageUrl(image);
    const url = liveUrl || button.dataset.sourceUrl || '';
    if (liveUrl) button.dataset.sourceUrl = liveUrl;

    if (!url) {
      flashButton(button, 'error');
      showToast(host, 'No image URL found.', 'error');
      return;
    }

    button.classList.add(BUTTON_CLASS + '--busy');
    try {
      const file = await getImageFile(url, image, host, button.dataset.alt || '');
      await saveFile(file, url);
      flashButton(button, 'done');
      showToast(host, 'Saved: ' + file.name, 'done');
    } catch (error) {
      console.warn(TAG, 'save failed:', error);
      flashButton(button, 'error');
      try {
        await shareUrl(url);
        flashButton(button, 'done');
        showToast(host, 'Shared image URL.', 'done');
      } catch (shareError) {
        console.warn(TAG, 'URL share fallback failed:', shareError);
        showToast(host, 'Save failed: ' + (error?.message || error), 'error');
        fallbackOpen(url);
      }
    } finally {
      button.classList.remove(BUTTON_CLASS + '--busy');
    }
  }

  async function getImageFile(url, image, host, alt) {
    const normalizedUrl = normalizeImageUrl(url);
    const response = await fetch(normalizedUrl, { credentials: 'include' });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const blob = await response.blob();
    if (!blob || blob.size === 0) throw new Error('empty image');

    const type = blob.type || guessMimeType(normalizedUrl) || 'image/jpeg';
    return new File([blob], buildFilename(normalizedUrl, image, host, alt, type), { type });
  }

  async function saveFile(file, sourceUrl) {
    const gmDownload =
      (typeof GM_download === 'function' && GM_download) ||
      (typeof GM !== 'undefined' && typeof GM.download === 'function' && GM.download.bind(GM));

    if (gmDownload) {
      await gmDownloadFile(gmDownload, sourceUrl, file.name);
      return;
    }

    if (canShareFile(file)) {
      await navigator.share({ files: [file], title: file.name });
      return;
    }

    try {
      await shareUrl(sourceUrl);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      downloadBlob(file);
    }
  }

  function canShareFile(file) {
    if (typeof navigator.share !== 'function') return false;
    if (typeof navigator.canShare !== 'function') return true;
    try {
      return navigator.canShare({ files: [file] });
    } catch {
      return false;
    }
  }

  async function shareUrl(url) {
    if (typeof navigator.share !== 'function') {
      throw new Error('navigator.share unavailable');
    }
    await navigator.share({
      title: 'Image',
      url: normalizeImageUrl(url)
    });
  }

  function gmDownloadFile(gmDownload, url, name) {
    return new Promise((resolve, reject) => {
      try {
        gmDownload({
          url: normalizeImageUrl(url),
          name,
          saveAs: false,
          onload: () => resolve(),
          onerror: err => reject(new Error(err?.error || err?.details || 'GM_download failed')),
          ontimeout: () => reject(new Error('download timed out'))
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function downloadBlob(file) {
    const objectUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = file.name;
    link.rel = 'noopener';
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }

  function fallbackOpen(url) {
    window.open(normalizeImageUrl(url), '_blank', 'noopener');
  }

  function normalizeImageUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      if (/pbs\.twimg\.com$/i.test(parsed.hostname) && parsed.pathname.includes('/media/')) {
        parsed.searchParams.set('name', 'orig');
      }
      return parsed.href;
    } catch {
      return url;
    }
  }

  function buildFilename(url, image, host, alt, mimeType) {
    const ext = extensionFromMime(mimeType) || extensionFromUrl(url) || 'jpg';
    const tweetId = getTweetIdFromUrl(location.href) || getTweetIdFromClosestLink(host || image);
    const cleanAlt = sanitizeFilename(alt || image?.alt || '');
    const suffix = cleanAlt ? '-' + cleanAlt.slice(0, 42) : '';
    const prefix = tweetId ? 'x-' + tweetId : 'image-' + timestamp();
    return ensureExtension(prefix + suffix, ext);
  }

  function getTweetIdFromClosestLink(node) {
    const sourceNode = getSourceElement(node);
    const article = sourceNode instanceof Element ? sourceNode.closest('article') : null;
    const timeLink = article?.querySelector('time')?.closest('a[href*="/status/"]');
    return getTweetIdFromUrl(timeLink?.href || '');
  }

  function getTweetIdFromUrl(value) {
    try {
      return new URL(value, location.origin).pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] || '';
    } catch {
      return '';
    }
  }

  function ensureExtension(name, ext) {
    const clean = sanitizeFilename(name) || 'image-' + timestamp();
    return /\.[a-z0-9]{2,5}$/i.test(clean) ? clean : clean + '.' + ext;
  }

  function sanitizeFilename(value) {
    return String(value || '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120);
  }

  function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  }

  function guessMimeType(url) {
    const ext = extensionFromUrl(url);
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'avif') return 'image/avif';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return '';
  }

  function extensionFromMime(mimeType) {
    if (/png/i.test(mimeType)) return 'png';
    if (/gif/i.test(mimeType)) return 'gif';
    if (/webp/i.test(mimeType)) return 'webp';
    if (/avif/i.test(mimeType)) return 'avif';
    if (/svg/i.test(mimeType)) return 'svg';
    if (/jpe?g/i.test(mimeType)) return 'jpg';
    return '';
  }

  function extensionFromUrl(url) {
    try {
      const match = new URL(url, location.href).pathname.match(/\.([a-z0-9]{2,5})$/i);
      return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : '';
    } catch {
      return '';
    }
  }

  function flashButton(button, state) {
    button.dataset.imgfsFlash = state;
    setTimeout(() => {
      if (button.dataset.imgfsFlash === state) delete button.dataset.imgfsFlash;
    }, 900);
  }

  function showToast(host, message, state) {
    const toast = getToast(host);
    toast.textContent = message;
    toast.title = message;
    toast.dataset.imgfsState = state;
    toast.classList.add(TOAST_CLASS + '--visible');

    clearTimeout(toastTimers.get(toast));
    toastTimers.set(toast, setTimeout(() => {
      toast.classList.remove(TOAST_CLASS + '--visible');
    }, state === 'error' ? 6000 : 3600));
  }

  function getToast(host) {
    const existing = [...host.children].find(c => c.classList?.contains(TOAST_CLASS));
    if (existing instanceof HTMLElement) return existing;

    const toast = document.createElement('div');
    toast.className = TOAST_CLASS;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    host.append(toast);
    return toast;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    const css = [
      '.' + HOST_CLASS + ' { position: relative !important; }',
      '.' + BUTTON_CLASS + ' { all: unset; align-items: center; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); background: rgba(0, 0, 0, 0.66); border: 1px solid rgba(255, 255, 255, 0.24); border-radius: 6px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28); box-sizing: border-box; color: #ffffff; cursor: pointer; display: inline-flex; height: 32px; justify-content: center; padding: 0; position: absolute; right: var(--tm-imgfs-right, 10px); top: var(--tm-imgfs-top, 10px); transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease, transform 120ms ease; user-select: none; width: 32px; z-index: 2147483647; }',
      '.' + BUTTON_CLASS + ' svg { display: block; flex: 0 0 auto; height: 15px; pointer-events: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 3; width: 15px; }',
      '.' + BUTTON_CLASS + ':hover { background: rgba(29, 155, 240, 0.9); border-color: rgba(255, 255, 255, 0.45); }',
      '.' + BUTTON_CLASS + '--busy { opacity: 0.72; transform: scale(0.94); }',
      '.' + BUTTON_CLASS + '[data-imgfs-flash="done"] { background: rgba(0, 186, 124, 0.92); border-color: rgba(255, 255, 255, 0.5); }',
      '.' + BUTTON_CLASS + '[data-imgfs-flash="error"] { background: rgba(244, 33, 46, 0.92); border-color: rgba(255, 255, 255, 0.5); }',
      '.' + TOAST_CLASS + ' { -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); background: rgba(15, 20, 25, 0.92); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px; bottom: 10px; box-shadow: 0 14px 36px rgba(0, 0, 0, 0.32); box-sizing: border-box; color: #ffffff; display: block; font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; left: 10px; max-height: min(42%, 112px); opacity: 0; overflow: auto; padding: 10px 14px; pointer-events: none; position: absolute; right: 10px; text-align: center; transform: translateY(8px); transition: opacity 160ms ease, transform 160ms ease; white-space: normal; word-break: break-word; z-index: 2147483647; }',
      '.' + TOAST_CLASS + '--visible { opacity: 1; transform: translateY(0); }',
      '.' + TOAST_CLASS + '[data-imgfs-state="done"] { border-color: rgba(0, 186, 124, 0.5); }',
      '.' + TOAST_CLASS + '[data-imgfs-state="error"] { border-color: rgba(244, 33, 46, 0.58); }'
    ];
    style.textContent = css.join('\n');
    (document.head || document.documentElement).append(style);
  }
})();
