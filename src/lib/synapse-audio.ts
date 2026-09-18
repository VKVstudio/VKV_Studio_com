/**
 * synapse-audio.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Audio engine for the Synapse Voice UI.
 *
 * Responsibilities
 * ────────────────
 *  • MediaRecorder-based microphone recording (webm/opus → Blob)
 *  • Real-time amplitude analysis via Web Audio AnalyserNode (RMS, 0-1)
 *  • Playback of audio Blob responses from the backend
 *  • Playback amplitude analysis (drives SynapseOrb "speaking" state)
 *  • Graceful permission and device error handling — never crashes UI
 *  • RAF loop runs only during recording or playback (CPU-efficient)
 *  • Full resource cleanup via destroy()
 *
 * Architecture
 * ────────────
 *  • AudioContext is created lazily on first startRecording() call.
 *    (Browsers require user-gesture to create AudioContext; mic press qualifies.)
 *  • AnalyserNode is reused between recording and playback to avoid
 *    repeated AudioContext creation (one context per engine instance).
 *  • amplitude and playbackAmplitude are plain properties read from outside
 *    via a RAF loop in the consumer (SynapseTerminal).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type MicErrorKind =
  | 'permission-denied'
  | 'not-found'
  | 'not-supported'
  | 'unknown';

export interface MicError {
  kind: MicErrorKind;
  /** Human-readable message safe to show in the UI */
  message: string;
}

export interface AudioEngine {
  /**
   * Start recording from microphone.
   * Resolves when recording has started, rejects with MicError on failure.
   */
  startRecording(): Promise<void>;

  /**
   * Stop recording.
   * Returns the recorded audio Blob (webm/opus or fallback).
   * Returns null if nothing was recorded or recording was too short (<0.5s).
   */
  stopRecording(): Promise<Blob | null>;

  /** Current real-time mic amplitude (0–1). Read from RAF during recording. */
  readonly amplitude: number;

  /** Whether currently recording */
  readonly isRecording: boolean;

  /**
   * Play an audio Blob through the system speakers.
   * Resolves when playback ends (or is stopped).
   */
  playAudio(blob: Blob): Promise<void>;

  /** Stop any active playback immediately */
  stopPlayback(): void;

  /** Whether currently playing back */
  readonly isPlaying: boolean;

  /**
   * Amplitude during playback (0–1).
   * Drives SynapseOrb audioAmplitude in the "speaking" state.
   */
  readonly playbackAmplitude: number;

  /**
   * Clean up all resources:
   * AudioContext, MediaStream tracks, MediaRecorder, Audio element.
   * Safe to call multiple times.
   */
  destroy(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum recording duration in milliseconds before we consider it valid */
const MIN_RECORDING_MS = 500;

/** AnalyserNode FFT size — 256 gives 128 frequency bins, low CPU */
const FFT_SIZE = 256;

/** Smoothing constant — higher = more lag, smoother visuals */
const SMOOTHING = 0.8;

/** Preferred MIME types in priority order */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Select the best supported MIME type for MediaRecorder.
 * Returns the first supported type, or empty string (browser default).
 */
function selectMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * Compute RMS (root mean square) amplitude from a byte time-domain buffer.
 * Returns a value in [0, 1].
 */
function computeRmsAmplitude(buffer: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    // Convert unsigned byte [0, 255] to signed float [-1, 1]
    const sample = (buffer[i]! - 128) / 128;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / buffer.length);
  // Scale to [0, 1] — RMS of a sine at max is ~0.707, so we scale by ~1.4
  return Math.min(rms * 1.4, 1);
}

/**
 * Map a DOMException name to a MicError.
 */
function mapGetUserMediaError(err: unknown): MicError {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return {
          kind: 'permission-denied',
          message: 'Microphone access required. Please allow it in your browser.',
        };
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return {
          kind: 'not-found',
          message: 'No microphone detected. Please connect a microphone.',
        };
      case 'NotSupportedError':
        return {
          kind: 'not-supported',
          message: 'Microphone not supported in this browser.',
        };
      default:
        return {
          kind: 'unknown',
          message: `Microphone error: ${err.message}`,
        };
    }
  }
  return {
    kind: 'unknown',
    message: 'Unknown microphone error.',
  };
}

// ─── AudioEngineImpl ──────────────────────────────────────────────────────────

class AudioEngineImpl implements AudioEngine {
  // ── Internal state ──────────────────────────────────────────────────────────

  private _audioCtx: AudioContext | null = null;
  private _analyser: AnalyserNode | null = null;
  private _analyserBuffer: Uint8Array | null = null;

