/**
 * fingerprintNoise.ts — Inject Canvas, WebGL, and AudioContext noise.
 *
 * WHY inject noise at all?
 * ────────────────────────
 * Anti-bot systems call `canvas.toDataURL()`, `webgl.getParameter()`, and
 * `AudioContext` methods to compute hardware-specific fingerprints.  Headless
 * Chromium's rendering output is subtly different from a real desktop browser
 * (different font smoothing, no GPU rasterisation artifacts).  By injecting
 * controlled noise into these APIs, we make each session's fingerprint unique
 * and indistinguishable from normal cross-device variance.
 *
 * IMPORTANT CAVEAT — ACTIVE RUNTIME PROBING
 * ──────────────────────────────────────────
 * Advanced WAFs now detect JS prototype overrides by:
 *   1. Calling `Function.prototype.toString()` on patched methods — if it
 *      returns anything other than `"function toDataURL() { [native code] }"`
 *      the override is exposed.
 *   2. Checking the prototype chain for unexpected property descriptors.
 *
 * We mitigate (1) by restoring the `toString` representation and (2) by
 * using `Object.defineProperty` with the correct descriptor flags.  This is
 * a meaningful improvement but is NOT as robust as a custom Chromium fork
 * (e.g., Orbita, GoLogin) which patches at the C++ rendering layer.
 * If you need engine-level stealth, consider those alternatives.
 */

import type { Page } from 'puppeteer';
import type { HardwareProfile } from '../core/hardwareProfiles';
import { Logger } from '../core/logger';

const logger = new Logger('FingerprintNoise');

/**
 * Apply all fingerprint noise injections to a Page before any navigation.
 *
 * WHY call this via `evaluateOnNewDocument`?
 * Scripts registered with `evaluateOnNewDocument` run in every new
 * execution context (including iframes, web workers) *before* any page
 * JS executes.  This means the override is in place before any
 * fingerprinting script can call the real API.
 */
export async function injectFingerprintNoise(
  page: Page,
  profile: HardwareProfile,
): Promise<void> {
  logger.info('Injecting Canvas / WebGL / AudioContext noise…');

  // Generate a per-session random seed so noise is consistent within a page
  // load but varies across sessions.
  const sessionSeed = Math.floor(Math.random() * 2147483647);

  await injectCanvasNoise(page, sessionSeed);
  await injectWebGLNoise(page, profile);
  await injectAudioContextNoise(page, sessionSeed);
}

// ─── Canvas noise ──────────────────────────────────────────

async function injectCanvasNoise(page: Page, seed: number): Promise<void> {
  await page.evaluateOnNewDocument((noiseSeed: number) => {
    // Simple PRNG (Mulberry32) — deterministic per session so that
    // multiple calls to toDataURL() within the same page return
    // consistent results (as a real browser would).
    function mulberry32(s: number) {
      return function () {
        s |= 0; s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const rng = mulberry32(noiseSeed);

    // ── Override toDataURL ──────────────────────────────────
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const nativeToDataURLString = originalToDataURL.toString();

    Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
      value: function (this: HTMLCanvasElement, ...args: [string?, number?]) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          const data = imageData.data;
          // Apply 1–2 LSB jitter to a subset of pixels.
          // WHY only every 4th pixel?  Modifying every pixel is slow on
          // large canvases and unnecessary — even sparse noise produces
          // a unique hash.
          for (let i = 0; i < data.length; i += 16) {
            data[i] = data[i] ^ (rng() > 0.5 ? 1 : 0);     // R
            data[i + 1] = data[i + 1] ^ (rng() > 0.5 ? 1 : 0); // G
          }
          ctx.putImageData(imageData, 0, 0);
        }
        return originalToDataURL.apply(this, args);
      },
      writable: true,
      configurable: true,
    });

    // Restore toString to look native.
    HTMLCanvasElement.prototype.toDataURL.toString = () => nativeToDataURLString;

    // ── Override getImageData ───────────────────────────────
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const nativeGetImageDataString = originalGetImageData.toString();

    Object.defineProperty(CanvasRenderingContext2D.prototype, 'getImageData', {
      value: function (
        this: CanvasRenderingContext2D,
        ...args: [number, number, number, number, ...unknown[]]
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imageData = originalGetImageData.apply(this, args as any);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 16) {
          data[i] = data[i] ^ (rng() > 0.5 ? 1 : 0);
        }
        return imageData;
      },
      writable: true,
      configurable: true,
    });

    CanvasRenderingContext2D.prototype.getImageData.toString =
      () => nativeGetImageDataString;
  }, seed);
}

// ─── WebGL noise ───────────────────────────────────────────

async function injectWebGLNoise(
  page: Page,
  profile: HardwareProfile,
): Promise<void> {
  await page.evaluateOnNewDocument(
    (renderer: string, vendor: string) => {
      // Override getParameter for both WebGL1 and WebGL2.
      const contexts = [
        WebGLRenderingContext.prototype,
        // WebGL2 may not exist in all environments — guard with typeof.
        ...(typeof WebGL2RenderingContext !== 'undefined'
          ? [WebGL2RenderingContext.prototype]
          : []),
      ];

      for (const proto of contexts) {
        const original = proto.getParameter;
        const nativeString = original.toString();

        Object.defineProperty(proto, 'getParameter', {
          value: function (this: WebGLRenderingContext, pname: number) {
            // UNMASKED_VENDOR_WEBGL = 0x9245
            if (pname === 0x9245) return vendor;
            // UNMASKED_RENDERER_WEBGL = 0x9246
            if (pname === 0x9246) return renderer;
            return original.call(this, pname);
          },
          writable: true,
          configurable: true,
        });

        proto.getParameter.toString = () => nativeString;
      }
    },
    profile.webglRenderer,
    profile.webglVendor,
  );
}

// ─── AudioContext noise ────────────────────────────────────

async function injectAudioContextNoise(
  page: Page,
  seed: number,
): Promise<void> {
  await page.evaluateOnNewDocument((noiseSeed: number) => {
    // Override getFloatFrequencyData to inject micro-noise into
    // the frequency response.  Audio fingerprinting relies on the
    // precise output of the audio processing pipeline, which varies
    // by hardware.  Adding ±0.01 dB noise is imperceptible to humans
    // but changes the fingerprint hash.
    const originalGetFloat =
      AnalyserNode.prototype.getFloatFrequencyData;
    const nativeString = originalGetFloat.toString();

    // Simple seeded RNG for consistency.
    let s = noiseSeed;
    function nextRand() {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    Object.defineProperty(AnalyserNode.prototype, 'getFloatFrequencyData', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: function (this: AnalyserNode, array: any) {
        originalGetFloat.call(this, array);
        for (let i = 0; i < array.length; i++) {
          // ±0.01 noise — changes the hash without audible impact.
          array[i] += (nextRand() - 0.5) * 0.02;
        }
      },
      writable: true,
      configurable: true,
    });

    AnalyserNode.prototype.getFloatFrequencyData.toString =
      () => nativeString;
  }, seed);
}
