const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COOKIE_DIR = process.env.COOKIE_DIR || "./cookies";

function cookiePath(token) {
  // Hash rather than slice the raw token — two tokens sharing the same
  // first N characters (plausible given common token-format prefixes)
  // would otherwise silently overwrite each other's saved cookies.
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  return path.join(COOKIE_DIR, `${hash}.json`);
}

function loadCookies(token) {
  try {
    const p = cookiePath(token);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {}
  return null;
}

function saveCookies(token, cookies) {
  try {
    if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR, { recursive: true });
    fs.writeFileSync(cookiePath(token), JSON.stringify(cookies, null, 2));
  } catch (err) {
    console.error(`[cookies] Failed to save: ${err.message}`);
  }
}

function clearCookies(token) {
  try {
    const p = cookiePath(token);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {}
}

module.exports = { cookiePath, loadCookies, saveCookies, clearCookies };
