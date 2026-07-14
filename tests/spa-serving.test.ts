// CR-CRU-006 §S1/§S2/§S5 — static SPA serving, client-side routing fallback,
// vendored assets, no-CDN AC, and static-path safety. Drives the REAL prod
// boot via startServer (port 0 / :memory:), never a hand-wired store.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

describe("SPA shell — static serving (CR-CRU-006 §S1/§S2/§S5)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  test("GET / serves the SPA shell HTML with the forge theme and app mount", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const res = await fetch(`${base()}/`);

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('data-theme="forge"');
    expect(body).toContain('<div id="app">');
  });

  describe("SPA fallback for deep links (§S2 — 2 pages + overlay, deep-linkable)", () => {
    test("GET /p/<key> returns the SAME index HTML as / (fresh-load deep link)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const rootRes = await fetch(`${base()}/`);
      expect(rootRes.status).toBe(200);
      const rootBody = await rootRes.text();

      const workspaceRes = await fetch(`${base()}/p/some-key`);
      expect(workspaceRes.status).toBe(200);
      expect(workspaceRes.headers.get("content-type") ?? "").toContain("text/html");
      const workspaceBody = await workspaceRes.text();

      expect(workspaceBody).toBe(rootBody);
      expect(workspaceBody).toContain('<div id="app">');
    });

    test("GET /p/<key>/run/<eventId> (overlay deep link) returns the SAME index HTML as /", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const rootRes = await fetch(`${base()}/`);
      const rootBody = await rootRes.text();

      const overlayRes = await fetch(`${base()}/p/x/run/evt-123`);
      expect(overlayRes.status).toBe(200);
      expect(overlayRes.headers.get("content-type") ?? "").toContain("text/html");
      const overlayBody = await overlayRes.text();

      expect(overlayBody).toBe(rootBody);
      expect(overlayBody).toContain('<div id="app">');
    });

    test("API discipline preserved: GET /api/nope still 404 JSON (not swallowed by the SPA fallback)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/api/nope`);

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    });

    test("API discipline preserved: GET /api/health still 200 JSON (not swallowed by the SPA fallback)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/api/health`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });
  });

  describe("Vendored app-shell assets served (§S1 — no CDN, no build step)", () => {
    test("GET /vendor/van-1.5.5.nomodule.min.js → 200 javascript", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const res = await fetch(`${base()}/vendor/van-1.5.5.nomodule.min.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("javascript");
    });

    test("GET /vendor/daisyui-5.5.19.css → 200 text/css", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const res = await fetch(`${base()}/vendor/daisyui-5.5.19.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("css");
    });

    test("GET /app.js (app shell entry) → 200 javascript", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const res = await fetch(`${base()}/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("javascript");
    });

    test("GET /styles.css (app shell styles, forge theme) → 200 css", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const res = await fetch(`${base()}/styles.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("css");
    });
  });

  test("no-CDN AC: served index HTML contains NO http:// or https:// in any src=/href= attribute", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    const body = await res.text();

    const cdnAttr = /(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/i;
    expect(cdnAttr.test(body)).toBe(false);
  });

  test("index.html references exactly the 5 vendor files + app.js + styles.css as relative paths", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain("styles.css");
    expect(body).toContain("van-1.5.5.nomodule.min.js");
    expect(body).toContain("van-x-0.6.3.nomodule.min.js");
    expect(body).toContain("tailwind-browser-4.2.4.js");
    expect(body).toContain("daisyui-5.5.19.css");
    expect(body).toContain("daisyui-themes-5.5.19.css");
    expect(body).toContain("app.js");
  });

  describe("Static path safety — no traversal outside public/ (§S1)", () => {
    test("GET /%2e%2e/package.json does not leak the repo's package.json", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/%2e%2e/package.json`);

      if (res.status === 200) {
        const body = await res.text();
        // The real package.json declares the "bun-types" devDependency; a safe
        // handler must never surface that content through a traversal path.
        expect(body).not.toContain("bun-types");
      } else {
        expect(res.status).toBe(404);
      }
    });

    test("GET /vendor/%2e%2e/%2e%2e/.env does not leak files outside public/", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/vendor/%2e%2e/%2e%2e/.env`);

      // No .env exists in this repo either way, but the request must not be
      // served as a 200 with arbitrary filesystem content — 404 (unresolved)
      // or a normalized-and-not-found result are the only safe outcomes.
      expect(res.status).not.toBe(200);
    });
  });

  describe("Extension-based SPA-vs-404 static dispatch (§S2 deep-link fallback)", () => {
    test("GET /favicon.ico (unknown extensioned static asset) falls back to the SPA HTML", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/favicon.ico`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const body = await res.text();
      expect(body).toContain('<div id="app">');
    });

    test("GET /mission-control (unknown extension-less path) falls back to the SPA HTML", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/mission-control`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const body = await res.text();
      expect(body).toContain('<div id="app">');
    });

    test("GET /nope.js (unknown path WITH an extension) 404s instead of falling back to the SPA", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/nope.js`);

      expect(res.status).toBe(404);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).not.toContain("text/html");
    });

    test("GET /app-logic.mjs → 200 javascript module, never the SPA HTML (blank-page defect)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/app-logic.mjs`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("javascript");
      const body = await res.text();
      expect(body).toContain("CrucibleLogic");
    });

    test("GET /nope.mjs (missing .mjs file) 404s instead of falling back to the SPA", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`${base()}/nope.mjs`);

      expect(res.status).toBe(404);
    });
  });
});
