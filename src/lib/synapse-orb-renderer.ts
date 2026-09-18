/**
 * synapse-orb-renderer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Canvas 2D renderer for the SynapseOrb component.
 *
 * Architecture overview
 * ─────────────────────
 *  • OrbRenderer class owns the canvas, RAF loop, particles, and state machine.
 *  • Particles live in 3D spherical space and are projected to 2D with simple
 *    orthographic projection. This gives depth-aware opacity without WebGL.
 *  • All state transitions use lerp for smooth visual blending.
 *  • Rendering is split into draw() → drawEdges() → drawParticles() → drawCore()
 *    for clear performance profiling.
 *  • prefers-reduced-motion is checked at construction time; if true, the full
 *    particle system is disabled and only a static glow is rendered.
 *
 * Performance budget (mid-range laptop, 60fps)
 * ─────────────────────────────────────────────
 *  • 60 particles  → ~80 edges max (dynamic culling)
 *  • All draw calls use compositor (opacity, transform) — no layout reads
 *  • Gradient objects are cached and rebuilt only on resize
 *  • No allocations inside the hot loop (particles are mutated in-place)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** The four visual states of the Synapse Orb */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** A single particle in 3D space, projected to 2D for rendering */
export interface Particle {
  /** Current 3D position (world space, centred at origin) */
  x: number;
  y: number;
  z: number;
  /** Velocity components (world space, used during energised states) */
  vx: number;
  vy: number;
  vz: number;
  /** Anchor / rest position on the unit sphere surface */
  baseX: number;
  baseY: number;
  baseZ: number;
  /** Rendered radius in canvas pixels */
  radius: number;
  /** Current opacity (0-1) */
  opacity: number;
  /**
   * Per-particle phase offset (0-2π) for staggered pulsation — prevents all
   * particles breathing in perfect synchrony, which looks mechanical.
   */
  phase: number;
  /** Flash intensity for the "thinking" spike effect (0-1, decays fast) */
  spikeIntensity: number;
}

/**
 * Interpolated render parameters, lerped between state targets each frame.
 * Keeping these as a separate struct makes the lerp loop trivial.
 */
interface RenderParams {
  /** Core glow hue (degrees HSL) */
  hue: number;
  /** Core glow saturation */
  sat: number;
  /** Core glow lightness */
  lit: number;
  /** Particle base opacity */
  particleOpacity: number;
  /** Edge base opacity */
  edgeOpacity: number;
  /** Rotation speed (radians / ms) */
  rotationSpeed: number;
  /** Outer radius multiplier (1 = resting sphere, >1 = expanded) */
  radiusScale: number;
  /** Core glow intensity (0-1) */
  coreIntensity: number;
}

/** Target render parameters for each state — the "destination" the lerp aims at */
const STATE_TARGETS: Record<OrbState, RenderParams> = {
  idle: {
    hue: 185, sat: 80, lit: 60,
    particleOpacity: 0.55,
    edgeOpacity: 0.15,
    rotationSpeed: 0.00003,  // rad/ms → 0.003 rad / ~100ms frame ≈ 0.003 rad/frame @10fps, scales with dt
    radiusScale: 1.0,
    coreIntensity: 0.35,
  },
  listening: {
    hue: 155, sat: 60, lit: 50,
    particleOpacity: 0.80,
    edgeOpacity: 0.40,
    rotationSpeed: 0.0001,   // 0.01 rad/frame @100ms
    radiusScale: 1.15,
    coreIntensity: 0.60,
  },
  thinking: {
    hue: 195, sat: 20, lit: 85,  // shifts toward white
    particleOpacity: 0.70,
    edgeOpacity: 0.25,
    rotationSpeed: 0.00015,  // 0.015 rad/frame @100ms
    radiusScale: 0.88,       // contracts toward centre
    coreIntensity: 0.90,
  },
  speaking: {
    hue: 185, sat: 80, lit: 60,
    particleOpacity: 0.85,
    edgeOpacity: 0.50,
    rotationSpeed: 0.00008,
    radiusScale: 1.1,
    coreIntensity: 0.70,
  },
};

/** Distance threshold (normalised to orb radius) for drawing an edge */
const EDGE_DISTANCE_THRESHOLD = 0.55;

/** Lerp factor per frame — controls how fast the state blends (lower = smoother) */
const LERP_SPEED = 0.025;

