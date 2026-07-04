"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDropServer } = require("../src/server/dropServer");

test("uploads, lists, previews, downloads, deletes, and clears files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47950 });
  try {
    const base = server.localUrl;
    const expectedHash = sha256(Buffer.from("abcdef"));
    const uploadId = "22222222-2222-4222-8222-222222222222";

    const upload = await fetch(new URL("api/files/raw", base), {
      method: "POST",
      body: new Blob(["abcdef"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("sample.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": uploadId,
      },
    });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json();
    assert.equal(uploadBody.files.length, 1);
    assert.equal(uploadBody.files[0].id, uploadId);
    assert.equal(uploadBody.files[0].name, "sample.txt");
    assert.equal(uploadBody.files[0].size, 6);
    assert.equal(uploadBody.files[0].sha256, expectedHash);

    const duplicateUpload = await fetch(new URL("api/files/raw", base), {
      method: "POST",
      body: new Blob(["abcdef-duplicate"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("sample.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": uploadId,
      },
    });
    assert.equal(duplicateUpload.status, 200);
    const duplicateUploadBody = await duplicateUpload.json();
    assert.equal(duplicateUploadBody.duplicate, true);
    assert.equal(duplicateUploadBody.files[0].id, uploadId);

    const listed = await fetch(new URL("api/files", base));
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.files.length, 1);
    assert.equal(listedBody.files[0].size, 6);

    const strippedListed = await fetch(`http://127.0.0.1:${server.port}/api/files`);
    assert.equal(strippedListed.status, 200);
    const strippedBody = await strippedListed.json();
    assert.equal(strippedBody.files.length, 1);

    const strippedStatic = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(strippedStatic.status, 200);

    const id = listedBody.files[0].id;
    const head = await fetch(new URL(`api/files/${id}/download`, base), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("content-length"), "6");
    assert.equal(head.headers.get("x-waterdrop-sha256"), expectedHash);

    const afterHead = await fetch(new URL("api/files", base));
    const afterHeadBody = await afterHead.json();
    assert.equal(afterHeadBody.files[0].downloads, 0);

    const preview = await fetch(new URL(`api/files/${id}/preview`, base));
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-disposition"), /^inline; filename="sample\.txt"/);
    assert.equal(await preview.text(), "abcdef");

    const afterPreview = await fetch(new URL("api/files", base));
    const afterPreviewBody = await afterPreview.json();
    assert.equal(afterPreviewBody.files[0].downloads, 0);

    const ranged = await fetch(new URL(`api/files/${id}/download`, base), {
      headers: { Range: "bytes=1-3" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 1-3/6");
    assert.equal(await ranged.text(), "bcd");

    const fullDownload = await fetch(new URL(`api/files/${id}/download`, base));
    assert.equal(fullDownload.status, 200);
    const fullDownloadBytes = Buffer.from(await fullDownload.arrayBuffer());
    assert.equal(fullDownloadBytes.equals(Buffer.from("abcdef")), true);
    assert.equal(sha256(fullDownloadBytes), expectedHash);
    await waitForDownloads(base, id, 2);

    const dragPath = server.store.prepareDragFile(id);
    assert.equal(path.basename(dragPath), "sample.txt");
    assert.equal(await fs.readFile(dragPath, "utf8"), "abcdef");
    const secondDragPath = server.store.prepareDragFile(id);
    assert.notEqual(secondDragPath, dragPath);
    assert.equal(path.basename(secondDragPath), "sample.txt");
    assert.equal(await fs.readFile(secondDragPath, "utf8"), "abcdef");

    const deleted = await fetch(new URL(`api/files/${id}`, base), { method: "DELETE" });
    assert.equal(deleted.status, 200);

    const afterDelete = await fetch(new URL("api/files", base));
    const afterDeleteBody = await afterDelete.json();
    assert.equal(afterDeleteBody.files.length, 0);

    const clearForm = new FormData();
    clearForm.append("files", new Blob(["one"]), "one.txt");
    clearForm.append("files", new Blob(["two"]), "two.txt");
    const clearUpload = await fetch(new URL("api/files", base), { method: "POST", body: clearForm });
    assert.equal(clearUpload.status, 201);

    const cleared = await fetch(new URL("api/files", base), { method: "DELETE" });
    assert.equal(cleared.status, 200);
    const clearedBody = await cleared.json();
    assert.equal(clearedBody.deleted, 2);

    const afterClear = await fetch(new URL("api/files", base));
    const afterClearBody = await afterClear.json();
    assert.equal(afterClearBody.files.length, 0);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uploads announce a placeholder before committing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-events-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47980 });
  try {
    // The first broadcast is the in-flight placeholder so every device can show
    // a shimmer while bytes are still arriving; the commit event follows.
    const eventPromise = waitForFileEvent(new URL("api/events", server.localUrl));
    const form = new FormData();
    form.append("files", new Blob(["event-body"]), "event.txt");

    const upload = await fetch(new URL("api/files", server.localUrl), { method: "POST", body: form });
    assert.equal(upload.status, 201);

    const event = await eventPromise;
    assert.equal(event.reason, "upload-start");
    assert.equal(typeof event.at, "number");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pending upload placeholder clears once the file lands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-pending-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47990 });
  try {
    // Register an in-flight upload directly and confirm the list surfaces it,
    // then confirm committing the file removes the placeholder.
    const id = "11111111-1111-4111-8111-111111111111";
    server.store.addPendingUpload({ id, name: "big.bin", size: 4096 });

    const listed = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(listed.pending.length, 1);
    assert.equal(listed.pending[0].id, id);
    assert.equal(listed.pending[0].name, "big.bin");
    assert.equal(listed.pending[0].size, 4096);

    const tempPath = path.join(server.store.tmpDir, `${id}.upload`);
    await fs.writeFile(tempPath, "payload");
    await server.store.addFromTemp({
      id,
      tempPath,
      originalName: "big.bin",
      mimeType: "application/octet-stream",
      size: 7,
      sha256: sha256(Buffer.from("payload")),
    });

    const after = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(after.pending.length, 0);
    assert.equal(after.files.length, 1);
    assert.equal(after.files[0].id, id);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function waitForFileEvent(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let eventName = null;
      let data = "";
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let splitAt;
        while ((splitAt = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          eventName = null;
          data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (eventName === "files" && data) {
            req.destroy();
            resolve(JSON.parse(data));
            return;
          }
        }
      });
    });
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("Timed out waiting for file event"));
    });
    req.on("error", reject);
  });
}

async function waitForDownloads(base, id, expected) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const listed = await fetch(new URL("api/files", base));
    const body = await listed.json();
    const file = body.files.find((entry) => entry.id === id);
    if ((file?.downloads || 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${expected} downloads`);
}
