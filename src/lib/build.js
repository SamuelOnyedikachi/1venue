'use strict';
/**
 * Single read of the current app / asset versions (from sw.js and index.html).
 * Also builds the import map that remaps every /js and /features module to ?v=ASSET
 * so a new deploy cannot mix old and new ES modules.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

function readBuild() {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const version = (sw.match(/VERSION\s*=\s*'([^']+)'/) || [])[1] || 'dev';
  const asset = (html.match(/app\.css\?v=(\d+)/) || html.match(/app\.js\?v=(\d+)/) || [])[1] || '0';
  return { version, asset };
}

function walkJs(dir, urlBase, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, urlBase + ent.name + '/', out);
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(urlBase + ent.name);
  }
}

function moduleUrls() {
  const urls = [];
  walkJs(path.join(PUBLIC, 'js'), '/js/', urls);
  urls.push('/features/client.js');
  const featRoot = path.join(ROOT, 'src/features');
  if (fs.existsSync(featRoot)) {
    for (const name of fs.readdirSync(featRoot)) {
      const client = path.join(featRoot, name, 'client');
      if (!fs.existsSync(client) || !fs.statSync(client).isDirectory()) continue;
      for (const file of fs.readdirSync(client)) {
        if (file.endsWith('.js') && !file.startsWith('.')) urls.push(`/features/${name}/${file}`);
      }
    }
  }
  return [...new Set(urls)].sort();
}

function importMapJson() {
  const { asset } = readBuild();
  const imports = {};
  for (const u of moduleUrls()) imports[u] = `${u}?v=${asset}`;
  return { imports };
}

function injectShell(html) {
  const { version, asset } = readBuild();
  const map = JSON.stringify(importMapJson());
  let out = String(html);
  if (/<meta name="app-version"/.test(out)) {
    out = out.replace(/<meta name="app-version"[^>]*>/, `<meta name="app-version" content="${version}" data-asset="${asset}" />`);
  } else {
    out = out.replace(/<meta charset="utf-8"\s*\/?>/, `<meta charset="utf-8" />\n    <meta name="app-version" content="${version}" data-asset="${asset}" />`);
  }
  out = out.replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">${map}</script>`);
  out = out.replace(/\/js\/app\.js\?v=[^"'\s]+/g, `/js/app.js?v=${asset}`);
  out = out.replace(/\/css\/app\.css\?v=[^"'\s]+/g, `/css/app.css?v=${asset}`);
  return out;
}

module.exports = { readBuild, moduleUrls, importMapJson, injectShell };
