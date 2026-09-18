/**
 * brain-morph.ts — Scroll-driven video scrub for SynapseBrain
 *
 * Tied to the HERO SECTION scroll (same as scroll-engine.ts).
 * Video scrubs between 20% and 95% of hero section scroll —
 * starts AFTER the title "From pixels to pipelines" disappears,
 * ends BEFORE the hero section scrolls out of view.
 *
 * Container is ALWAYS a circle (80×80). No shape morphing.
 * Only opacity changes during hero scroll.
 * "Ready" state (clickable, glow) activates when #about section is visible.
 */

/* ── Types ──────────────────────────────────────────────────────── */

export interface BrainMorphConfig {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  container: HTMLElement;
  onlineDoc: HTMLElement;
  /** The hero section element (800vh) — used for scroll fraction */
  heroSection: HTMLElement;
  /** Hero scroll fraction where video scrubbing begins. Default: 0.20 */
  scrubStart?: number;
  /** Hero scroll fraction where video scrubbing ends. Default: 0.95 */
  scrubEnd?: number;
}

export interface BrainMorphInstance {
  destroy: () => void;
}

/* ── Utilities ──────────────────────────────────────────────────── */

/**
 * Loads the best available format for a same-content image (AVIF → WebP →
 * PNG), calling `onReady` once whichever variant successfully decodes. Used
 * instead of a `<picture>` element because the image is never inserted into
 * the DOM — it's only ever drawn onto a `<canvas>` via `drawImage`.
 */
function loadBestImage(basePath: string, onReady: (img: HTMLImageElement) => void): void {
  const tryLoad = (src: string, next: (() => void) | null): void => {
    const img = new Image();
    img.onload = () => onReady(img);
    img.onerror = () => next?.();
    img.src = src;
  };
  tryLoad(`${basePath}.avif`, () =>
    tryLoad(`${basePath}.webp`, () => tryLoad(`${basePath}.png`, null))
  );
}

/**
 * Scroll fraction within a section (same technique as scroll-engine.ts).
 * 0 = section top at viewport top, 1 = section bottom at viewport bottom.
 */
function getSectionScrollFraction(section: HTMLElement): number {
  const rect = section.getBoundingClientRect();
  const sectionHeight = section.offsetHeight;
  const viewportHeight = window.innerHeight;
  const scrollDistance = sectionHeight - viewportHeight;

  if (scrollDistance <= 0) return 0;

  const scrolled = -rect.top;
  return Math.max(0, Math.min(1, scrolled / scrollDistance));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  const t = clamp((value - inMin) / (inMax - inMin), 0, 1);
  return outMin + t * (outMax - outMin);
}

/* ── Canvas rendering ──────────────────────────────────────────── */

function drawFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement
): void {
  if (video.readyState < 2) return;

  const cw = canvas.width;
  const ch = canvas.height;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  if (vw === 0 || vh === 0) return;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  // "cover" fit — fill by height, crop width
  const canvasRatio = cw / ch;
  const videoRatio = vw / vh;

  let drawWidth: number;
  let drawHeight: number;
  let drawX: number;
  let drawY: number;

  if (canvasRatio > videoRatio) {
    drawWidth = cw;
    drawHeight = cw / videoRatio;
    drawX = 0;
    drawY = (ch - drawHeight) / 2;
  } else {
    drawHeight = ch;
    drawWidth = ch * videoRatio;
    drawX = (cw - drawWidth) / 2;
    drawY = 0;
  }

  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

/** Draw the synapse-text.png (1:1) — "contain" fit inside canvas */
function drawReadyImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  canvas: HTMLCanvasElement
): void {
  const cw = canvas.width;
  const ch = canvas.height;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw === 0 || ih === 0) return;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  // "contain" — fit entire image, center
  const scale = Math.min(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function resizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
}

/* ── Main ───────────────────────────────────────────────────────── */

const LERP_FACTOR = 0.08;
const LERP_THRESHOLD = 0.005;

