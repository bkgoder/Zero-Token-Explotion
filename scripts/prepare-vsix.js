#!/usr/bin/env node

// Prepare VSIX packaging — verifies required files are present
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");

// Verify dist files were built
const required = [
  path.join(rootDir, "dist", "extension.js"),
  path.join(rootDir, "dist", "bootstrap.js"),
  path.join(rootDir, "dist", "sql-wasm.wasm"),
];

let missing = false;
for (const file of required) {
  if (!fs.existsSync(file)) {
    console.error(`Missing required file: ${file}`);
    missing = true;
  }
}

if (missing) {
  console.error("Run 'npm run build' first.");
  process.exit(1);
}

console.log("VSIX preparation complete — all required dist files present.");
