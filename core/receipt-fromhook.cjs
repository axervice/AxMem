#!/usr/bin/env node
// AskUserQuestion -> receipt, with REAL JSON parsing and blob fidelity.
// (The regex predecessor truncated on nested braces and silently dropped the
// tail of long answers — the highest-value receipts lost their endings.)
'use strict';
const fs = require('fs');
const RDIR = (process.env.AXMEM_RECEIPTS_DIR_RESOLVED || '').replace(/\\/g, '/');
const MACH = process.env.AXMEM_RECEIPT_MACH || 'unknown';
if (!RDIR) process.exit(0);

let data = {};
try { data = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const ans = (data.tool_response && data.tool_response.answers)
         || (data.tool_input && data.tool_input.answers) || null;
if (!ans || typeof ans !== 'object' || Object.keys(ans).length === 0) process.exit(0);

const sid = String(data.session_id || ('manual-' + MACH)).replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) || ('manual-' + MACH);
const id = 'r' + Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 32768);
const raw = JSON.stringify(ans);
let note;
if (raw.length <= 800) note = raw.replace(/[\t\r\n]/g, ' ');
else {
  try { fs.mkdirSync(RDIR + '/blobs', { recursive: true }); fs.writeFileSync(RDIR + '/blobs/' + id + '.json', raw); } catch {}
  note = raw.slice(0, 720).replace(/[\t\r\n]/g, ' ') + ' ...[truncated->blobs/' + id + '.json]';
}
try {
  fs.appendFileSync(RDIR + '/spool-' + sid + '.tsv',
    [id, new Date().toISOString().slice(0, 19), sid, 'user-choice', 'AskUserQuestion', note].join('\t') + '\n');
} catch {}
