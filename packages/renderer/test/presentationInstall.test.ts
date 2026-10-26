import { afterEach, describe, expect, it } from "vitest";
import { installPatches, isPresentationMode, persistPresentationFlag, type WindowLike } from "../src/presentation/install";

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

function setup(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const win = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    WebSocket: class {} as unknown as typeof WebSocket,
  } satisfies WindowLike;
  installPatches(win);
  return { win, calls };
}

describe("isPresentationMode", () => {
  const store = (v: string | null) => ({ getItem: () => v });
  it("?present=1 and ?present=0 win over storage", () => {
    expect(isPresentationMode("?present=1", store("0"))).toBe(true);
    expect(isPresentationMode("?present=0", store("1"))).toBe(false);
  });
  it("falls back to storage, and to off when storage throws", () => {
    expect(isPresentationMode("", store("1"))).toBe(true);
    expect(isPresentationMode("", store(null))).toBe(false);
    expect(isPresentationMode("", { getItem: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("masked fetch", () => {
  it("masks JSON responses and leaves non-text responses alone", async () => {
    const { win } = setup((url) =>
      url.startsWith("/blob") ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/wav" } }) : json({ repo: "acme-web", note: "call Maria" }),
    );
    const body = await (await win.fetch("/x")).json();
    expect(body.repo).toBe("project-1");
    expect(JSON.stringify(body)).not.toContain("Maria");
    const bin = new Uint8Array(await (await win.fetch("/blob")).arrayBuffer());
    expect([...bin]).toEqual([1, 2, 3]);
  });

  it("keeps status and masks error bodies too", async () => {
    const { win } = setup(() => json({ error: "cannot open /Users/jane/secret.txt" }, { status: 500 }));
    const res = await win.fetch("/x");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("jane");
  });

  it("turns aliases in the query string and JSON body back into real values", async () => {
    const { win, calls } = setup((url) => (url.startsWith("/projects") ? json([{ slug: "acme-web" }]) : json({ items: [] })));
    const [{ slug }] = await (await win.fetch("/projects")).json();
    expect(slug).toBe("project-1");
    await win.fetch(`/items?project=${slug}&source=human`);
    await win.fetch("/chat", { method: "POST", body: JSON.stringify({ text: "hi", repo: slug }) });
    expect(calls[1].url).toBe("/items?project=acme-web&source=human");
    expect(JSON.parse(String(calls[2].init?.body)).repo).toBe("acme-web");
  });

  it("restores real values inside a JSON body without breaking the JSON (Windows paths, quotes)", async () => {
    const { win, calls } = setup((url) => (url.startsWith("/projects") ? json([{ slug: "weird\"repo\\name" }]) : json({})));
    const [{ slug }] = await (await win.fetch("/projects")).json();
    expect(slug).toBe("project-1");
    await win.fetch("/chat", { method: "POST", body: JSON.stringify({ repo: slug, text: "hi" }) });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ repo: 'weird"repo\\name', text: "hi" });
  });

  it("does NOT turn aliases back into real names for /tts — that text is spoken aloud", async () => {
    const { win, calls } = setup((url) => (url.startsWith("/projects") ? json([{ slug: "acme-web" }]) : json({})));
    const [{ slug }] = await (await win.fetch("/projects")).json();
    await win.fetch("/tts", { method: "POST", body: JSON.stringify({ text: `I changed ${slug}` }) });
    expect(JSON.parse(String(calls[1].init?.body)).text).toBe("I changed project-1");
  });

  it("never sends real values to another origin", async () => {
    const { win, calls } = setup((url) => (url.startsWith("/projects") ? json([{ slug: "acme-web" }]) : json({})));
    const [{ slug }] = await (await win.fetch("/projects")).json();
    await win.fetch(`https://elsewhere.example/x?q=${slug}`);
    expect(calls[1].url).toContain(slug);
  });

  it("masks ndjson, text/html, missing content types and text/plain JSON; leaves audio alone", async () => {
    const bodies: Record<string, Response> = {
      "/nd": new Response('{"text":"call Maria"}\n{"text":"call Maria again"}\n', { headers: { "content-type": "application/x-ndjson" } }),
      "/html": new Response("<p>Maria at /Users/jane/acme</p>", { headers: { "content-type": "text/html" } }),
      "/none": new Response("Maria"),
      "/tp": new Response(JSON.stringify({ repo: "acme-web" }), { headers: { "content-type": "text/plain" } }),
      "/wav": new Response(new Uint8Array([9]), { headers: { "content-type": "audio/wav" } }),
    };
    const { win } = setup((url) => bodies[url]);
    for (const u of ["/nd", "/html", "/none"]) expect(await (await win.fetch(u)).text()).not.toMatch(/Maria|jane|acme/);
    expect(JSON.parse(await (await win.fetch("/tp")).text()).repo).toBe("project-1");
    expect([...new Uint8Array(await (await win.fetch("/wav")).arrayBuffer())]).toEqual([9]);
  });

  it("passes bodiless statuses and 3D model files through untouched", async () => {
    const { win } = setup((url) =>
      url === "/gone" ? new Response(null, { status: 204 }) : new Response(new Uint8Array([7]), { headers: { "content-type": "model/gltf-binary" } }),
    );
    expect((await win.fetch("/gone")).status).toBe(204);
    expect([...new Uint8Array(await (await win.fetch("/m.glb")).arrayBuffer())]).toEqual([7]);
  });

  it("refuses POST /open so a talk cannot pop open real folders", async () => {
    const { win, calls } = setup(() => json({ ok: true }));
    const res = await win.fetch("/open", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("persistPresentationFlag", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { m, setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null };
  };

  it("remembers ?present=1 so a link opened later (notification click) is masked too", () => {
    const s = mem();
    persistPresentationFlag("?present=1", s);
    expect(isPresentationMode("", s)).toBe(true);
    persistPresentationFlag("?present=0", s);
    expect(isPresentationMode("", s)).toBe(false);
  });

  it("does nothing without the flag", () => {
    const s = mem();
    persistPresentationFlag("?x=1", s);
    expect(s.m.size).toBe(0);
  });
});

describe("masked WebSocket — every way to listen", () => {
  class FakeWS extends EventTarget {
    static last: FakeWS;
    constructor(public url: string) {
      super();
      FakeWS.last = this;
    }
  }
  const frame = (data: string) => new MessageEvent("message", { data });
  const raw = JSON.stringify({ repo: "acme-web", text: "call Maria" });
  afterEach(() => undefined);

  function ws() {
    const win = { fetch: (async () => json({})) as typeof fetch, WebSocket: FakeWS as unknown as typeof WebSocket } satisfies WindowLike;
    installPatches(win);
    return new win.WebSocket("ws://x") as unknown as FakeWS & { onmessage: ((e: MessageEvent) => void) | null };
  }

  it("addEventListener(function), addEventListener({handleEvent}) and onmessage all get masked data, once each", () => {
    const sock = ws();
    const got: string[] = [];
    sock.addEventListener("message", (e) => got.push("fn:" + (e as MessageEvent).data));
    sock.addEventListener("message", { handleEvent: (e: Event) => void got.push("obj:" + (e as MessageEvent).data) });
    sock.onmessage = (e) => void got.push("on:" + e.data);
    sock.dispatchEvent(frame(raw));
    expect(got).toHaveLength(3);
    expect(got.join("|")).not.toMatch(/acme|Maria/);
  });

  it("removeEventListener really removes the wrapped listener", () => {
    const sock = ws();
    let n = 0;
    const l = () => void n++;
    sock.addEventListener("message", l);
    sock.removeEventListener("message", l);
    sock.dispatchEvent(frame(raw));
    expect(n).toBe(0);
  });
});