  private _stream: MediaStream | null = null;
  private _sourceNode: MediaStreamAudioSourceNode | null = null;

  private _recorder: MediaRecorder | null = null;
  private _chunks: BlobPart[] = [];
  private _recordingStartMs = 0;
  private _mimeType = '';

  private _audioEl: HTMLAudioElement | null = null;
  private _playbackSourceNode: MediaElementAudioSourceNode | null = null;
  private _playbackResolve: (() => void) | null = null;

  private _rafId = 0;
  private _destroyed = false;

  // ── Public readable state ───────────────────────────────────────────────────

  amplitude = 0;
  isRecording = false;

  playbackAmplitude = 0;
  isPlaying = false;

  // ─── AudioContext lazy init ─────────────────────────────────────────────────

  private ensureAudioContext(): AudioContext {
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      this._audioCtx = new AudioContext();
    }
    // Resume if suspended (can happen when the page loses focus)
    if (this._audioCtx.state === 'suspended') {
      void this._audioCtx.resume();
    }
    return this._audioCtx;
  }

  private ensureAnalyser(ctx: AudioContext): AnalyserNode {
    if (!this._analyser) {
      this._analyser = ctx.createAnalyser();
      this._analyser.fftSize = FFT_SIZE;
      this._analyser.smoothingTimeConstant = SMOOTHING;
      this._analyserBuffer = new Uint8Array(this._analyser.fftSize);
    }
    return this._analyser;
  }

  // ─── Recording ─────────────────────────────────────────────────────────────

  async startRecording(): Promise<void> {
    if (this._destroyed) return;
    if (this.isRecording) return; // idempotent

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const err: MicError = {
        kind: 'not-supported',
        message: 'Microphone not supported in this browser.',
      };
      throw err;
    }

    // Request mic access
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      throw mapGetUserMediaError(err);
    }

    if (this._destroyed) {
      // destroy() was called while we were awaiting getUserMedia
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // Set up AudioContext + AnalyserNode → connects mic stream
    const ctx = this.ensureAudioContext();
    const analyser = this.ensureAnalyser(ctx);

    // Disconnect any previous source
    try { this._sourceNode?.disconnect(); } catch { /* ignore */ }

    this._stream = stream;
    this._sourceNode = ctx.createMediaStreamSource(stream);
    this._sourceNode.connect(analyser);
    // Note: analyser is NOT connected to ctx.destination — we don't want mic playback

    // Set up MediaRecorder
    this._mimeType = selectMimeType();
    const recorderOptions: MediaRecorderOptions = this._mimeType
      ? { mimeType: this._mimeType }
      : {};

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, recorderOptions);
    } catch {
      // If options fail, try without
      recorder = new MediaRecorder(stream);
      this._mimeType = recorder.mimeType;
    }

    this._chunks = [];
    this._recorder = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        this._chunks.push(e.data);
      }
    };

    recorder.start(100); // collect chunks every 100ms for responsiveness
    this._recordingStartMs = Date.now();
    this.isRecording = true;

    // Start RAF amplitude loop
    this._startAmplitudeLoop();
  }

  async stopRecording(): Promise<Blob | null> {
    if (!this.isRecording || !this._recorder) return null;

    const durationMs = Date.now() - this._recordingStartMs;

    // Stop the recorder, collect final chunk
    const blob = await new Promise<Blob>((resolve) => {
      const recorder = this._recorder!;

      const onStop = () => {
        const mimeType = this._mimeType || 'audio/webm';
        const result = new Blob(this._chunks, { type: mimeType });
        resolve(result);
      };

      recorder.addEventListener('stop', onStop, { once: true });

      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        onStop();
      }
    });

    // Clean up mic stream
    this._stopStream();
    this.isRecording = false;
    this.amplitude = 0;
    this._stopRaf();

    // Reject blobs that are too short
    if (durationMs < MIN_RECORDING_MS) {
      console.warn('[SynapseAudio] Recording too short (<500ms), discarding.');
      return null;
    }

    return blob;
  }

  // ─── Playback ───────────────────────────────────────────────────────────────

  async playAudio(blob: Blob): Promise<void> {
    if (this._destroyed) return;

    // Stop any existing playback
    this.stopPlayback();

    const ctx = this.ensureAudioContext();
    const analyser = this.ensureAnalyser(ctx);

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    this._audioEl = audio;

    // Connect audio element → analyser → destination so we hear it AND measure amplitude
    let sourceNode: MediaElementAudioSourceNode;
    try {
      sourceNode = ctx.createMediaElementSource(audio);
    } catch (err) {
      // createMediaElementSource fails if already connected; safe to fall back
      console.warn('[SynapseAudio] createMediaElementSource failed:', err);
      audio.play().catch((e) => console.warn('[SynapseAudio] audio.play failed:', e));
      this.isPlaying = true;
      return;
    }

    this._playbackSourceNode = sourceNode;
    sourceNode.connect(analyser);
    analyser.connect(ctx.destination);

    this.isPlaying = true;

    return new Promise<void>((resolve) => {
      this._playbackResolve = resolve;

      const cleanup = () => {
        URL.revokeObjectURL(url);
        // Disconnect analyser from destination when done
        try { analyser.disconnect(ctx.destination); } catch { /* ignore */ }
        try { sourceNode.disconnect(); } catch { /* ignore */ }
        this._playbackSourceNode = null;
        this._audioEl = null;
        this.isPlaying = false;
        this.playbackAmplitude = 0;
        this._stopRaf();
        this._playbackResolve = null;
        resolve();
      };

      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', (e) => {
        console.warn('[SynapseAudio] Audio playback error:', e);
        cleanup();
      }, { once: true });

      audio.play().catch((err) => {
        console.warn('[SynapseAudio] play() rejected:', err);
        cleanup();
      });

      // Start amplitude measurement loop for playback
      this._startAmplitudeLoop();
    });
  }

  stopPlayback(): void {
    if (this._audioEl) {
      this._audioEl.pause();
      this._audioEl.currentTime = 0;
      // Revoke blob URL to free memory
      if (this._audioEl.src.startsWith('blob:')) {
        URL.revokeObjectURL(this._audioEl.src);
      }
      this._audioEl.src = '';
      this._audioEl.load(); // Force release of audio resources
      this._audioEl = null;
    }
    // Disconnect audio graph nodes
    if (this._playbackSourceNode) {
      try { this._playbackSourceNode.disconnect(); } catch { /* ignore */ }
      this._playbackSourceNode = null;
    }
    // Resolve pending promise so callers unblock
    const resolve = this._playbackResolve;
    this._playbackResolve = null;
    this.isPlaying = false;
    this.playbackAmplitude = 0;
    resolve?.();
    this._stopRaf();
  }

  // ─── Amplitude RAF loop ─────────────────────────────────────────────────────

  private _startAmplitudeLoop(): void {
    this._stopRaf(); // cancel any existing RAF

    const tick = () => {
      if (this._destroyed) return;

      const analyser = this._analyser;
      const buffer = this._analyserBuffer;

      if (analyser && buffer) {
        analyser.getByteTimeDomainData(buffer);
        const amp = computeRmsAmplitude(buffer);

        if (this.isRecording) {
          this.amplitude = amp;
        }
        if (this.isPlaying) {
          this.playbackAmplitude = amp;
        }
      }

      // Continue loop only while active
      if (this.isRecording || this.isPlaying) {
        this._rafId = requestAnimationFrame(tick);
      }
    };

    this._rafId = requestAnimationFrame(tick);
  }

  private _stopRaf(): void {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
  }

  // ─── Cleanup helpers ────────────────────────────────────────────────────────

  private _stopStream(): void {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    try { this._sourceNode?.disconnect(); } catch { /* ignore */ }
    this._sourceNode = null;
  }

  // ─── destroy ────────────────────────────────────────────────────────────────

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    // Stop recording
    if (this._recorder && this._recorder.state !== 'inactive') {
      try { this._recorder.stop(); } catch { /* ignore */ }
    }
    this._recorder = null;
    this._chunks = [];

    // Stop stream
    this._stopStream();

    // Stop playback
    if (this._audioEl) {
      try {
        this._audioEl.pause();
      } catch { /* ignore */ }
      this._audioEl = null;
    }

    this._playbackResolve?.();
    this._playbackResolve = null;

    // Stop RAF
    this._stopRaf();

    // Disconnect analyser
    try { this._analyser?.disconnect(); } catch { /* ignore */ }
    this._analyser = null;
    this._analyserBuffer = null;

    // Close AudioContext
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      this._audioCtx.close().catch(() => { /* ignore */ });
    }
    this._audioCtx = null;

    this.isRecording = false;
    this.isPlaying = false;
    this.amplitude = 0;
    this.playbackAmplitude = 0;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a new AudioEngine instance.
 * The caller is responsible for calling destroy() when done.
 */
export function createAudioEngine(): AudioEngine {
  return new AudioEngineImpl();
}

export type { MicError as AudioMicError };
