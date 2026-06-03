/**
 * MusicFlow — content.js
 * Injected on YouTube pages to skip/mute ads automatically.
 * Works independently of the popup player.
 */

(function () {
  'use strict';

  const AD_SELECTORS = [
    '.ytp-ad-skip-button',          // Skip Ad button
    '.ytp-skip-ad-button',          // Alternative skip button
    '.ytp-ad-skip-button-modern',   // Modern skip button
  ];

  const AD_OVERLAY_SELECTORS = [
    '.ytp-ad-overlay-close-button', // Overlay close
    '.ytp-ad-overlay-close',
  ];

  let adCheckInterval = null;

  function trySkipAd() {
    // Click skip buttons
    AD_SELECTORS.forEach(sel => {
      const btn = document.querySelector(sel);
      if (btn) btn.click();
    });

    // Close overlay ads
    AD_OVERLAY_SELECTORS.forEach(sel => {
      const btn = document.querySelector(sel);
      if (btn) btn.click();
    });

    // If an ad is playing, mute and speed it up
    const video = document.querySelector('video');
    const adBadge = document.querySelector('.ytp-ad-player-overlay');

    if (adBadge && video) {
      // Speed up the ad so it finishes faster
      if (video.playbackRate < 10) video.playbackRate = 16;
      // Mute during ad
      video.muted = true;
    } else if (video && video.playbackRate !== 1) {
      // Restore normal speed when ad is gone
      video.playbackRate = 1;
      video.muted = false;
    }
  }

  function startAdBlocker() {
    adCheckInterval = setInterval(trySkipAd, 300);
  }

  function stopAdBlocker() {
    if (adCheckInterval) {
      clearInterval(adCheckInterval);
      adCheckInterval = null;
    }
  }

  // Start when page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAdBlocker);
  } else {
    startAdBlocker();
  }

  // Re-run on YouTube SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      stopAdBlocker();
      setTimeout(startAdBlocker, 500);
    }
  }).observe(document, { subtree: true, childList: true });
})();
