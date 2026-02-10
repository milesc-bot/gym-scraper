/**
 * hardwareProfiles.ts — Curated pool of plausible hardware identifiers.
 *
 * WHY maintain a pool instead of using a single static value?
 * ────────────────────────────────────────────────────────────
 * Anti-bot systems fingerprint the GPU vendor/renderer strings, screen
 * resolution, platform, and other hardware signals.  If every request
 * from our scraper reports the exact same profile, it becomes a trivially
 * blockable "cohort of one".  By randomly selecting from a pool of
 * real-world-plausible profiles, each session looks like a different user's
 * machine.
 *
 * WHY curate the pool rather than randomise freely?
 * ──────────────────────────────────────────────────
 * Defenders validate consistency: an "ANGLE (Apple M2)" GPU paired with
 * "Windows 10" is obviously fake.  Each profile here is a self-consistent
 * combination of GPU, platform, viewport, and renderer that actually
 * exists in the wild.
 */

export interface HardwareProfile {
  /** WebGL RENDERER string (e.g. "ANGLE (Intel(R) UHD Graphics 630)"). */
  webglRenderer: string;
  /** WebGL VENDOR string. */
  webglVendor: string;
  /** navigator.platform value. */
  platform: string;
  /** Screen resolution [width, height]. */
  screen: [number, number];
  /** Number of logical CPU cores. */
  hardwareConcurrency: number;
  /** Device memory in GB. */
  deviceMemory: number;
}

/**
 * Pool of realistic hardware profiles observed from real desktop browsers.
 *
 * Sources: WebGL Report, user-agent analytics, Steam hardware survey 2025.
 * Each entry is a self-consistent tuple that could belong to a real machine.
 */
export const HARDWARE_PROFILES: HardwareProfile[] = [
  // ── Intel integrated (most common desktop GPU worldwide) ──
  {
    webglRenderer: 'ANGLE (Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (Intel)',
    platform: 'Win32',
    screen: [1920, 1080],
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
  {
    webglRenderer: 'ANGLE (Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (Intel)',
    platform: 'Win32',
    screen: [2560, 1440],
    hardwareConcurrency: 16,
    deviceMemory: 16,
  },
  {
    webglRenderer: 'ANGLE (Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (Intel)',
    platform: 'Win32',
    screen: [1920, 1080],
    hardwareConcurrency: 12,
    deviceMemory: 16,
  },

  // ── NVIDIA discrete ───────────────────────────────────────
  {
    webglRenderer: 'ANGLE (NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (NVIDIA)',
    platform: 'Win32',
    screen: [1920, 1080],
    hardwareConcurrency: 12,
    deviceMemory: 16,
  },
  {
    webglRenderer: 'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (NVIDIA)',
    platform: 'Win32',
    screen: [2560, 1440],
    hardwareConcurrency: 16,
    deviceMemory: 32,
  },
  {
    webglRenderer: 'ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (NVIDIA)',
    platform: 'Win32',
    screen: [3840, 2160],
    hardwareConcurrency: 16,
    deviceMemory: 32,
  },

  // ── AMD discrete ──────────────────────────────────────────
  {
    webglRenderer: 'ANGLE (AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)',
    webglVendor: 'Google Inc. (AMD)',
    platform: 'Win32',
    screen: [1920, 1080],
    hardwareConcurrency: 8,
    deviceMemory: 16,
  },

  // ── Apple Silicon (macOS) ─────────────────────────────────
  {
    webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    webglVendor: 'Google Inc. (Apple)',
    platform: 'MacIntel',
    screen: [2560, 1600],
    hardwareConcurrency: 8,
    deviceMemory: 8,
  },
  {
    webglRenderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
    webglVendor: 'Google Inc. (Apple)',
    platform: 'MacIntel',
    screen: [3024, 1964],
    hardwareConcurrency: 8,
    deviceMemory: 16,
  },
  {
    webglRenderer: 'ANGLE (Apple, Apple M3 Pro, OpenGL 4.1)',
    webglVendor: 'Google Inc. (Apple)',
    platform: 'MacIntel',
    screen: [3456, 2234],
    hardwareConcurrency: 12,
    deviceMemory: 18,
  },
];

/**
 * Select a random hardware profile for this session.
 *
 * WHY select once per session instead of per page?
 * A real user's hardware doesn't change between page loads.  If we
 * randomised per-page, a defender comparing two requests from the same
 * IP within seconds would see different GPUs — an obvious red flag.
 */
export function pickRandomProfile(): HardwareProfile {
  const idx = Math.floor(Math.random() * HARDWARE_PROFILES.length);
  return HARDWARE_PROFILES[idx];
}
