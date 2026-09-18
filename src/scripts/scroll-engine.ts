/**
 * VKVstudio — Video Scroll Engine
 *
 * Tiered approach for scroll-driven video playback:
 *   Tier 2 (Primary): Canvas + <video> seeking with all-keyframe MP4
 *   Tier 3 (Fallback): Static poster for reduced-motion users
 *
 * All-keyframe MP4 (-g 1) ensures instant seeking without decode lag.
 * Passive scroll listener → scroll fraction (0→1) → video.currentTime → canvas draw.
 */

/* ── Types ──────────────────────────────────────────────────── */

interface ScrollEngineConfig {
  /** The canvas element to render video frames onto */
  canvas: HTMLCanvasElement;
  /** The hidden video element used as frame source */
  video: HTMLVideoElement;
  /** The hero section element (height: 400vh) */
  section: HTMLElement;
  /** Overlay element for text fade animations */
  overlay: HTMLElement;
  /** Scroll indicator element */
  scrollIndicator: HTMLElement;
}

interface ScrollEngineInstance {
  /** Destroy the engine and remove all listeners */
  destroy: () => void;
}

/* ── Utility: Scroll fraction within an element ────────────── */

function getScrollFraction(section: HTMLElement): number {
  const rect = section.getBoundingClientRect();
  const sectionHeight = section.offsetHeight;
  const viewportHeight = window.innerHeight;
  const scrollDistance = sectionHeight - viewportHeight;

  if (scrollDistance <= 0) return 0;

  // How far we've scrolled into the section
  const scrolled = -rect.top;
  return Math.max(0, Math.min(1, scrolled / scrollDistance));
}

/* ── Utility: Clamp ────────────────────────────────────────── */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* ── Overlay text animation (scroll-driven) ────────────────── */

function updateOverlay(fraction: number, overlay: HTMLElement, scrollIndicator: HTMLElement): void {
  // Text fades in between 5%-25% scroll, fades out between 55%-75%
  let overlayOpacity: number;
  let overlayTranslateY: number;

  if (fraction < 0.12) {
    // Visible at start — first ~2.5 seconds
    overlayOpacity = 1;
    overlayTranslateY = 0;
  } else if (fraction < 0.20) {
    // Fade out zone (12% → 20% = ~2.5s to ~4s)
    const fadeProgress = (fraction - 0.12) / 0.08;
    overlayOpacity = 1 - fadeProgress;
    overlayTranslateY = -40 * fadeProgress;
  } else {
    // Fully faded — rest of scroll is pure video
    overlayOpacity = 0;
    overlayTranslateY = -40;
  }

  overlay.style.opacity = String(overlayOpacity);
  overlay.style.transform = `translateY(${overlayTranslateY}px)`;

  // Scroll indicator fades out after 10% scroll
  if (fraction > 0.1) {
    scrollIndicator.classList.add('hero__scroll-indicator--hidden');
  } else {
    scrollIndicator.classList.remove('hero__scroll-indicator--hidden');
  }
}

/* ── Canvas resize (match devicePixelRatio) ────────────────── */

function resizeCanvas(canvas: HTMLCanvasElement, video: HTMLVideoElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // Cap at 2x for performance
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
}

/* ── Draw video frame on canvas (cover fit) ────────────────── */

function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): void {
  if (video.readyState < 2) return; // HAVE_CURRENT_DATA minimum

  const cw = canvas.width;
  const ch = canvas.height;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  if (vw === 0 || vh === 0) return;

  // "cover" fit calculation
  const canvasRatio = cw / ch;
  const videoRatio = vw / vh;

  let drawWidth: number;
  let drawHeight: number;
  let drawX: number;
  let drawY: number;

  if (canvasRatio > videoRatio) {
    // Canvas is wider — fit to width, crop height
    drawWidth = cw;
    drawHeight = cw / videoRatio;
    drawX = 0;
    drawY = (ch - drawHeight) / 2;
  } else {
    // Canvas is taller — fit to height, crop width
    drawHeight = ch;
    drawWidth = ch * videoRatio;
    drawX = (cw - drawWidth) / 2;
    drawY = 0;
  }

  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

/* ── Main: Initialize Scroll Engine ────────────────────────── */

export function initScrollEngine(config: ScrollEngineConfig): ScrollEngineInstance {
  const { canvas, video, section, overlay, scrollIndicator } = config;

  // Reduced motion check — Tier 3
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    return { destroy: () => {} };
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    console.warn('[ScrollEngine] Could not get 2D context');
    return { destroy: () => {} };
  }

  let isDestroyed = false;
  let rafId: number | null = null;

  // Lerp state: smooth interpolation between current and target time
  const LERP_FACTOR = 0.08; // Lower = smoother but slower response
  const LERP_THRESHOLD = 0.005; // Minimum time delta to trigger seek (seconds)
  let targetTime = 0;
  let currentTime = 0;
  let isSeeking = false;

  // Initial canvas sizing
  resizeCanvas(canvas, video);

  // Draw first frame once video is ready
  const onVideoReady = (): void => {
    if (isDestroyed) return;
    resizeCanvas(canvas, video);
    drawFrame(ctx, video, canvas);
  };

  video.addEventListener('loadeddata', onVideoReady);

  if (video.readyState >= 2) {
    onVideoReady();
  }

  // When video finishes seeking — draw the actual frame
  const onSeeked = (): void => {
    if (isDestroyed) return;
    isSeeking = false;
    drawFrame(ctx, video, canvas);
  };

  video.addEventListener('seeked', onSeeked);

  // Use requestVideoFrameCallback if available (Chrome) for frame-accurate rendering
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let rvfcId: number | null = null;

  function onVideoFrame(): void {
    if (isDestroyed) return;
    drawFrame(ctx, video, canvas);
    rvfcId = video.requestVideoFrameCallback(onVideoFrame);
  }

  if (hasRVFC) {
    rvfcId = video.requestVideoFrameCallback(onVideoFrame);
  }

  // Scroll listener — only updates targetTime, never draws directly
  const onScroll = (): void => {
    if (isDestroyed) return;
    const fraction = getScrollFraction(section);

    if (video.duration && isFinite(video.duration)) {
      targetTime = fraction * video.duration;
    }

    // Update overlay immediately (no need to wait for video)
    updateOverlay(fraction, overlay, scrollIndicator);
  };

  // Continuous animation loop — lerp toward target time
  function animate(): void {
    if (isDestroyed) return;

    const diff = targetTime - currentTime;

    // Lerp: smoothly approach target
    if (Math.abs(diff) > LERP_THRESHOLD) {
      currentTime += diff * LERP_FACTOR;

      // Seek video (only if not already seeking to prevent queue buildup)
      if (!isSeeking && video.readyState >= 2) {
        isSeeking = true;
        video.currentTime = currentTime;
      }

      // If no requestVideoFrameCallback, draw on each rAF after seeking
      if (!hasRVFC && !isSeeking) {
        drawFrame(ctx, video, canvas);
      }
    }

    rafId = requestAnimationFrame(animate);
  }

  // Resize handler
  const onResize = (): void => {
    if (isDestroyed) return;
    resizeCanvas(canvas, video);
    drawFrame(ctx, video, canvas);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  // Start the loop
  onScroll();
  rafId = requestAnimationFrame(animate);

  // Cleanup
  return {
    destroy: () => {
      isDestroyed = true;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      video.removeEventListener('loadeddata', onVideoReady);
      video.removeEventListener('seeked', onSeeked);

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      if (hasRVFC && rvfcId !== null) {
        video.cancelVideoFrameCallback(rvfcId);
        rvfcId = null;
      }
    },
  };
}