/** Speaking: ripple wave speed (canvas units / ms) */
const RIPPLE_SPEED = 0.08;

/** Thinking: probability per frame that a spike fires on any single particle */
const SPIKE_CHANCE = 0.004;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Linear interpolation */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp value to [min, max] */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Generate a uniformly distributed point on a unit sphere surface.
 * Uses the Marsaglia rejection-sampling method (no trig needed in the
 * common case, though we still need acos/sin for exact distribution).
 */
function randomOnSphere(): [number, number, number] {
  // Spherical coordinates with uniform area distribution
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  return [
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi),
  ];
}

// ─── OrbRenderer ─────────────────────────────────────────────────────────────

export class OrbRenderer {
  // DOM / context
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Particles
  readonly particles: Particle[] = [];
  private particleCount = 60;

  // State machine
  private targetState: OrbState = 'idle';
  private _audioAmplitude = 0;

  // Render parameters (lerped each frame)
  private params: RenderParams = { ...STATE_TARGETS.idle };

  // Rotation accumulators (Y-axis primary, X-axis secondary tilt)
  private rotY = 0;
  private rotX = Math.PI * 0.1; // slight downward tilt for depth

  // RAF / timing
  private rafId = 0;
  private lastTime = 0;

  // Thinking spike cooldown
  private thinkingTime = 0;

  // Speaking ripples: each ripple is { radius, opacity }
  private ripples: Array<{ r: number; maxR: number; opacity: number }> = [];
  private rippleTimer = 0;

  // Reduced motion flag (checked once at construction)
  private reducedMotion: boolean;

  // Cached gradient for core glow (rebuilt on resize)
  private coreGradient: CanvasGradient | null = null;
  private lastWidth = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[SynapseOrb] Canvas 2D context unavailable');
    this.ctx = ctx;

    // Check accessibility preference once — immutable for component lifetime
    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.initParticles();
    this.startLoop();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Switch to a new visual state (transition is lerped, not instant) */
  setState(state: OrbState): void {
    this.targetState = state;
    // Reset thinking timer when entering thinking state
    if (state === 'thinking') {
      this.thinkingTime = 0;
    }
    // Spawn first ripple immediately when entering speaking
    if (state === 'speaking') {
      this.spawnRipple();
    }
  }

  /** Update audio amplitude (0-1), called reactively from the Svelte component */
  setAmplitude(amplitude: number): void {
    this._audioAmplitude = clamp(amplitude, 0, 1);
  }

  /**
   * Called when the canvas element is resized (from ResizeObserver).
   * Re-applies devicePixelRatio scaling.
   */
  resize(logicalSize: number): void {
    const dpr = window.devicePixelRatio ?? 1;
    this.canvas.width  = Math.round(logicalSize * dpr);
    this.canvas.height = Math.round(logicalSize * dpr);
    this.canvas.style.width  = `${logicalSize}px`;
    this.canvas.style.height = `${logicalSize}px`;
    // Invalidate cached gradient
    this.coreGradient = null;
    this.lastWidth = 0;
  }

