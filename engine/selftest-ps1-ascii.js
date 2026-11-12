#!/usr/bin/env node
// Self-test: ensure .ps1 and .cmd files are ASCII-only or start with a UTF-8 BOM.
// This prevents PowerShell 5.1 from misinterpreting non-ASCII bytes as cp1252 characters.

const fs = require('fs');
const path = require('path');

let fail = 0;
const check = (name, ok) => {
  if (ok) { console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
};

const studioDir = path.join(__dirname, '..', 'studio');
const files = [];

// Find all .ps1 and .cmd files under studio/
function scan(dir) {
  for (const e of fs.readdirSync(dir)) {
    const fp = path.join(dir, e);
    const st = fs.statSync(fp);
    if (st.isDirectory()) { if (e !== 'node_modules' && e !== 'app-dist') scan(fp); }
    else if (e.endsWith('.ps1') || e.endsWith('.cmd')) { files.push(fp); }
  }
}
scan(studioDir);

check('found at least one ps1 or cmd file', files.length > 0);

for (const fp of files) {
  const buf = fs.readFileSync(fp);
  const rel = path.relative(process.cwd(), fp);
  // UTF-8 BOM is EF BB BF
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  if (hasBom) {
    check(`${rel}: has UTF-8 BOM (acceptable)`, true);
    continue;
  }
  // Check every byte is ASCII (< 128)
  let badByte = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) { badByte = i; break; }
  }
  if (badByte >= 0) {
    check(`${rel}: ASCII-only or BOM (byte ${badByte} = 0x${buf[badByte].toString(16).padStart(2, '0')})`, false);
  } else {
    check(`${rel}: ASCII-only`, true);
  }
}

if (fail) {
  console.error(`${fail} failed`);
  process.exit(1);
}
console.log('ps1-ascii selftest passed');
