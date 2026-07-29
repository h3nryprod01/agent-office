/**
 * When to give up on the pretty office.
 *
 * main.ts wraps createOffice3D in a try/catch, but that only catches "no WebGL
 * at all". A box WITH WebGL and no GPU acceleration renders the office fine and
 * crawls — measured at 3 fps in a Windows 11 VM. You cannot catch "slow".
 *
 * So: watch the frame rate and drop the expensive bits once. The decision lives
 * here, apart from the render loop, because a rule that only runs inside
 * requestAnimationFrame can't be tested — rAF doesn't run in a test environment.
 */

/** below this, the office is not pleasant to look at */
export const LOW_FPS = 20;
/** ...and it has to stay that way this long. A GC pause, a tab regaining focus,
 *  or a heavy first second must not permanently downgrade a healthy machine. */
export const SLOW_MS = 3_000;

export interface QualityState {
  /** when the current slow streak began; 0 = not currently slow */
  slowSince: number;
  /** already downgraded — one-way, so quality can never flap */
  degraded: boolean;
}

export const initialQuality = (): QualityState => ({ slowSince: 0, degraded: false });

/**
 * Fold one fps sample into the watchdog state.
 * `degrade` is true exactly once, on the sample that ends a slow-enough streak.
 *
 * `visible` is `!document.hidden`. A backgrounded tab has its rAF throttled to a
 * crawl, so fps reads near zero no matter how fast the machine is. Believing it
 * cost the office its shadows for good — the downgrade is one-way — after the
 * user merely switched tabs for three seconds. Measured: this fired in a hidden
 * pane on a Mac that renders the office at full speed.
 */
export function watchQuality(
  state: QualityState,
  fps: number,
  now: number,
  visible = true,
): { state: QualityState; degrade: boolean } {
  if (state.degraded) return { state, degrade: false };
  if (!visible) return { state: { ...state, slowSince: 0 }, degrade: false };
  if (fps >= LOW_FPS) return { state: { ...state, slowSince: 0 }, degrade: false };

  const slowSince = state.slowSince || now;
  if (now - slowSince < SLOW_MS) return { state: { ...state, slowSince }, degrade: false };
  return { state: { slowSince, degraded: true }, degrade: true };
}
