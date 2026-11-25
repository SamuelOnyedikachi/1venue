#!/usr/bin/env node
'use strict';
/** Check that named ESM imports in public/js resolve to an export in the target file. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_ROOT = path.join(ROOT, 'public', 'js');

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function bindingNames(chunk) {
  const names = [];
  let i = 0, depth = 0, token = '';
  const flush = () => {
    const m = token.trim().match(/^(?:async\s+)?([A-Za-z_$][\w$]*)/);
    if (m) names.push(m[1]);
    token = '';
  };
  while (i < chunk.length) {
    const c = chunk[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < chunk.length) {
        if (chunk[i] === '\\') { i += 2; continue; }
        if (chunk[i] === q) { i++; break; }
        if (q === '`' && chunk[i] === '$' && chunk[i + 1] === '{') { depth++; i += 2; break; }
        i++;
      }
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { depth++; token = ''; i++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth = Math.max(0, depth - 1); token = ''; i++; continue; }
    if (depth === 0 && c === ',') { flush(); i++; continue; }
    if (depth === 0 && c === '=') { flush(); i++; continue; }
    if (depth === 0) token += c;
    i++;
  }
  flush();
  return names.filter(Boolean);
}

function namedExports(src, file, cache, stack) {
  const names = new Set();
  const starFrom = [];
  const reDecl = /\bexport\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = reDecl.exec(src))) names.add(m[1]);
  const reVars = /\bexport\s+(?:const|let|var)\s+/g;
  while ((m = reVars.exec(src))) {
    const start = m.index + m[0].length;
    let end = start, depth = 0, q = null;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === ';' || c === '\n') && src.slice(start, i).includes('=')) { end = i; break; }
      end = i + 1;
    }
    for (const n of bindingNames(src.slice(start, end))) names.add(n);
  }
  const reList = /\bexport\s*\{([^}]+)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
  while ((m = reList.exec(src))) {
    for (const part of m[1].split(',')) {
      const bits = part.trim();
      if (!bits) continue;
      const sides = bits.split(/\s+as\s+/);
      names.add((sides[1] || sides[0]).trim());
    }
    if (m[2]) starFrom.push(m[2]);
  }
  const reStar = /\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reStar.exec(src))) starFrom.push(m[1]);
  for (const spec of starFrom) {
    const target = resolve(file, spec);
    if (!target) continue;
    for (const n of exportsOf(target, cache, stack)) names.add(n);
  }
  return names;
}

function resolve(fromFile, spec) {
  const candidates = [];
  if (spec.startsWith('/features/')) {
    const rest = spec.slice('/features/'.length); // tts/readout.js
    const parts = rest.split('/');
    const id = parts[0];
    const file = parts.slice(1).join('/');
    candidates.push(path.join(ROOT, 'src', 'features', id, 'client', file));
    candidates.push(path.join(ROOT, 'public', 'features', rest));
  } else if (spec.startsWith('/')) {
    candidates.push(path.join(ROOT, 'public', spec.replace(/^\//, '')));
  } else if (spec.startsWith('.')) {
    candidates.push(path.resolve(path.dirname(fromFile), spec));
  } else {
    return null;
  }
  const all = [];
  for (const base of candidates) {
    all.push(base);
    if (!base.endsWith('.js')) all.push(base + '.js', path.join(base, 'index.js'));
  }
  return all.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}

function exportsOf(file, cache = new Map(), stack = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (stack.has(file)) return new Set();
  stack.add(file);
  const names = namedExports(fs.readFileSync(file, 'utf8'), file, cache, stack);
  stack.delete(file);
  cache.set(file, names);
  return names;
}

function namedImports(src) {
  const out = [];
  const re = /\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(',')) {
      let bits = part.trim();
      if (!bits) continue;
      bits = bits.replace(/^type\s+/, '');
      const imported = bits.split(/\s+as\s+/)[0].trim();
      if (imported) out.push({ name: imported, from: m[2] });
    }
  }
  return out;
}

function main() {
  const files = walk(JS_ROOT);
  const cache = new Map();
  const missing = [];
  const unresolved = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const imp of namedImports(src)) {
      if (!imp.from.startsWith('.') && !imp.from.startsWith('/')) continue;
      const target = resolve(file, imp.from);
      if (!target) {
        unresolved.push({ file, name: imp.name, from: imp.from });
        continue;
      }
      const exported = exportsOf(target, cache);
      if (!exported.has(imp.name)) missing.push({ file, name: imp.name, from: imp.from, target });
    }
  }
  const rel = (f) => path.relative(ROOT, f);
  if (unresolved.length || missing.length) {
    for (const x of missing) console.error(`missing export ${x.name} from ${x.from} (imported by ${rel(x.file)})`);
    for (const x of unresolved) console.error(`unresolved module ${x.from} (imported by ${rel(x.file)}, name ${x.name})`);
    process.exit(1);
  }
  console.log('check:esm-exports ok (' + files.length + ' files)');
}

module.exports = { namedExports, namedImports, resolve, bindingNames };
if (require.main === module) main();
