/*
 * Headless test for the comparison notebook (compare.html / th2000-compare.html).
 *
 * Drives the real page in jsdom: loads a file on each side, checks the byte
 * table, records observations, and verifies the exported log.
 *
 * Run: PAGE=th2000-compare.html node compare.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = process.env.WEB_DIR || '/home/claude/ham/web';
const PAGE = process.env.PAGE || 'compare.html';
const T = require(path.join(WEB, 'th2000-core.js'));

let pass = 0;
const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail.push(n); console.log('  FAIL ' + n + (d ? '  ->  ' + d : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const end = Date.now() + (ms || 4000);
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  throw new Error('timed out waiting for ' + what);
}

function loadPage() {
  const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};
  w.confirm = () => true;
  if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
    w.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
  }
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (m[1].trim()) w.eval(m[1]);
  }
  return { w, doc: w.document };
}

const $ = (doc, id) => doc.getElementById(id);
const txt = (doc, id) => $(doc, id).textContent.trim();

/* Give the page a file the way a drop would. */
function drop(w, doc, elId, name, content) {
  const f = new w.File([content], name, { type: 'text/plain' });
  const ev = new w.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [f] } });
  $(doc, elId).dispatchEvent(ev);
}

function icfWith(mutate) {
  const base = T.icfParse(fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
  const cp = new T.Codeplug(base.bytes);
  mutate(cp);
  return T.icfSerialize(cp.data, base.header);
}

(async () => {
  console.log('comparison notebook: ' + PAGE + '\n');
  const { w, doc } = loadPage();

  console.log('start state');
  ok('nothing recorded yet', /no observations/i.test(txt(doc, 'count')));
  ok('export is disabled', $(doc, 'btnExport').disabled);
  ok('the baseline side says it is never written to',
    /never written to|Nothing is ever written/i.test(txt(doc, 'dropA')), txt(doc, 'dropA'));

  console.log('\nloading files by drag and drop');
  const baseline = fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1');
  // one settings byte changed, as if a single option had been altered
  const changed = icfWith((cp) => { cp.data[0x2026] = (cp.data[0x2026] & ~0xE0) | 0x60; });

  drop(w, doc, 'dropA', 'ORIGIN_BACKUP_ConFile.icf', baseline);
  await until(() => /ORIGIN_BACKUP/.test(txt(doc, 'dropA')), 4000, 'left pane');
  ok('the left pane names the file', /ORIGIN_BACKUP_ConFile\.icf/.test(txt(doc, 'dropA')));
  ok('and summarises it', /TH-2000/.test(txt(doc, 'dropA')) && /1 in use/.test(txt(doc, 'dropA')), txt(doc, 'dropA'));
  ok('one file alone is not a comparison', /Load a file on each side/.test(txt(doc, 'emptyMsg')));

  drop(w, doc, 'dropB', 'sql-3.icf', changed);
  await until(() => $(doc, 'rows').children.length > 0, 4000, 'diff table');

  console.log('\nthe difference table');
  eq('one byte differs', $(doc, 'rows').children.length, 1);
  const row = $(doc, 'rows').children[0].textContent;
  ok('the address is shown', /0x2026/.test(row), row);
  ok('the settings offset is shown', /\+6/.test(row), row);
  ok('the region is named', /global settings/.test(row), row);
  ok('binary before and after', /[01]{4} [01]{4}/.test(row), row);
  // only the bits that actually moved: 0 -> 3 leaves the top bit of a 3-bit
  // field alone, so this reads 5-6 rather than the field's full width
  ok('the bits that moved are named', /bits 5-6/.test(row), row);
  ok('and the value those bits hold', /0 → 3|0 -> 3/.test(row), row);
  ok('channel bytes are hidden by default', $(doc, 'chkSkipCh').checked);

  console.log('\nrecording an observation');
  ok('record is blocked until described', $(doc, 'btnRecord').disabled);
  $(doc, 'what').value = 'Squelch level 0 to 3';
  $(doc, 'what').dispatchEvent(new w.Event('input'));
  ok('record enables once there is a description', !$(doc, 'btnRecord').disabled);
  $(doc, 'btnRecord').click();
  eq('the log has one entry', $(doc, 'logList').children.length, 1);
  ok('the entry names the change', /Squelch level 0 to 3/.test(txt(doc, 'logList')));
  ok('and both filenames', /ORIGIN_BACKUP_ConFile\.icf/.test(txt(doc, 'logList'))
    && /sql-3\.icf/.test(txt(doc, 'logList')));
  ok('the description box is cleared for the next one', $(doc, 'what').value === '');
  ok('export is now available', !$(doc, 'btnExport').disabled);
  ok('and it warns about losing the log', $(doc, 'unsaved').style.display !== 'none');

  console.log('\nchaining to the next setting');
  $(doc, 'btnPromote').click();
  ok('the changed file becomes the baseline', /sql-3\.icf/.test(txt(doc, 'dropA')));
  ok('and the right side is cleared', !/\.icf/.test(txt(doc, 'dropB')), txt(doc, 'dropB'));

  const changed2 = icfWith((cp) => {
    cp.data[0x2026] = (cp.data[0x2026] & ~0xE0) | 0x60;
    cp.data[0x2031] = cp.data[0x2031] ^ 0x02;
  });
  drop(w, doc, 'dropB', 'tot-60.icf', changed2);
  await until(() => $(doc, 'rows').children.length > 0, 4000, 'second diff');
  eq('only the new change shows', $(doc, 'rows').children.length, 1);
  ok('at the new address', /0x2031/.test($(doc, 'rows').children[0].textContent));
  $(doc, 'what').value = 'TOT off to 60 seconds';
  $(doc, 'what').dispatchEvent(new w.Event('input'));
  $(doc, 'btnRecord').click();
  eq('two observations now', $(doc, 'logList').children.length, 2);

  console.log('\nticking individual rows');
  const changed3 = icfWith((cp) => {
    cp.data[0x2026] = (cp.data[0x2026] & ~0xE0) | 0x60;
    cp.data[0x2031] = cp.data[0x2031] ^ 0x02;
    cp.data[0x2034] = 0x11; cp.data[0x2035] = 0x22;
  });
  $(doc, 'btnPromote').click();
  drop(w, doc, 'dropB', 'two-bytes.icf', changed3);
  await until(() => $(doc, 'rows').children.length === 2, 4000, 'third diff');
  $(doc, 'chkOnlyPicked').checked = true;
  $(doc, 'chkOnlyPicked').dispatchEvent(new w.Event('change'));
  $(doc, 'btnNone').click();
  ok('with nothing ticked, recording is blocked', $(doc, 'btnRecord').disabled);
  $(doc, 'rows').children[0].click();
  $(doc, 'what').value = 'Only the first byte';
  $(doc, 'what').dispatchEvent(new w.Event('input'));
  ok('ticking one row allows recording', !$(doc, 'btnRecord').disabled);
  $(doc, 'btnRecord').click();
  const last = $(doc, 'logList').children[2].textContent;
  ok('only the ticked byte was recorded', /1 byte/.test(last), last.slice(0, 120));

  console.log('\nexport');
  let captured = null;
  w.Blob = class { constructor(parts) { captured = parts[0]; } };
  $(doc, 'btnExport').click();
  ok('a text log is produced', typeof captured === 'string');
  ok('it has a header', /TH-2000 codeplug mapping log/.test(captured));
  ok('it counts the observations', /3 observations/.test(captured), captured.slice(0, 120));
  ok('each change is titled', /=== 1\. Squelch level 0 to 3 ===/.test(captured));
  ok('filenames are recorded', /baseline : ORIGIN_BACKUP_ConFile\.icf/.test(captured));
  ok('the byte table is included', /0x2026 \+6/.test(captured), (captured.match(/0x2026[^\n]*/) || [''])[0]);
  ok('bits and values are in the table', /bits 5-6\s+0 -> 3/.test(captured),
    (captured.match(/0x2026[^\n]*/) || [''])[0]);
  ok('a machine readable block is appended', /--- machine readable ---/.test(captured));
  const json = JSON.parse(captured.slice(captured.indexOf('--- machine readable ---') + 24));
  eq('the json has every observation', json.length, 3);
  eq('and the right address', json[0].rows[0].addr, 0x2026);
  eq('and the decoded field values', [json[0].rows[0].from_val, json[0].rows[0].to_val], [0, 3]);

  console.log('\nremoving an entry');
  doc.querySelector('[data-rm="1"]').click();
  eq('the log shrinks', $(doc, 'logList').children.length, 2);
  ok('and the count follows', /2 observations/.test(txt(doc, 'count')));

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nharness error:', e); process.exit(2); });