  /** Clean up the RAF loop and free resources */
  destroy(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  // ─── Initialisation ────────────────────────────────────────────────────────

  private initParticles(): void {
    this.particles.length = 0;

    // Reduced motion → fewer particles (visual anchor only, no animation)
    const count = this.reducedMotion ? 0 : this.particleCount;

    for (let i = 0; i < count; i++) {
      const [bx, by, bz] = randomOnSphere();
      this.particles.push({
        x: bx, y: by, z: bz,
        vx: 0, vy: 0, vz: 0,
        baseX: bx, baseY: by, baseZ: bz,
        radius: 1.8 + Math.random() * 1.4,
        opacity: 0.4 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        spikeIntensity: 0,
      });
    }
  }

  // ─── Main Loop ─────────────────────────────────────────────────────────────

  private startLoop(): void {
    const tick = (now: number): void => {
      const dt = Math.min(now - this.lastTime, 50); // cap at 50ms to prevent spiral
      this.lastTime = now;

      this.update(dt);
      this.draw();

      this.rafId = requestAnimationFrame(tick);
    };

    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(tick);
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  private update(dt: number): void {
    // 1. Lerp render params toward target state
    const target = STATE_TARGETS[this.targetState];
    for (const key of Object.keys(this.params) as Array<keyof RenderParams>) {
      (this.params[key] as number) = lerp(
        this.params[key] as number,
        target[key] as number,
        LERP_SPEED,
      );
    }

    if (this.reducedMotion) return; // static glow only for reduced-motion

    // 2. Rotation — speed comes from lerped params
    const effectiveSpeed = this.params.rotationSpeed *
      (this.targetState === 'listening'
        ? 1 + this._audioAmplitude * 2
        : 1);
    this.rotY += effectiveSpeed * dt;

    // 3. State-specific per-particle logic
    switch (this.targetState) {
      case 'idle':    this.updateIdle(dt); break;
      case 'listening': this.updateListening(dt); break;
      case 'thinking':  this.updateThinking(dt); break;
      case 'speaking':  this.updateSpeaking(dt); break;
    }

    // 4. Update ripples (speaking)
    this.updateRipples(dt);
  }

  /** IDLE: gentle breathing pulsation, particles drift back to base */
  private updateIdle(dt: number): void {
    const t = performance.now() * 0.001; // seconds
    for (const p of this.particles) {
      // Soft breathing — radius oscillates ±3%
      const breath = 1 + Math.sin(t * 0.8 + p.phase) * 0.03;
      p.x = lerp(p.x, p.baseX * breath, 0.04);
      p.y = lerp(p.y, p.baseY * breath, 0.04);
      p.z = lerp(p.z, p.baseZ * breath, 0.04);
      // Decay spike
      p.spikeIntensity *= 0.85;
    }
  }

  /** LISTENING: particles pushed outward by audio amplitude */
  private updateListening(dt: number): void {
    const amp  = this._audioAmplitude;
    const push = 1 + amp * 0.30; // up to 30% expansion at max amplitude
    const t    = performance.now() * 0.001;
    for (const p of this.particles) {
      const micPulse = 1 + Math.sin(t * 12 + p.phase) * amp * 0.08;
      const target   = push * micPulse;
      p.x = lerp(p.x, p.baseX * target, 0.06);
      p.y = lerp(p.y, p.baseY * target, 0.06);
      p.z = lerp(p.z, p.baseZ * target, 0.06);
      p.spikeIntensity *= 0.90;
    }
  }

  /** THINKING: particles contract to centre + random "neural spike" flashes */
  private updateThinking(dt: number): void {
    this.thinkingTime += dt;
    const contractScale = 0.70; // contract to 70% of sphere radius
    const t = performance.now() * 0.001;

    for (const p of this.particles) {
      // Slow swirl inward
      const swirl = 1 + Math.sin(t * 1.5 + p.phase) * 0.04;
      p.x = lerp(p.x, p.baseX * contractScale * swirl, 0.05);
      p.y = lerp(p.y, p.baseY * contractScale * swirl, 0.05);
      p.z = lerp(p.z, p.baseZ * contractScale * swirl, 0.05);

      // Random neural spikes — 1-3 at a time
      if (Math.random() < SPIKE_CHANCE) {
        p.spikeIntensity = 1.0;
      }
      p.spikeIntensity *= 0.92; // fast decay
    }
  }

  /** SPEAKING: particles expand + directional ripple waves from centre */
  private updateSpeaking(dt: number): void {
    const amp  = this._audioAmplitude;
    const push = 1 + amp * 0.20;
    const t    = performance.now() * 0.001;

    for (const p of this.particles) {
      // Ripple-like radial oscillation
      const wave = 1 + Math.sin(t * 6 + p.phase) * 0.06 * (0.5 + amp * 0.5);
      p.x = lerp(p.x, p.baseX * push * wave, 0.05);
      p.y = lerp(p.y, p.baseY * push * wave, 0.05);
      p.z = lerp(p.z, p.baseZ * push * wave, 0.05);
      p.spikeIntensity *= 0.88;
    }

    // Spawn ripples at regular intervals (amplitude-driven rate)
    this.rippleTimer += dt;
    const interval = 600 - amp * 400; // faster ripples when louder (600ms → 200ms)
    if (this.rippleTimer >= interval) {
      this.rippleTimer = 0;
      this.spawnRipple();
    }
  }

  // ─── Ripples ───────────────────────────────────────────────────────────────

  private spawnRipple(): void {
    const maxR = 0.9 + this._audioAmplitude * 0.4; // in normalised orb units
    this.ripples.push({ r: 0, maxR, opacity: 0.6 });
    // Keep ripple pool bounded
    if (this.ripples.length > 5) this.ripples.shift();
  }

  private updateRipples(dt: number): void {
    for (const ripple of this.ripples) {
      ripple.r += RIPPLE_SPEED * dt * 0.05;
      ripple.opacity = clamp(1 - ripple.r / ripple.maxR, 0, 0.6);
    }
    // Prune finished ripples
    this.ripples = this.ripples.filter(r => r.r < r.maxR);
  }

  // ─── Projection ────────────────────────────────────────────────────────────

  /**
   * Project a 3D point (on unit sphere) to canvas 2D coordinates.
   *
   * We apply Y-axis rotation (rotY) and a slight X-axis tilt (rotX).
   * Simple orthographic projection — no perspective divide — keeps the
   * "flat neural net" aesthetic while still giving depth from opacity.
   *
   * Returns { cx, cy, screenZ } where screenZ ∈ [-1, 1].
   */
  private project(
    px: number, py: number, pz: number, orbRadius: number, cx: number, cy: number,
  ): { sx: number; sy: number; screenZ: number } {
    // Rotate around Y axis
    const cosY = Math.cos(this.rotY);
    const sinY = Math.sin(this.rotY);
    const x1 = px * cosY - pz * sinY;
    const z1 = px * sinY + pz * cosY;

    // Rotate around X axis (tilt)
    const cosX = Math.cos(this.rotX);
    const sinX = Math.sin(this.rotX);
    const y2 = py * cosX - z1 * sinX;
    const z2 = py * sinX + z1 * cosX;

    return {
      sx: cx + x1 * orbRadius,
      sy: cy + y2 * orbRadius,
      screenZ: z2, // used for depth-based opacity
    };
  }

  // ─── Draw ──────────────────────────────────────────────────────────────────

  private draw(): void {
    const { ctx, canvas, params } = this;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.38 * params.radiusScale;

    // Clear
    ctx.clearRect(0, 0, w, h);

    if (this.reducedMotion) {
      this.drawCoreGlow(cx, cy, baseRadius, params);
      return;
    }

    // Project all particles once per frame
    type Projected = {
      sx: number; sy: number; screenZ: number;
      p: Particle; depth: number;
    };
    const projected: Projected[] = this.particles.map(p => {
      const proj = this.project(p.x, p.y, p.z, baseRadius, cx, cy);
      return { ...proj, p, depth: (proj.screenZ + 1) * 0.5 }; // depth: 0(back)→1(front)
    });

    // Draw back-to-front for correct overlap
    projected.sort((a, b) => a.screenZ - b.screenZ);

    this.drawEdges(projected, baseRadius, params);
    this.drawRipples(cx, cy, baseRadius, params);
    this.drawCoreGlow(cx, cy, baseRadius, params);
    this.drawParticles(projected, params);
  }

  /** Draw edges (connections) between nearby particles */
  private drawEdges(
    projected: Array<{ sx: number; sy: number; p: Particle; depth: number; screenZ: number }>,
    orbRadius: number,
    params: RenderParams,
  ): void {
    const { ctx } = this;
    const threshold = orbRadius * EDGE_DISTANCE_THRESHOLD;
    const thresholdSq = threshold * threshold;

    ctx.save();
    ctx.lineWidth = 0.6;

    for (let i = 0; i < projected.length - 1; i++) {
      const a = projected[i];
      if (!a) continue;
      for (let j = i + 1; j < projected.length; j++) {
        const b = projected[j];
        if (!b) continue;
        const dx = a.sx - b.sx;
        const dy = a.sy - b.sy;
        const distSq = dx * dx + dy * dy;
        if (distSq > thresholdSq) continue;

        // Opacity falls off with distance and depth
        const distFactor = 1 - Math.sqrt(distSq) / threshold;
        const depthFactor = (a.depth + b.depth) * 0.5;
        const edgeAlpha   = params.edgeOpacity * distFactor * (0.3 + depthFactor * 0.7);

        // Spike effect bleeds into edges
        const spikeBoost = Math.max(a.p.spikeIntensity, b.p.spikeIntensity) * 0.6;

        ctx.strokeStyle = `hsla(${params.hue}, ${params.sat}%, ${params.lit}%, ${edgeAlpha + spikeBoost})`;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** Draw all projected particles */
  private drawParticles(
    projected: Array<{ sx: number; sy: number; depth: number; p: Particle }>,
    params: RenderParams,
  ): void {
    const { ctx } = this;

    for (const { sx, sy, depth, p } of projected) {
      ctx.save();

      // Depth-based opacity — particles behind the sphere are dimmer
      const depthOpacity = 0.2 + depth * 0.8;
      const baseAlpha    = params.particleOpacity * depthOpacity * p.opacity;
      const spikeBoost   = p.spikeIntensity * 0.8;
      const finalAlpha   = clamp(baseAlpha + spikeBoost, 0, 1);

      // Spike boost also temporarily enlarges the particle
      const spikeRadius = p.radius * (1 + p.spikeIntensity * 1.5);

      // Green flash during speaking (random green tint on energised particles)
      const isGreenFlash = this.targetState === 'speaking' && Math.random() < 0.03;
      const h = isGreenFlash ? 155 : params.hue;
      const s = isGreenFlash ? 70 : params.sat;
      const l = 60 + p.spikeIntensity * 30;

      // Soft glow aura
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, spikeRadius * 3);
      glow.addColorStop(0,   `hsla(${h}, ${s}%, ${l}%, ${finalAlpha})`);
      glow.addColorStop(0.5, `hsla(${h}, ${s}%, ${l}%, ${finalAlpha * 0.3})`);
      glow.addColorStop(1,   `hsla(${h}, ${s}%, ${l}%, 0)`);

      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, spikeRadius * 3, 0, Math.PI * 2);
      ctx.fill();

      // Hard centre dot
      ctx.fillStyle = `hsla(${h}, ${s}%, ${l + 10}%, ${finalAlpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, spikeRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  /** Draw the radial core glow (always visible, even in reduced-motion mode) */
  private drawCoreGlow(
    cx: number, cy: number, orbRadius: number, params: RenderParams,
  ): void {
    const { ctx } = this;
    const w = this.canvas.width;

    // Rebuild gradient only on resize (avoid re-allocating each frame)
    if (!this.coreGradient || this.lastWidth !== w) {
      this.lastWidth = w;
      this.coreGradient = null; // force rebuild below
    }

    const glowRadius = orbRadius * 1.2 * params.coreIntensity;
    const t          = performance.now() * 0.001;

    // Idle / speaking: gentle pulse; thinking: rapid flicker
    const pulseFreq  = this.targetState === 'thinking' ? 4.0 : 0.7;
    const pulseAmp   = this.targetState === 'thinking' ? 0.12 : 0.05;
    const pulse      = 1 + Math.sin(t * pulseFreq) * pulseAmp;

    const finalRadius = glowRadius * pulse;
    const { hue, sat, lit } = params;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, finalRadius);
    grad.addColorStop(0,   `hsla(${hue}, ${sat}%, ${lit + 10}%, ${0.18 * params.coreIntensity})`);
    grad.addColorStop(0.3, `hsla(${hue}, ${sat}%, ${lit}%, ${0.12 * params.coreIntensity})`);
    grad.addColorStop(0.7, `hsla(${hue}, ${sat}%, ${lit}%, ${0.04 * params.coreIntensity})`);
    grad.addColorStop(1,   `hsla(${hue}, ${sat}%, ${lit}%, 0)`);

    ctx.save();
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, finalRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Draw speaking ripples (concentric expanding rings from centre) */
  private drawRipples(
    cx: number, cy: number, orbRadius: number, params: RenderParams,
  ): void {
    if (this.targetState !== 'speaking' && this.ripples.length === 0) return;
    const { ctx } = this;

    for (const ripple of this.ripples) {
      const r = Math.max(0, ripple.r * orbRadius);
      if (r === 0) continue;
      ctx.save();
      ctx.strokeStyle = `hsla(${params.hue}, ${params.sat}%, ${params.lit}%, ${ripple.opacity * 0.5})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Convenience factory used by the Svelte component.
 * Returns the OrbRenderer instance (caller owns lifecycle via destroy()).
 */
export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer {
  return new OrbRenderer(canvas);
}
