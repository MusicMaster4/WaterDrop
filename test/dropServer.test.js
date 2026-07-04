"use strict";

const assert = require("node:assert/strict");
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
  await fs.writeFile(path.join(rendererDir, "index.html"), "<!doctype html><title>Water Drop</title>");

  const server = await createDropServer({ dataDir, defaultDownloadDir: downloads, rendererDir, port: 47950 });
  try {
    const base = server.localUrl;
    const form = new FormData();
    form.append("files", new Blob(["abcdef"]), "sample.txt");

    const upload = await fetch(new URL("api/files", base), { method: "POST", body: form });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json();
    assert.equal(uploadBody.files.length, 1);
    assert.equal(uploadBody.files[0].name, "sample.txt");

    const listed = await fetch(new URL("api/files", base));
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.files.length, 1);

    const strippedListed = await fetch(`http://127.0.0.1:${server.port}/api/files`);
    assert.equal(strippedListed.status, 200);
    const strippedBody = await strippedListed.json();
    assert.equal(strippedBody.files.length, 1);

    const strippedStatic = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(strippedStatic.status, 200);

    const id = listedBody.files[0].id;
    const preview = await fetch(new URL(`api/files/${id}/preview`, base));
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-disposition"), 'inline; filename="sample.txt"');
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
