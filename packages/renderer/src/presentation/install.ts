/**
 * Presentation mode — the install step. Wraps `fetch` and `WebSocket` on the
 * window so every byte the app receives goes through mask() first, and every
 * request it sends has its aliases turned back into the real values.
 *
 * This is the only place presentation mode touches the app: no view, store or
 * reducer is aware of it. The switch is read once at boot (URL or storage) and
 * flipping it reloads the page, so nothing rendered before the switch can
 * linger on screen.
 */
import { setActiveMasker } from "./active";
import { createMasker, type Masker } from "./mask";

const STORAGE_KEY = "agent-office.present";

/** The slice of `window` this module needs — injectable for tests. */
export interface WindowLike {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

/** ?present=1 / ?present=0 wins; otherwise the saved choice. Never throws. */
export function isPresentationMode(
  search: string = typeof location !== "undefined" ? location.search : "",
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): boolean {
  const q = new URLSearchParams(search).get("present");
  if (q === "1") return true;
  if (q === "0") return false;
  try {
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * ?present=1 / ?present=0 in the URL is remembered, so a link opened later (an OS notification's
 * ?focus= click, a bookmark) lands in the same mode instead of unmasked.
 */
export function persistPresentationFlag(
  search: string = typeof location !== "undefined" ? location.search : "",
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  const q = new URLSearchParams(search).get("present");
  if (q !== "1" && q !== "0") return;
  try {
    storage?.setItem(STORAGE_KEY, q);
  } catch {
    // storage blocked: the URL flag still works for this page
  }
}

/** Save the choice and reload so the app boots with (or without) the mask. */
export function setPresentationMode(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // storage blocked: fall back to the URL flag below
  }
  const url = new URL(location.href);
  url.searchParams.set("present", on ? "1" : "0");
  location.href = url.toString();
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Endpoints that act on the real machine; a talk must not trigger them. */
const BLOCKED_POSTS = new Set([
  "/open",
  "/sessions/open-terminal", // opens a real terminal at the real path, on the projector
  // these send back text the page only holds masked (a document body, a quoted anchor): the
  // aliases would be restored but the blurred words cannot, and the real file would be overwritten
  "/docs/save",
  "/docs/comment",
]);

/** Requests whose text must stay as masked as it is on screen: it is spoken aloud. */
const NO_UNMASK_POSTS = new Set(["/tts"]);

/** Only genuinely binary payloads pass through untouched; everything else is text and gets masked. */
const BINARY = /^(audio|video|image|font|model)\/|octet-stream|wasm|\bpdf\b|zip/i;
/** Statuses that cannot carry a body (a `new Response("", { status })` with these throws). */
const NO_BODY = new Set([101, 204, 205, 304]);

/** A relative URL, or one on this page's origin. Real values must never leave for another host. */
function sameOrigin(raw: string): boolean {
  try {
    const here = typeof location !== "undefined" && location.origin ? location.origin : "http://presentation.invalid";
    return new URL(raw, here).origin === here;
  } catch {
    return false;
  }
}

/** Mask a text body: a JSON document, newline-delimited JSON, or plain text — in that order of preference. */
function maskBody(masker: Masker, body: string): string {
  try {
    return JSON.stringify(masker.mask(JSON.parse(body)));
  } catch {
    // not one JSON document
  }
  const lines = body.split("\n");
  const parsed = lines.map((l) => {
    if (!l.trim()) return l;
    try {
      return JSON.stringify(masker.mask(JSON.parse(l)));
    } catch {
      return null;
    }
  });
  return parsed.every((l) => l !== null) ? parsed.join("\n") : masker.maskText(body);
}

/** Replace aliases in the path and query of a (possibly relative) URL. */
function unmaskUrl(masker: Masker, raw: string): string {
  const base = "http://presentation.invalid";
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return masker.unmask(raw);
  }
  const params = [...u.searchParams.entries()].map(([k, v]) => [k, masker.unmask(v)] as const);
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  let decoded = u.pathname;
  try {
    decoded = decodeURIComponent(u.pathname);
  } catch {
    // malformed % sequence: leave the path as it is
  }
  const pathname = masker.unmask(decoded);
  const rel = `${pathname === u.pathname ? u.pathname : encodeURI(pathname)}${u.search}`;
  return u.origin === base && !/^[a-z][a-z0-9+.-]*:/i.test(raw) ? rel : `${u.origin}${rel}`;
}

/** Unmask a request body. JSON is walked structurally: raw values with quotes or backslashes must not corrupt the document. */
function unmaskBody(masker: Masker, body: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return masker.unmask(body);
  }
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? masker.unmask(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [masker.unmask(k), walk(x)]))
          : v;
  return JSON.stringify(walk(doc));
}

