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

test("web share target uploads shared files and returns to the app", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-share-target-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48040 });
  try {
    const nav = await fetch(new URL("share-target", server.localUrl), { redirect: "manual" });
    assert.equal(nav.status, 302);
    assert.equal(nav.headers.get("location"), "/drop/");

    const head = await fetch(new URL("share-target", server.localUrl), { method: "HEAD", redirect: "manual" });
    assert.equal(head.status, 302);
    assert.equal(head.headers.get("location"), "/drop/");

    const form = new FormData();
    form.append("files", new Blob(["shared"], { type: "text/plain" }), "shared.txt");

    const upload = await fetch(new URL("share-target", server.localUrl), {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    assert.equal(upload.status, 303);
    assert.equal(upload.headers.get("location"), "/drop/");

    const listed = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, "shared.txt");
    assert.equal(listed.files[0].size, 6);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web share target redirects back to the app when storage rejects an upload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-share-target-error-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48045 });
  try {
    server.store.addFromTemp = async () => {
      throw new Error("disk full");
    };

    const form = new FormData();
    form.append("files", new Blob(["shared"], { type: "text/plain" }), "shared.txt");

    const upload = await fetch(new URL("share-target", server.localUrl), {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    assert.equal(upload.status, 303);
    assert.equal(upload.headers.get("location"), "/drop/");

    const listed = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(listed.files.length, 0);
    assert.equal(listed.pending.length, 0);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web share target preserves text-only shares in the server fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-share-target-text-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48046 });
  try {
    const form = new FormData();
    form.append("title", "Example: Link");
    form.append("url", "https://example.com/page");
    form.append("text", "A useful reference");

    const upload = await fetch(new URL("share-target", server.localUrl), {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    assert.equal(upload.status, 303);
    assert.equal(upload.headers.get("location"), "/drop/");

    const listed = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].name, "Example_ Link.txt");
    assert.equal(listed.files[0].mimeType, "text/plain");

    const download = await fetch(new URL(`api/files/${listed.files[0].id}/download`, server.localUrl));
    assert.equal(await download.text(), "Example: Link\n\nhttps://example.com/page\n\nA useful reference\n");
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

test("cancelled in-flight uploads clear placeholders and reject stale retries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-cancel-upload-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48010 });
  try {
    const id = "44444444-4444-4444-8444-444444444444";
    server.store.addPendingUpload({ id, name: "stuck.txt", size: 2 });

    const before = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(before.pending.length, 1);

    const cancelled = await fetch(new URL(`api/uploads/${id}`, server.localUrl), { method: "DELETE" });
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json();
    assert.equal(cancelledBody.cancelled, true);

    const afterCancel = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(afterCancel.pending.length, 0);
    assert.equal(afterCancel.deletedUploads.includes(id), true);

    const staleRetry = await fetch(new URL("api/files/raw", server.localUrl), {
      method: "POST",
      body: new Blob(["stale"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("stuck.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": id,
      },
    });
    assert.equal(staleRetry.status, 200);
    const staleRetryBody = await staleRetry.json();
    assert.equal(staleRetryBody.deleted, true);
    assert.equal(staleRetryBody.files.length, 0);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup removes stale upload temp files from previous instances", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-temp-cleanup-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  const tmpDir = path.join(dataDir, "tmp");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");
  await fs.writeFile(path.join(tmpDir, "stale.upload"), "partial");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48011 });
  try {
    const entries = await fs.readdir(tmpDir);
    assert.deepEqual(entries, []);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleted uploads are not recreated by stale queued retries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-deleted-retry-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  let server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48020 });
  try {
    const id = "55555555-5555-4555-8555-555555555555";
    const upload = await fetch(new URL("api/files/raw", server.localUrl), {
      method: "POST",
      body: new Blob(["original"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("retry.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": id,
      },
    });
    assert.equal(upload.status, 201);

    const deleted = await fetch(new URL(`api/files/${id}`, server.localUrl), { method: "DELETE" });
    assert.equal(deleted.status, 200);

    const staleRetry = await fetch(new URL("api/files/raw", server.localUrl), {
      method: "POST",
      body: new Blob(["stale retry"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("retry.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": id,
      },
    });
    assert.equal(staleRetry.status, 200);
    const staleRetryBody = await staleRetry.json();
    assert.equal(staleRetryBody.deleted, true);
    assert.equal(staleRetryBody.files.length, 0);

    const afterRetry = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(afterRetry.files.length, 0);
    assert.equal(afterRetry.pending.length, 0);
    assert.equal(afterRetry.deletedUploads.includes(id), true);

    await server.close();
    server = null;
    server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48020 });

    const staleRetryAfterRestart = await fetch(new URL("api/files/raw", server.localUrl), {
      method: "POST",
      body: new Blob(["stale retry after restart"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("retry.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": id,
      },
    });
    assert.equal(staleRetryAfterRestart.status, 200);
    const staleRetryAfterRestartBody = await staleRetryAfterRestart.json();
    assert.equal(staleRetryAfterRestartBody.deleted, true);
    assert.equal(staleRetryAfterRestartBody.files.length, 0);

    const afterRestartRetry = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(afterRestartRetry.files.length, 0);
    assert.equal(afterRestartRetry.pending.length, 0);
    assert.equal(afterRestartRetry.deletedUploads.includes(id), true);
  } finally {
    await server?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleting a file clears matching in-flight upload placeholders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-delete-pending-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48030 });
  try {
    const id = "66666666-6666-4666-8666-666666666666";
    const upload = await fetch(new URL("api/files/raw", server.localUrl), {
      method: "POST",
      body: new Blob(["done"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("done.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": id,
      },
    });
    assert.equal(upload.status, 201);

    server.store.addPendingUpload({ id, name: "done.txt", size: 4096 });
    const beforeDelete = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(beforeDelete.files.length, 1);
    assert.equal(beforeDelete.pending.length, 1);

    const deleted = await fetch(new URL(`api/files/${id}`, server.localUrl), { method: "DELETE" });
    assert.equal(deleted.status, 200);

    const afterDelete = await (await fetch(new URL("api/files", server.localUrl))).json();
    assert.equal(afterDelete.files.length, 0);
    assert.equal(afterDelete.pending.length, 0);
    assert.equal(afterDelete.deletedUploads.includes(id), true);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bulk upload folders group files, rename, download as zip, and delete children", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-folder-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 48010 });
  try {
    const base = server.localUrl;
    const created = await fetch(new URL("api/folders", base), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.folder.kind, "folder");
    assert.equal(createdBody.folder.name, "Folder1");
    assert.equal(createdBody.folder.itemCount, 0);
    const folderId = createdBody.folder.id;

    for (const [id, name, body] of [
      ["33333333-3333-4333-8333-333333333333", "one.txt", "one"],
      ["44444444-4444-4444-8444-444444444444", "two.txt", "two"],
    ]) {
      const upload = await fetch(new URL("api/files/raw", base), {
        method: "POST",
        body: new Blob([body], { type: "text/plain" }),
        headers: {
          "Content-Type": "text/plain",
          "X-WaterDrop-File-Name": encodeURIComponent(name),
          "X-WaterDrop-Mime-Type": "text/plain",
          "X-WaterDrop-Upload-Id": id,
          "X-WaterDrop-Folder-Id": folderId,
        },
      });
      assert.equal(upload.status, 201);
    }

    const listed = await (await fetch(new URL("api/files", base))).json();
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0].kind, "folder");
    assert.equal(listed.files[0].itemCount, 2);
    assert.equal(listed.files[0].size, 6);
    assert.deepEqual(listed.files[0].files.map((file) => file.name), ["one.txt", "two.txt"]);

    const renamed = await fetch(new URL(`api/folders/${folderId}`, base), {
      method: "PATCH",
      body: JSON.stringify({ name: "Trip Photos" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(renamed.status, 200);
    const renamedBody = await renamed.json();
    assert.equal(renamedBody.folder.name, "Trip Photos");

    const zip = await fetch(new URL(`api/files/${folderId}/download`, base));
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get("content-type"), "application/zip");
    assert.match(zip.headers.get("content-disposition"), /^attachment; filename="Trip Photos\.zip"/);
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
    assert.equal(zipBytes.includes(Buffer.from("one.txt")), true);
    assert.equal(zipBytes.includes(Buffer.from("two.txt")), true);
    await waitForDownloads(base, folderId, 1);

    const savedZip = await server.store.copyToDownloadDir(folderId);
    assert.equal(path.basename(savedZip), "Trip Photos.zip");
    const savedZipBytes = await fs.readFile(savedZip);
    assert.equal(savedZipBytes.readUInt32LE(0), 0x04034b50);

    const deleted = await fetch(new URL(`api/files/${folderId}`, base), { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const afterDelete = await (await fetch(new URL("api/files", base))).json();
    assert.equal(afterDelete.files.length, 0);
    assert.equal(server.store.files.length, 0);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("assembles a parallel chunked upload into byte-identical bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-chunk-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47960 });
  try {
    const base = server.localUrl;
    const payload = crypto.randomBytes(200000);
    const expectedHash = sha256(payload);
    const id = "33333333-3333-4333-8333-333333333333";
    const chunkSize = 16384;

    const offsets = [];
    for (let start = 0; start < payload.length; start += chunkSize) offsets.push(start);

    const sendChunk = (start) => {
      const end = Math.min(payload.length, start + chunkSize);
      return fetch(new URL("api/files/raw", base), {
        method: "POST",
        body: payload.subarray(start, end),
        headers: {
          "Content-Type": "application/octet-stream",
          "X-WaterDrop-File-Name": encodeURIComponent("blob.bin"),
          "X-WaterDrop-Mime-Type": "application/octet-stream",
          "X-WaterDrop-Upload-Id": id,
          "X-WaterDrop-Chunk-Offset": String(start),
          "X-WaterDrop-Total-Size": String(payload.length),
        },
      });
    };

    // Upload out of order and concurrently, exactly like the parallel client.
    const responses = await Promise.all([...offsets].reverse().map(sendChunk));
    // A retried chunk after completion must resolve as a duplicate, not corrupt.
    const retry = await (await sendChunk(offsets[0])).json();
    assert.equal(retry.duplicate, true);

    const finals = [];
    for (const res of responses) {
      const body = await res.json();
      if (res.status === 201 && body.files) finals.push(body.files[0]);
    }
    assert.equal(finals.length, 1);
    assert.equal(finals[0].id, id);
    assert.equal(finals[0].size, payload.length);
    assert.equal(finals[0].sha256, expectedHash);

    const download = await fetch(new URL(`api/files/${id}/download`, base));
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, payload.length);
    assert.equal(sha256(bytes), expectedHash);
    assert.equal(bytes.equals(payload), true);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("no-count range requests keep an accelerated download as one download", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-nocount-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47970 });
  try {
    const base = server.localUrl;
    const id = "44444444-4444-4444-8444-444444444444";
    const upload = await fetch(new URL("api/files/raw", base), {
      method: "POST",
      body: new Blob(["hello-range"]),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("r.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
        "X-WaterDrop-Upload-Id": id,
      },
    });
    assert.equal(upload.status, 201);

    // Suppressed range parts (every part but the first of an accelerated download).
    const suppressed = await fetch(new URL(`api/files/${id}/download`, base), {
      headers: { Range: "bytes=0-1", "X-WaterDrop-No-Count": "1" },
    });
    assert.equal(suppressed.status, 206);
    // The one counted part.
    const counted = await fetch(new URL(`api/files/${id}/download`, base), {
      headers: { Range: "bytes=2-3" },
    });
    assert.equal(counted.status, 206);

    await waitForDownloads(base, id, 1);
    const listed = await (await fetch(new URL("api/files", base))).json();
    const file = listed.files.find((entry) => entry.id === id);
    assert.equal(file.downloads, 1);
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

test("renames files, honors retention settings, and answers 304 for matching ETags", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waterdrop-test-"));
  const rendererDir = path.join(root, "renderer");
  const dataDir = path.join(root, "data");
  const downloads = path.join(root, "downloads");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>WaterDrop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47990 });
  try {
    const base = server.localUrl;

    server.store.settings.retentionDays = 1;
    const before = Date.now();
    const upload = await fetch(new URL("api/files/raw", base), {
      method: "POST",
      body: new Blob(["retention"], { type: "text/plain" }),
      headers: {
        "Content-Type": "text/plain",
        "X-WaterDrop-File-Name": encodeURIComponent("keepme.txt"),
        "X-WaterDrop-Mime-Type": "text/plain",
      },
    });
    assert.equal(upload.status, 201);
    const uploaded = (await upload.json()).files[0];
    const oneDay = 24 * 60 * 60 * 1000;
    assert.ok(uploaded.expiresAt >= before + oneDay - 1000);
    assert.ok(uploaded.expiresAt <= Date.now() + oneDay + 1000);

    const info = await fetch(new URL("api/info", base));
    assert.equal((await info.json()).retentionDays, 1);

    const renamed = await fetch(new URL(`api/files/${uploaded.id}`, base), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed.txt" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).file.name, "renamed.txt");

    const missingRename = await fetch(new URL("api/files/33333333-3333-4333-8333-333333333333", base), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope.txt" }),
    });
    assert.equal(missingRename.status, 404);

    const preview = await fetch(new URL(`api/files/${uploaded.id}/preview`, base));
    assert.equal(preview.status, 200);
    const etag = preview.headers.get("etag");
    assert.ok(etag);
    await preview.arrayBuffer();

    const cached = await fetch(new URL(`api/files/${uploaded.id}/preview`, base), {
      headers: { "If-None-Match": etag },
    });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);

    const files = await fetch(new URL("api/files", base));
    assert.equal((await files.json()).files[0].downloads, 0);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
