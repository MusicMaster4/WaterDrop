"use strict";

// Route- and error-path coverage for the drop server. The companion
// dropServer.test.js exercises the happy-path upload/download flows; this file
// focuses on the edges: unknown routes, missing resources, CORS preflight,
// range validation, base-path prefixing, retention expiry, and folder naming.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDropServer, FileStore, BASE_PATH } = require("../src/server/dropServer");

let nextPort = 48100;

// Spin up an isolated server in a throwaway temp tree and hand it to `fn`,
// tearing everything down afterwards regardless of how the test ends. `base`
// is the app root (under BASE_PATH); `origin` is the bare host for hitting
// absolute paths like `/` or `/drop`.
async function withServer(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-routes-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: nextPort++ });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await fn({ server, base: server.localUrl, origin, dataDir, downloads, rendererDir });
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const MISSING_ID = "99999999-9999-4999-8999-999999999999";

async function uploadRaw(base, { id, name = "file.txt", body = "hello", mimeType = "text/plain" }) {
  return fetch(new URL("api/files/raw", base), {
    method: "POST",
    body: new Blob([body], { type: mimeType }),
    headers: {
      "Content-Type": mimeType,
      "X-WaterDrop-File-Name": encodeURIComponent(name),
      "X-WaterDrop-Mime-Type": mimeType,
      "X-WaterDrop-Upload-Id": id,
    },
  });
}

test("ping is a cheap side-effect-free ok probe", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(new URL("api/ping", base));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const head = await fetch(new URL("api/ping", base), { method: "HEAD" });
    assert.equal(head.status, 200);
  });
});

test("the file list response carries pending, deletedUploads, and settings", async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(new URL("api/files", base))).json();
    assert.deepEqual(body.files, []);
    assert.deepEqual(body.pending, []);
    assert.deepEqual(body.deletedUploads, []);
    assert.equal(typeof body.settings, "object");
    assert.notEqual(body.settings, null);
  });
});

test("unknown API routes and unknown paths return distinct 404s", async () => {
  await withServer(async ({ origin }) => {
    const api = await fetch(`${origin}/api/does-not-exist`);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error, "API route not found");

    const page = await fetch(`${origin}/totally/unknown`);
    assert.equal(page.status, 404);
    assert.equal((await page.json()).error, "Not found");

    // A wrong method on a known collection route falls through to the API 404.
    const badMethod = await fetch(`${origin}/api/ping`, { method: "DELETE" });
    assert.equal(badMethod.status, 404);
  });
});

test("mutations against missing resources return 404 without throwing", async () => {
  await withServer(async ({ base }) => {
    const del = await fetch(new URL(`api/files/${MISSING_ID}`, base), { method: "DELETE" });
    assert.equal(del.status, 404);
    assert.equal((await del.json()).ok, false);

    const download = await fetch(new URL(`api/files/${MISSING_ID}/download`, base));
    assert.equal(download.status, 404);

    const preview = await fetch(new URL(`api/files/${MISSING_ID}/preview`, base));
    assert.equal(preview.status, 404);

    const rename = await fetch(new URL(`api/folders/${MISSING_ID}`, base), {
      method: "PATCH",
      body: JSON.stringify({ name: "Nope" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(rename.status, 404);
    assert.equal((await rename.json()).error, "Folder not found");
  });
});

test("cancelling uploads distinguishes malformed ids from unknown ones", async () => {
  await withServer(async ({ base }) => {
    // Not UUID-shaped: rejected by the route regex before reaching the handler.
    const malformed = await fetch(new URL("api/uploads/not-a-valid-uuid", base), { method: "DELETE" });
    assert.equal(malformed.status, 404);

    // Well-formed but never seen: cancel is idempotent and succeeds, tombstoning
    // the id so a late retry can't resurrect it.
    const unknown = await fetch(new URL(`api/uploads/${MISSING_ID}`, base), { method: "DELETE" });
    assert.equal(unknown.status, 200);
    const body = await unknown.json();
    assert.equal(body.ok, true);
    assert.equal(body.cancelled, true);

    const listed = await (await fetch(new URL("api/files", base))).json();
    assert.equal(listed.deletedUploads.includes(MISSING_ID), true);
  });
});

test("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(new URL("api/files", base), { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("access-control-allow-methods") || "", /POST/);
  });
});

test("the bare base path redirects to its trailing-slash form", async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}${BASE_PATH}`, { redirect: "manual" });
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), `${BASE_PATH}/`);
  });
});

test("the API is reachable under the base-path prefix too", async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}${BASE_PATH}/api/files`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.files, []);
  });
});