function maskedFetch(native: typeof fetch, masker: Masker): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const pathname = new URL(rawUrl, "http://presentation.invalid").pathname;
    if (method === "POST" && BLOCKED_POSTS.has(pathname)) {
      return new Response(JSON.stringify({ error: "disabled in presentation mode" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    const local = sameOrigin(rawUrl);
    const url = local ? unmaskUrl(masker, rawUrl) : rawUrl;
    const nextInit: RequestInit | undefined =
      local && !NO_UNMASK_POSTS.has(pathname) && typeof init?.body === "string"
        ? { ...init, body: unmaskBody(masker, init.body) }
        : init;
    const res = await native(typeof input === "string" || input instanceof URL ? url : new Request(url, input), nextInit);

    const type = res.headers.get("content-type") ?? "";
    if (BINARY.test(type) || NO_BODY.has(res.status) || res.type === "opaque" || res.body === null) return res;

    const masked = maskBody(masker, await res.text());
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(masked, { status: res.status, statusText: res.statusText, headers });
  };
}

function findDescriptor(proto: object | null, key: string): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (d) return d;
  }
  return undefined;
}

function maskedWebSocket(Native: typeof WebSocket, masker: Masker): typeof WebSocket {
  const maskEvent = (ev: MessageEvent): MessageEvent => {
    if (typeof ev.data !== "string") return ev;
    let data = ev.data;
    try {
      data = JSON.stringify(masker.mask(JSON.parse(ev.data)));
    } catch {
      data = masker.maskText(ev.data);
    }
    return new MessageEvent("message", { data, origin: ev.origin, lastEventId: ev.lastEventId });
  };

  // Every route a page has to receive a message — onmessage and addEventListener —
  // goes through a wrapper that hands the app a masked copy. Wrapping the
  // listeners (rather than racing them in the listener list) keeps this
  // correct whatever order a platform dispatches in.
  const nativeOnMessage = findDescriptor(Native.prototype, "onmessage");

  class MaskedWebSocket extends Native {
    private wrapped = new WeakMap<object, EventListener>();
    private slot: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;

    override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
      if (type !== "message" || !listener) return EventTarget.prototype.addEventListener.call(this, type, listener, opts);
      let w = this.wrapped.get(listener);
      if (!w) {
        w = (ev: Event) => {
          const m = maskEvent(ev as MessageEvent);
          if (typeof listener === "function") listener.call(this, m);
          else listener.handleEvent(m);
        };
        this.wrapped.set(listener, w);
      }
      EventTarget.prototype.addEventListener.call(this, type, w, opts);
    }

    override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions): void {
      const w = type === "message" && listener ? this.wrapped.get(listener) : undefined;
      EventTarget.prototype.removeEventListener.call(this, type, w ?? listener, opts);
    }

    // The handler the page sees (and that a platform may call directly) is the
    // masking wrapper; the platform's own onmessage slot holds it too.
    private slotListener: EventListener | null = null;

    private viaListener(): void {
      if (this.slotListener) EventTarget.prototype.removeEventListener.call(this, "message", this.slotListener);
      this.slotListener = this.slot ? (ev: Event) => this.slot?.call(this, ev as MessageEvent) : null;
      if (this.slotListener) EventTarget.prototype.addEventListener.call(this, "message", this.slotListener);
    }

    override get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
      return this.slot;
    }

    override set onmessage(fn: ((this: WebSocket, ev: MessageEvent) => unknown) | null) {
      this.slot = fn ? (ev: MessageEvent) => fn.call(this, maskEvent(ev)) : null;
      if (nativeOnMessage?.set) nativeOnMessage.set.call(this, this.slot);
      else this.viaListener(); // a platform without an onmessage accessor (and test doubles)
    }
  }
  return MaskedWebSocket;
}

/** Wrap fetch + WebSocket on `win` unconditionally. Returns the masker in use. */
export function installPatches(win: WindowLike, masker: Masker = createMasker()): Masker {
  win.fetch = maskedFetch(win.fetch.bind(win), masker);
  win.WebSocket = maskedWebSocket(win.WebSocket, masker);
  return masker;
}

/** Called once, first thing in boot(): patches the window only when the switch is on. */
export function installPresentationMode(): Masker | null {
  if (typeof window === "undefined") return null;
  persistPresentationFlag();
  if (!isPresentationMode()) return null;
  document.body.dataset.presentation = "on";
  // globalThis, not window: the same object in a browser, and the one app code actually resolves
  // `fetch` / `WebSocket` against in DOM test environments
  const masker = installPatches(globalThis as unknown as WindowLike);
  setActiveMasker(masker);
  return masker;
}
