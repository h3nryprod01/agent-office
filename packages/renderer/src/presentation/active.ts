import type { Masker } from "./mask";

let active: Masker | null = null;

/** Set by installPresentationMode(); null while presentation mode is off. */
export function setActiveMasker(m: Masker | null): void {
  active = m;
}

/**
 * Data that reaches the app without going through fetch/WebSocket (a replay
 * file picked from disk) calls this; it is the identity function when
 * presentation mode is off.
 */
export function maskIfPresenting<T>(value: T): T {
  return active ? active.mask(value) : value;
}