test("an unsatisfiable range yields 416 with a Content-Range of the full size", async () => {
  await withServer(async ({ base }) => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const upload = await uploadRaw(base, { id, body: "abcdef" });
    assert.equal(upload.status, 201);

    const res = await fetch(new URL(`api/files/${id}/download`, base), {
      headers: { Range: "bytes=100-200" },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), "bytes */6");
  });
});

test("download exposes the sha-256 and content hash matches the bytes", async () => {
  await withServer(async ({ base }) => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const payload = "the quick brown fox";
    const upload = await uploadRaw(base, { id, body: payload });
    assert.equal(upload.status, 201);

    const res = await fetch(new URL(`api/files/${id}/download`, base));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("etag"), `"sha256-${sha256(Buffer.from(payload))}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.toString("utf8"), payload);
    assert.equal(sha256(bytes), res.headers.get("x-waterdrop-sha256"));
  });
});

test("index.html is served as no-store html so clients always get fresh markup", async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/index.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(await res.text(), /WaterDrop/);
  });
});

test("static serving rejects a non-GET method with 405", async () => {
  await withServer(async ({ origin }) => {
    const res = await fetch(`${origin}/index.html`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.equal((await res.json()).error, "Method not allowed");
  });
});

test("createFolder auto-numbers names and skips numbers already in use", async () => {
  await withServer(async ({ base }) => {
    const first = await (await fetch(new URL("api/folders", base), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    })).json();
    assert.equal(first.folder.name, "Folder1");

    const named = await (await fetch(new URL("api/folders", base), {
      method: "POST",
      body: JSON.stringify({ name: "Folder2" }),
      headers: { "Content-Type": "application/json" },
    })).json();
    assert.equal(named.folder.name, "Folder2");

    // Next auto name must skip the taken "Folder2" and land on "Folder3".
    const third = await (await fetch(new URL("api/folders", base), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    })).json();
    assert.equal(third.folder.name, "Folder3");
  });
});

test("renaming a folder with an empty name preserves the existing name", async () => {
  await withServer(async ({ server }) => {
    const created = await server.store.createFolder({ name: "Keep Me" });
    const renamed = await server.store.renameFolder(created.id, "");
    assert.equal(renamed.name, "Keep Me");
  });
});

test("cleanupExpired removes files past their expiry and reports the count", async () => {
  await withServer(async ({ server, base }) => {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const upload = await uploadRaw(base, { id, body: "expiring" });
    assert.equal(upload.status, 201);

    const stored = server.store.get(id);
    assert.ok(stored, "file should be stored before expiry");
    // Back-date the expiry so cleanup treats it as stale.
    stored.expiresAt = Date.now() - 1000;

    const removed = await server.store.cleanupExpired();
    assert.equal(removed, 1);
    assert.equal(server.store.get(id), null);

    const listed = await (await fetch(new URL("api/files", base))).json();
    assert.equal(listed.files.length, 0);
    // The expired id is remembered so stale retries can't resurrect it.
    assert.equal(listed.deletedUploads.includes(id), true);
  });
});

test("a FileStore restarts with previously persisted files intact", async () => {
  await withServer(async ({ base, dataDir, downloads }) => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const upload = await uploadRaw(base, { id, name: "persist.txt", body: "durable" });
    assert.equal(upload.status, 201);

    // The commit already persisted files.json, so a fresh store over the same
    // data dir should rehydrate the committed file (withServer closes the
    // original server afterwards).
    const store = new FileStore({ dataDir, defaultDownloadDir: downloads });
    await store.init();
    const file = store.get(id);
    assert.ok(file);
    assert.equal(file.name, "persist.txt");
    assert.equal(file.size, "durable".length);
  });
});
