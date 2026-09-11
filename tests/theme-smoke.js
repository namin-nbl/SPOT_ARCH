const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

assert.match(html, /id="theme-toggle"/);
assert.match(html, /id="icon-moon"/);
assert.match(html, /id="icon-sun"/);
assert.match(css, /--brand-blue:\s*#006198/i);
assert.match(css, /--brand-orange:\s*#f38b00/i);
assert.match(css, /:root\[data-theme="dark"\]/);
assert.match(css, /font-family:\s*"Aptos Display"/);
assert.match(app, /localStorage\.setItem\("arch-spot-theme"/);
assert.match(app, /prefers-color-scheme:\s*dark/);

console.log("Niagara light/dark theme smoke test passed.");
