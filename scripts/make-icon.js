"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = path.join(root, "icon.ico");
const assetsDir = path.join(root, "assets");
const publicDir = path.join(root, "src", "renderer", "public");

if (!fs.existsSync(source)) {
  throw new Error("Expected icon.ico in the project root.");
}

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.copyFileSync(source, path.join(assetsDir, "icon.ico"));
fs.copyFileSync(source, path.join(publicDir, "icon.ico"));

console.log("Icon copied to assets/icon.ico and src/renderer/public/icon.ico");