export function initBrainMorph(config: BrainMorphConfig): BrainMorphInstance {
  const {
    canvas,
    video,
    container,
    onlineDoc,
    heroSection,
    scrubStart = 0.2,
    scrubEnd = 0.95,
  } = config;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    onlineDoc.style.display = 'none';
    return { destroy: () => {} };
  }

  // Mobile never loads/scrubs brain-morph.mp4 (the largest asset on the
  // mobile-perf-critical path — see Sprint 7a-2). Checked once at init:
  // this is a static site, viewport class doesn't change without a reload
  // crossing the breakpoint (same convention as HeroCanvas's hero-scroll.mp4
  // gate). Ready-state, click-to-open, and scroll fade-in below still run
  // as-is — the CSS `.ready` swap shows the canvas again once the
  // video-independent synapse-text ready image is drawn onto it.
  const isMobile = window.matchMedia('(max-width: 767px)').matches;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return { destroy: () => {} };

  resizeCanvas(canvas);

  if (!isMobile) {
    const src = video.dataset.src;
    if (src) {
      video.src = src;
      video.preload = 'auto';
    }
    // The poster is gated the same way as the source, and for the same reason.
    // It used to be a static `poster` attribute, so every phone downloaded it —
    // a still frame for a video that this branch guarantees will never play, on
    // top of the <picture> right beside it that already shows the same image.
    const poster = video.dataset.poster;
    if (poster) video.poster = poster;
  }

  let isDestroyed = false;
  let rafId: number | null = null;
  let rvfcId: number | null = null;
  let isSeeking = false;
  let targetTime = 0;
  let currentTime = 0;
  let isAboutVisible = false;

  /** Preload synapse-text (AVIF/WebP/PNG) for ready state */
  let readyImage: HTMLImageElement | null = null;
  let readyImageLoaded = false;
  loadBestImage('/synapse-text', (img) => {
    readyImage = img;
    readyImageLoaded = true;
    requestFrame();
  });

  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  /* ── RVFC (Chrome frame-accurate) ─────────────────────────── */
  function onVideoFrame(): void {
    if (isDestroyed) return;
    drawFrame(ctx, video, canvas);
    rvfcId = video.requestVideoFrameCallback(onVideoFrame);
  }

  if (hasRVFC) {
    rvfcId = video.requestVideoFrameCallback(onVideoFrame);
  }

  /* ── Video ready ──────────────────────────────────────────── */
  const onLoadedData = (): void => {
    if (isDestroyed) return;
    resizeCanvas(canvas);
    video.currentTime = 0;
    drawFrame(ctx, video, canvas);
    requestFrame();
  };

  video.addEventListener('loadeddata', onLoadedData);
  if (video.readyState >= 2) onLoadedData();

  const onSeeked = (): void => {
    if (isDestroyed) return;
    isSeeking = false;
    drawFrame(ctx, video, canvas);
    requestFrame();
  };

  video.addEventListener('seeked', onSeeked);

  /* ── Ready state: active from Career Arc (#about) onwards ──── */
  const aboutEl = document.getElementById('about');

  function checkReadyState(): void {
    if (!aboutEl) return;
    const aboutTop = aboutEl.getBoundingClientRect().top;
    const wasVisible = isAboutVisible;
    isAboutVisible = aboutTop < window.innerHeight;
    if (isAboutVisible !== wasVisible) updateReadyState();
  }

  function updateReadyState(): void {
    requestFrame();
    if (isAboutVisible) {
      container.classList.add('ready');
      container.style.pointerEvents = 'auto';
      container.style.cursor = 'pointer';
      container.style.opacity = '1';
      onlineDoc.style.visibility = 'visible';
      onlineDoc.style.opacity = '1';
    } else {
      container.classList.remove('ready');
      container.style.pointerEvents = 'none';
      container.style.cursor = 'default';
      onlineDoc.style.visibility = 'hidden';
      onlineDoc.style.opacity = '0';
    }
  }

  /* ── Scroll handler — tied to HERO SECTION ─────────────────── */
  const onScroll = (): void => {
    if (isDestroyed) return;

    // ALL layout reads first, ALL writes after. This used to interleave:
    // getSectionScrollFraction() reads (rect + offsetHeight + innerHeight),
    // then container.style.opacity was written, then checkReadyState() read a
    // rect again — and that second read had to wait for the layout the write
    // had just invalidated. Two forced reflows per scroll event instead of one,
    // on a handler that fires for every frame of every scroll.
    const heroFraction = getSectionScrollFraction(heroSection);
    checkReadyState(); // reads #about's rect; may flip isAboutVisible

    // Map hero scroll to video scrub range
    const scrubProgress = mapRange(heroFraction, scrubStart, scrubEnd, 0, 1);

    if (video.duration && isFinite(video.duration)) {
      targetTime = clamp(scrubProgress * video.duration, 0, video.duration);
    }

    // Opacity: fade in with hero scroll (0.4 → 1.0)
    if (!isAboutVisible) {
      const opacity = clamp(mapRange(heroFraction, 0, 0.3, 0.4, 1.0), 0.4, 1.0);
      container.style.opacity = opacity.toFixed(3);
    }

    requestFrame();
  };

  /* ── Animation loop ─────────────────────────────────────────── */

  /**
   * Is there anything for the next frame to draw?
   *
   * The loop below used to re-arm itself unconditionally, so it ran at 60 fps
   * for the whole visit whether or not it had work. On mobile that was pure
   * waste: the gate above never assigns `video.src`, so `video.duration` is
   * NaN, `targetTime` stays 0, and every frame did nothing at all — one of the
   * three permanent rAF loops that gave this page ~3000 short main-thread tasks
   * with almost no long ones. Now the loop stops when idle and every input that
   * can create work re-arms it (scroll, resize, seek, video data, ready-state
   * flip, ready-image load).
   */
  function hasPendingWork(): boolean {
    if (Math.abs(targetTime - currentTime) > LERP_THRESHOLD) return true;
    // While the ready image is up it is repainted each frame, exactly as before.
    return isAboutVisible && readyImageLoaded && readyImage !== null;
  }

  function requestFrame(): void {
    if (isDestroyed || rafId !== null) return;
    rafId = requestAnimationFrame(animate);
  }

  function animate(): void {
    rafId = null;
    if (isDestroyed) return;

    const diff = targetTime - currentTime;

    if (Math.abs(diff) > LERP_THRESHOLD) {
      currentTime += diff * LERP_FACTOR;

      if (!isSeeking && video.readyState >= 2) {
        isSeeking = true;
        video.currentTime = currentTime;
      }

      if (!hasRVFC && !isSeeking) {
        drawFrame(ctx, video, canvas);
      }
    }

    // When ready: show synapse-text instead of video frame
    if (isAboutVisible && readyImageLoaded && readyImage) {
      drawReadyImage(ctx, readyImage, canvas);
    }

    // A seek in flight still needs frames: `seeked` re-arms us, but until it
    // lands `currentTime` has already caught up to `targetTime`, so the plain
    // work test would report idle and park the loop mid-scrub.
    if (hasPendingWork() || isSeeking) requestFrame();
  }

  /* ── Resize ─────────────────────────────────────────────────── */
  const onResize = (): void => {
    if (isDestroyed) return;
    resizeCanvas(canvas);
    drawFrame(ctx, video, canvas);
    onScroll();
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  // onScroll() ends in requestFrame(), which is the only place the loop starts.
  onScroll();

  return {
    destroy: (): void => {
      isDestroyed = true;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('seeked', onSeeked);

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (hasRVFC && rvfcId !== null) {
        video.cancelVideoFrameCallback(rvfcId);
        rvfcId = null;
      }

      container.style.opacity = '';
      container.style.pointerEvents = '';
      container.style.cursor = '';
    },
  };
}
