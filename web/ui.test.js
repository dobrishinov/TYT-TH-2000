/*
 * Headless test of index.html.
 *
 * Loads the real page in jsdom, injects a fake navigator.serial backed by the
 * same radio simulator used elsewhere, and drives the actual buttons. This
 * exercises the UI wiring, the session state machine, rendering and the
 * validation paths - everything except pixels and a real UART.
 *
 * Run: node ui.test.js   (from a directory with jsdom installed)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = process.env.WEB_DIR || '/home/claude/ham/web';
const PAGE = process.env.PAGE || 'index.html';
const T = require(path.join(WEB, 'th2000-core.js'));

let pass = 0;
const fail = [];
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail.push(n); console.log('  FAIL ' + n + (d ? '  ->  ' + d : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(w));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------- simulated radio + port

function makeFakePort(image, legacy, opts) {
  opts = opts || {};
  const radio = { image: Uint8Array.from(image), mode: null, served: 0, written: 0, signals: null, opened: null };
  let outQueue = [];
  let readResolve = null;

  const push = (bytes) => {
    outQueue.push(bytes);
    if (readResolve) { const r = readResolve; readResolve = null; r(); }
  };

  const reply = (op, pl) => {
    const s = legacy ? T.checksumTwos(pl) : T.checksumAdditive(pl);
    const body = legacy ? Uint8Array.from([...pl, s]) : T.stuff([...pl, s]);
    push(Uint8Array.from([...T.HDR_RX, op, ...body, T.END]));
  };

  const handle = (frame) => {
    const mid = frame.slice(5, frame.length - 1);
    const body = legacy ? mid : T.unstuff(mid);
    const payload = body.slice(0, body.length - 1);
    const sum = legacy ? T.checksumTwos(payload) : T.checksumAdditive(payload);
    if (body[body.length - 1] !== sum) throw new Error('page sent a bad checksum');
    const op = frame[4];
    const rd32 = (o) => (payload[o] << 24 | payload[o + 1] << 16 | payload[o + 2] << 8 | payload[o + 3]) >>> 0;
    const rd16 = (o) => payload[o] << 8 | payload[o + 1];

    if (opts.deaf) return;                               // never answers
    if (op === T.OP.HANDSHAKE) {
      if (opts.wrongModel) return reply(T.OP.HANDSHAKE_ACK, [0x39, 0x38, 0x30, 0x30]);
      return reply(T.OP.HANDSHAKE_ACK, T.MODEL_ID);
    }
    if (op === T.OP.ENTER_READ || op === T.OP.ENTER_WRITE) { radio.mode = op; return reply(T.OP.ACK, []); }
    if (op === T.OP.READ_BLOCK) {
      const a = rd32(0), n = rd16(4);
      radio.served++;
      if (opts.badBlockAt === radio.served) return reply(T.OP.DATA, [...T.be32(a + 32), ...T.be16(n), ...radio.image.subarray(a, a + n)]);
      return reply(T.OP.DATA, [...T.be32(a), ...T.be16(n), ...radio.image.subarray(a, a + n)]);
    }
    if (op === T.OP.DATA) {
      const a = rd32(0), n = rd16(4);
      radio.image.set(payload.subarray(6, 6 + n), a);
      radio.written++;
      if (opts.corruptWrite && radio.written === 3) radio.image[a] ^= 0xFF;
      return reply(T.OP.ACK, []);
    }
    if (op === T.OP.END) { radio.mode = null; return reply(T.OP.ACK, []); }
    throw new Error('unexpected opcode ' + T.hx(op));
  };

  const port = {
    _radio: radio,
    async open(o) { radio.opened = o; },
    async close() {},
    async setSignals(s) { radio.signals = s; },
    readable: {
      getReader() {
        return {
          async read() {
            while (!outQueue.length) {
              await new Promise((r) => { readResolve = r; setTimeout(r, 20); });
              if (port._cancelled) return { done: true };
            }
            return { value: outQueue.shift(), done: false };
          },
          async cancel() { port._cancelled = true; },
          releaseLock() {}
        };
      }
    },
    writable: {
      getWriter() {
        return {
          async write(bytes) {
            // frames arrive whole from the page
            handle(Uint8Array.from(bytes));
          },
          releaseLock() {}
        };
      }
    }
  };
  return port;
}

// ------------------------------------------------------------- page loader

async function loadPage(port) {
  const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://localhost/',
    pretendToBeVisual: true
  });
  const w = dom.window;
  // Provide the API the page feature-detects on, before its script runs
  w.navigator.serial = {
    requestPort: async () => port,
    getPorts: async () => []
  };
  w.confirm = () => true;
  w.URL.createObjectURL = () => 'blob:fake';
  w.URL.revokeObjectURL = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};

  // Works for either build: the two-file index.html (external core plus one
  // inline block) or the generated single-file standalone (core inlined as the
  // first block). Evaluate an external core if referenced, then every inline
  // block in document order.
  if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
    w.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
  }
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (m[1].trim()) w.eval(m[1]);
  }
  CURRENT_DOC = w.document;
  return { dom, w, doc: w.document };
}

const $ = (doc, id) => doc.getElementById(id);
let _doc = null;
const mb0 = () => _doc.getElementById('modalBody');
const mbDir = () => _doc.getElementById('modalBody').querySelector('.dirline');
const txt = (doc, id) => $(doc, id).textContent.trim();

let CURRENT_DOC = null;
/* Write now opens a review modal first. Confirm it. */
async function confirmWrite(doc) {
  await until(() => doc.getElementById('scrim').classList.contains('on'), 15000, 'review modal');
  doc.getElementById('modalOk').click();
  await until(() => !doc.getElementById('scrim').classList.contains('on'), 5000, 'review modal closes');
}

function setFileOnInput(w, doc, id, name, content) {
  const f = new w.File([content], name, { type: 'text/plain' });
  Object.defineProperty(doc.getElementById(id), 'files', { value: [f], configurable: true });
  doc.getElementById(id).dispatchEvent(new w.Event('change'));
}

async function until(fn, ms, what) {
  const end = Date.now() + (ms || 5000);
  while (Date.now() < end) { if (fn()) return true; await sleep(15); }
  let diag = '';
  if (CURRENT_DOC) {
    const g = (id) => { const e = CURRENT_DOC.getElementById(id); return e ? e.textContent.trim() : '?'; };
    diag = '\n        status: ' + g('msg') + '\n        meter : ' + g('meterText')
         + '\n        modal : ' + (CURRENT_DOC.getElementById('scrim').classList.contains('on')
            ? g('modalTitle') : 'closed');
  }
  throw new Error('timed out waiting for ' + (what || 'condition') + diag);
}

// -------------------------------------------------------------------- tests

(async () => {
  const icf = fs.readFileSync(path.join(WEB, 'DefaulFile.icf'), 'latin1');
  const parsed = T.icfParse(icf);
  const image = new T.Codeplug(parsed.bytes).data;

  // ---------------------------------------------------------------- 1. boot
  console.log('\npage boot');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    eq('200 rows rendered', $(doc, 'rows').children.length, 200);
    eq('the plate shows plain capacity before anything is loaded',
      txt(doc, 'plateLine'), 'codeplug \u00b7 200 ch');
    eq('meter has 22 segments', $(doc, 'segs').children.length, 22);
    ok('read is disabled before connecting', $(doc, 'btnRead').disabled);
    ok('write is disabled before connecting', $(doc, 'btnWrite').disabled);
    ok('the empty grid is editable and saveable', !$(doc, 'btnSaveIcf').disabled);

    ok('every channel starts free',
      Array.from($(doc, 'rows').children).every((r) => /free/.test(r.textContent)));
    ok('the editor invites action on a free channel',
      /free/i.test(txt(doc, 'chHint')), txt(doc, 'chHint'));
    ok('no band limits are claimed for a blank codeplug',
      /Read a radio or open a file/.test(txt(doc, 'bandHint')), txt(doc, 'bandHint'));
    ok('serial support is reported', /available/i.test(txt(doc, 'support')));
    ok('no unsupported banner when serial exists', !doc.querySelector('.unsupported'));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ------------------------------------- 1b. writing needs a real source
  console.log('\nwrite is gated on a real codeplug');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    $(doc, 'rows').children[0].click();
    $(doc, 'fRx').value = '145.500';
    $(doc, 'btnApply').click();
    ok('a channel can be built from scratch',
      /145\.50000/.test($(doc, 'rows').children[0].textContent));
    ok('no out-of-band warning without band limits',
      !/outside the band limits/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    ok('write stays disabled for a from-scratch codeplug', $(doc, 'btnWrite').disabled);
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');
    ok('write is enabled once a radio has been read', !$(doc, 'btnWrite').disabled);
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ------------------------------------------------- 2. missing Web Serial
  console.log('\nbrowser without Web Serial');
  {
    const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
    const w = dom.window;
    w.HTMLElement.prototype.scrollIntoView = function () {};
    delete w.navigator.serial;
    if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
      w.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
    }
    for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (m[1].trim()) w.eval(m[1]);
    }
    const doc = w.document;
    ok('an explanation is shown', !!doc.querySelector('.unsupported'));
    ok('it names localhost as the fix', /localhost/.test(doc.querySelector('.unsupported').textContent));
    ok('connect is disabled', $(doc, 'btnConnect').disabled);
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ------------------------------------------------------ 3. read a radio
  console.log('\nread from a simulated radio');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    eq('port opened at 57600 8N1', port._radio.opened,
      { baudRate: 57600, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 8192 });
    eq('RTS and DTR asserted', port._radio.signals,
      { dataTerminalReady: true, requestToSend: true });

    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read to finish');
    eq('all 22 blocks requested', port._radio.served, 22);
    ok('status reports the byte count', /11136 bytes/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('a backup was saved automatically', /Saved a backup as th2000-backup-/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('so no backup reminder is shown', !/No backup saved/.test(txt(doc, 'dirty')), txt(doc, 'dirty'));

    // the decoded table should match the codeplug
    const row1 = $(doc, 'rows').children[0].textContent;
    ok('channel 1 shows 435.30000', /435\.30000/.test(row1), row1);
    eq('the plate counts what was read', txt(doc, 'plateLine'), 'codeplug \u00b7 1 of 200 ch');
    ok('a free channel says so', /free/.test($(doc, 'rows').children[5].textContent));
    // the intro line lives in the settings group now, and only shows when the
    // radio is set to display a character string
    ok('intro line 1 is readable through the core',
      new T.Codeplug(image).introLine(1) === 'UV8800'
      || new T.Codeplug(image).introLine(1) === 'TH-2000',
      new T.Codeplug(image).introLine(1));
    ok('band limits are described', /108\.0000/.test(txt(doc, 'bandHint')), txt(doc, 'bandHint'));
    ok('traffic was logged', /TX/.test(txt(doc, 'log')) && /RX/.test(txt(doc, 'log')));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ----------------------------------------------------- 4. edit + verify
  console.log('\nediting');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');

    // claim a free channel
    $(doc, 'rows').children[6].click();
    eq('selected channel shown', txt(doc, 'chNum'), '7');
    ok('free channel is explained', /free/i.test(txt(doc, 'chHint')), txt(doc, 'chHint'));
    $(doc, 'fName').value = 'PLOVDIV';
    $(doc, 'fRx').value = '145.500';
    $(doc, 'fTx').value = '144.900';
    $(doc, 'fEnc').value = '88.5';
    $(doc, 'fDec').value = 'D023I';
    $(doc, 'fBw').value = '2';
    $(doc, 'fStep').value = '4';
    $(doc, 'fSkip').value = '1';
    $(doc, 'btnApply').click();

    const row = $(doc, 'rows').children[6].textContent;
    ok('name lands in the table', /PLOVDIV/.test(row), row);
    ok('and the plate keeps up as channels are added',
      /2 of 200 ch/.test(txt(doc, 'plateLine')), txt(doc, 'plateLine'));
    ok('receive frequency lands', /145\.50000/.test(row), row);
    ok('shift is computed', /\u22120\.600/.test(row), row);
    ok('encode tone shown', /88\.5/.test(row), row);
    ok('decode tone shown', /D023I/.test(row), row);
    ok('narrow shown', /Narrow/.test(row), row);
    ok('skip shown', /skip/.test(row), row);
    ok('marked unsaved', /Unsaved/.test(txt(doc, 'dirty')), txt(doc, 'dirty'));

    // encode and decode are pickers, so a bad tone cannot be typed at all
    eq('encode is a picker', $(doc, 'fEnc').tagName, 'SELECT');
    eq('decode is a picker', $(doc, 'fDec').tagName, 'SELECT');
    eq('with every valid tone', $(doc, 'fEnc').options.length, T.toneChoices().length);
    ok('grouped for scanning', $(doc, 'fEnc').querySelectorAll('optgroup').length === 3);
    ok('off is the first choice', $(doc, 'fEnc').options[0].value === 'off');

    $(doc, 'fRx').value = '';
    $(doc, 'btnApply').click();
    ok('missing frequency is refused', /required/i.test(txt(doc, 'msg')), txt(doc, 'msg'));
    $(doc, 'fRx').value = '145.500';

    // out of band warning
    $(doc, 'fRx').value = '300.000';
    $(doc, 'fTx').value = '300.000';
    $(doc, 'btnApply').click();
    ok('out-of-band is flagged, not blocked', /outside the band limits/.test(txt(doc, 'msg')), txt(doc, 'msg'));

    // transmit off
    $(doc, 'fRx').value = '145.500';
    $(doc, 'fTx').value = 'off';
    $(doc, 'btnApply').click();
    ok('receive-only renders as rx only', /rx only/.test($(doc, 'rows').children[6].textContent));
    $(doc, 'rows').children[6].click();
    eq('and round-trips into the editor', $(doc, 'fTx').value, 'off');

    // clear
    $(doc, 'btnClear').click();
    ok('cleared channel goes back to free', /free/.test($(doc, 'rows').children[6].textContent));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ---------------------------------------------------- 5. write + verify
  console.log('\nwrite with verification');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');

    $(doc, 'rows').children[9].click();
    $(doc, 'fName').value = 'REPEATER';
    $(doc, 'fRx').value = '145.650';
    $(doc, 'fTx').value = '145.050';
    $(doc, 'btnApply').click();

    // write into a blank radio
    const blank = makeFakePort(new Uint8Array(T.MEM_SIZE), false);
    w.eval('window.__setPort && 0');
    // reconnect against the blank unit
    $(doc, 'btnConnect').click();                    // disconnect
    await until(() => $(doc, 'btnRead').disabled, 3000, 'disconnect');
    w.navigator.serial.requestPort = async () => blank;
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'reconnect');

    $(doc, 'btnWrite').click();
    await confirmWrite(doc);
    await until(() => txt(doc, 'meterText') === 'verified', 25000, 'write+verify');
    eq('22 blocks written', blank._radio.written, 22);
    // compare-before-write reads once to build the diff, verify reads again
    eq('read twice: once to compare, once to verify', blank._radio.served, 44);
    ok('success is reported', /verified/i.test(txt(doc, 'msg')), txt(doc, 'msg'));
    const cpNow = new T.Codeplug(blank._radio.image);
    eq('the edit reached the radio', cpNow.getChannel(9).name, 'REPEATER');
    eq('and its frequency', cpNow.getChannel(9).rxHz, 145650000);
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ------------------------------------------------------ 6. failure paths
  console.log('\nfailure handling');
  {
    // radio that never answers
    const port = makeFakePort(image, false, { deaf: true });
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => /did not answer/.test(txt(doc, 'msg')), 12000, 'timeout message');
    ok('silence is explained in plain terms', /cable|port|on\b/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('the lamp shows failure', /err/.test($(doc, 'lamp').className));
    await until(() => !$(doc, 'btnRead').disabled, 4000, 'read re-enabled');
    ok('read can be retried after a failure', !$(doc, 'btnRead').disabled);
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }
  {
    // radio replying for the wrong address
    const port = makeFakePort(image, false, { badBlockAt: 4 });
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => /when 0x/.test(txt(doc, 'msg')), 12000, 'block mismatch');
    ok('a block mismatch is caught', /sent block/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('remaining segments marked failed',
      Array.from($(doc, 'segs').children).some((s) => /err/.test(s.className)));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }
  {
    // radio that quietly corrupts a block
    const port = makeFakePort(image, false, { corruptWrite: true });
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');
    // make a change, otherwise there is nothing to write and the tool says so
    $(doc, 'rows').children[2].click();
    $(doc, 'fRx').value = '145.700'; $(doc, 'fTx').value = '145.700';
    $(doc, 'btnApply').click();
    $(doc, 'btnWrite').click();
    await confirmWrite(doc);
    await until(() => /Verify failed/.test(txt(doc, 'msg')), 25000, 'verify failure');
    ok('verification catches silent corruption', /reads back as/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }
  {
    // a different model answering the handshake
    const port = makeFakePort(image, false, { wrongModel: true });
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    // the page logs the ident and proceeds; the block loop still works, so
    // just confirm nothing throws and the read completes
    await until(() => txt(doc, 'meterText') === '22 / 22', 10000, 'read from unknown ident');
    ok('an unexpected ident does not crash the read', true);
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // -------------------------------------------------------- 7. legacy mode
  console.log('\nlegacy framing');
  {
    const port = makeFakePort(image, true);
    const { doc, w } = await loadPage(port);
    $(doc, 'chkLegacy').checked = true;
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 10000, 'legacy read');
    eq('legacy read served 22 blocks', port._radio.served, 22);
    ok('channel 1 still decodes', /435\.30000/.test($(doc, 'rows').children[0].textContent));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ----------------------------------------------------------- 8. icf save
  console.log('\nfile output');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');

    let captured = null;
    w.Blob = class { constructor(parts) { captured = parts[0]; } };
    $(doc, 'btnSaveIcf').click();
    ok('an .icf was produced', typeof captured === 'string' && captured.startsWith('COM1'));
    const reparsed = T.icfParse(captured);
    eq('it reparses to the full codeplug', reparsed.coverage, T.MEM_SIZE);
    ok('and matches what was read',
      Array.from(new T.Codeplug(reparsed.bytes).data).every((b, i) => b === image[i]));
    ok('backup reminder clears after saving', !/No backup/.test(txt(doc, 'dirty')), txt(doc, 'dirty'));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ------------------------------------------------------- 9. csv, diff, bulk
  console.log('\ncsv, compare, bulk and checks');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);

    const setFile = (id, name, content) => {
      const f = new w.File([content], name, { type: 'text/plain' });
      Object.defineProperty($(doc, id), 'files', { value: [f], configurable: true });
      $(doc, id).dispatchEvent(new w.Event('change'));
    };
    let captured = [];
    w.Blob = class { constructor(parts) { this.parts = parts; captured.push(parts[0]); } };

    // build a couple of channels
    const mk = (row, name, rx, tx) => {
      $(doc, 'rows').children[row].click();
      $(doc, 'fName').value = name; $(doc, 'fRx').value = rx; $(doc, 'fTx').value = tx;
      $(doc, 'fEnc').value = '88.5'; $(doc, 'fDec').value = 'off';
      $(doc, 'btnApply').click();
    };
    mk(0, 'R70', '145.600', '145.000');
    mk(1, 'SIMPLEX', '145.500', '145.500');

    // --- export
    $(doc, 'btnCsvOut').click();
    const csv = captured[captured.length - 1];
    ok('csv exported with a header', /^Channel,Name,RX MHz/.test(csv), String(csv).slice(0, 40));
    eq('csv has one row per channel', csv.trim().split('\r\n').length - 1, 2);

    // --- import, with errors
    setFile('fileCsv', 'bad.csv', 'Channel,RX MHz\n1,not-a-number\n');
    await until(() => $(doc, 'scrim').classList.contains('on'), 3000, 'error modal');
    ok('bad csv is explained, not applied', /could not be imported/i.test(txt(doc, 'modalTitle')), txt(doc, 'modalTitle'));
    ok('the offending line is named', /line 2/.test(txt(doc, 'modalBody')), txt(doc, 'modalBody').slice(0, 90));
    $(doc, 'modalCancel').click();

    // --- import, good
    setFile('fileCsv', 'good.csv',
      'Channel,Name,RX MHz,TX MHz,Encode,Power,Step kHz\n' +
      '20,IMPORTED,433.500,433.500,D023I,Low,25\n' +
      '21,SECOND,434.000,,off,High,12.5\n');
    await until(() => $(doc, 'scrim').classList.contains('on'), 3000, 'import modal');
    ok('import asks first', /Import 2 channels/.test(txt(doc, 'modalTitle')), txt(doc, 'modalTitle'));
    $(doc, 'modalOk').click();
    await until(() => /Imported 2 channels/.test(txt(doc, 'msg')), 3000, 'import');
    const row20 = $(doc, 'rows').children[19].textContent;
    ok('imported channel lands', /IMPORTED/.test(row20) && /433\.50000/.test(row20), row20);
    ok('imported tone lands', /D023I/.test(row20), row20);
    ok('imported power lands', /Low/.test(row20), row20);

    // --- checks
    $(doc, 'tabChannel').click(); $(doc, 'subChecks').click();
    $(doc, 'btnCheck').click();
    ok('checks run and report', /warning|error|nothing wrong/i.test(txt(doc, 'msg')), txt(doc, 'msg'));

    // --- bulk. The tab defaults to acting on the selected channel, so the
    // range operations need the switch turned off.
    $(doc, 'tabChannel').click(); $(doc, 'subBulk').click();
    $(doc, 'chkSelOnly').checked = false;
    $(doc, 'chkSelOnly').dispatchEvent(new w.Event('change', { bubbles: true }));
    $(doc, 'bFrom').value = '1'; $(doc, 'bTo').value = '21';
    $(doc, 'bField').value = '0'; $(doc, 'bField').dispatchEvent(new w.Event('change'));
    $(doc, 'bValue').value = '2';                       // power = Low
    $(doc, 'btnBulkApply').click();
    ok('bulk apply reports a count', /Set power on \d+ channels/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('bulk apply changed a row', /Low/.test($(doc, 'rows').children[0].textContent));

    $(doc, 'bFind').value = 'IMPORTED'; $(doc, 'bRepl').value = 'RENAMED';
    $(doc, 'btnRename').click();
    ok('find and replace works', /RENAMED/.test($(doc, 'rows').children[19].textContent));

    $(doc, 'btnCompact').click();
    ok('close gaps packs channels', /Packed \d+ channels/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('channel 3 now occupied after packing', !/free/.test($(doc, 'rows').children[2].textContent));

    // --- compare against a file
    // change a few radio settings too, so the comparison has to decode them
    $(doc, 'tabSettings').click();
    $(doc, 'set_light').value = '3';
    $(doc, 'set_light').dispatchEvent(new w.Event('change', { bubbles: true }));
    $(doc, 'set_sql').value = '9';
    $(doc, 'set_sql').dispatchEvent(new w.Event('change', { bubbles: true }));
    $(doc, 'tabFm').click();
    const fm0 = doc.querySelector('[data-fmf="0"]');
    fm0.value = '101.70';
    fm0.dispatchEvent(new w.Event('change', { bubbles: true }));

    setFile('fileCmp', 'other.icf', fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => $(doc, 'scrim').classList.contains('on'), 3000, 'compare modal');
    ok('compare opens a diff', /Compared with other\.icf/.test(txt(doc, 'modalTitle')),
      txt(doc, 'modalTitle'));
    ok('the diff names changed channels', /Channel \d/.test(txt(doc, 'modalBody')), txt(doc, 'modalBody').slice(0, 120));
    const body = txt(doc, 'modalBody');
    ok('it lists radio settings by name', /Radio settings/.test(body), body.slice(0, 200));
    {
      const dir = $(doc, 'modalBody').querySelector('.dirline');
      ok('the comparison states its direction', !!dir);
      ok('naming the file it was compared with',
        /other\.icf/.test(dir.querySelector('.from').textContent), dir.textContent);
      eq('and Current state as the other side',
        dir.querySelector('.to').textContent.trim(), 'Current state');
      ok('the dialogue title says compared, not comparing',
        /^Compared with/.test(txt(doc, 'modalTitle')), txt(doc, 'modalTitle'));
    }
    ok('the comparison leads with the direction, then what changed',
      body.indexOf('other.icf') < body.indexOf('Channel'), body.slice(0, 120));
    ok('and the tally comes after both',
      body.indexOf('Channel') < $(doc, 'modalBody').innerHTML.indexOf('class="summary"')
        ? true
        : $(doc, 'modalBody').innerHTML.indexOf('dirline')
          < $(doc, 'modalBody').innerHTML.indexOf('class="summary"'),
      body.slice(0, 160));
    ok('with readable before and after', /Backlight/.test(body) && /Squelch level/.test(body), body);
    ok('not just raw numbers', /7\s*→\s*3|7\s*->\s*3/.test(body.replace(/\s+/g, ' ')), body);
    ok('and FM changes too', /FM broadcast/.test(body) && /101\.70/.test(body), body);
    // byte-level detail: the tool for mapping unknown settings bytes
    const bytesBlock = doc.querySelector('#modalBody details.bytes');
    ok('the byte table is present but folded away', !!bytesBlock && !bytesBlock.open);
    ok('the outer label counts what it actually shows',
      /Byte level \u2014 \d+ non-channel bytes?/.test(bytesBlock.textContent)
      || /Byte level \u2014 channel bytes only/.test(bytesBlock.textContent),
      bytesBlock.querySelector('summary').textContent);
    const outerN = (bytesBlock.querySelector('summary').textContent.match(/(\d+)/) || [])[1];
    const shown = (bytesBlock.querySelector('#bitDiffText') || { textContent: '' })
      .textContent.split('\n').filter((l) => /^0x/.test(l)).length;
    eq('and the count matches the rows in that table', String(shown), outerN || String(shown));
    const inner = bytesBlock.querySelector('details');
    if (inner) {
      ok('the inner label says it is the whole table',
        /Show all \d+ bytes?, channels included/.test(inner.textContent),
        inner.querySelector('summary').textContent);
      const allRows = inner.querySelector('#bitDiffAll').textContent
        .split('\n').filter((l) => /^0x/.test(l)).length;
      const innerN = Number((inner.querySelector('summary').textContent.match(/(\d+)/) || [])[1]);
      eq('and its count matches its rows', allRows, innerN);
      ok('the full table is a superset', allRows >= shown);
    }
    const bd = $(doc, 'bitDiffText') || $(doc, 'bitDiffAll');
    ok('a byte-level section is shown', !!bd);
    ok('it has an address column', /addr\s+off\s+region/.test(bd.textContent), bd.textContent.slice(0, 80));
    ok('it shows binary before and after', /[01]{4} [01]{4}/.test(bd.textContent));
    ok('and names the bits that moved', /bits? \d/.test(bd.textContent), bd.textContent.slice(0, 200));
    const copyBtn = doc.querySelector('[data-copy]');
    ok('there is a copy button', !!copyBtn);
    if (copyBtn) {
      copyBtn.click();
      ok('copying gives feedback', /Copied|Select/.test(copyBtn.textContent), copyBtn.textContent);
    }
    $(doc, 'modalCancel').click();
    // let the handler finish before the window is torn down
    await until(() => /differ|Identical/.test(txt(doc, 'msg')), 4000, 'compare result');

    // --- print
    w.open = () => null;                                 // force the download path
    $(doc, 'btnPrint').click();
    ok('print produces an html sheet', /<table>/.test(captured[captured.length - 1]));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }

  // ------------------------------------------------ 10. review before writing
  console.log('\nreview before writing');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    w.Blob = class { constructor(parts) { this.parts = parts; } };
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');

    // no edits -> nothing to write
    $(doc, 'btnWrite').click();
    await until(() => $(doc, 'scrim').classList.contains('on'), 12000, 'no-change modal');
    ok('an unchanged codeplug is not written', /Nothing to write/.test(txt(doc, 'modalTitle')), txt(doc, 'modalTitle'));
    $(doc, 'modalCancel').click();
    await until(() => /write skipped/.test(txt(doc, 'msg')), 4000, 'skip message');
    eq('nothing was sent to the radio', port._radio.written, 0);

    // edit an existing channel (a change) and claim an empty one (an addition)
    $(doc, 'rows').children[0].click();
    $(doc, 'fName').value = 'EDITED'; $(doc, 'btnApply').click();
    $(doc, 'rows').children[3].click();
    $(doc, 'fRx').value = '145.700'; $(doc, 'fTx').value = '145.100';
    $(doc, 'fName').value = 'REVIEW'; $(doc, 'btnApply').click();
    $(doc, 'btnWrite').click();
    await until(() => $(doc, 'scrim').classList.contains('on'), 12000, 'review modal');
    const body = txt(doc, 'modalBody');
    ok('the review lists the new channel', /Channel 4/.test(body), body.slice(0, 160));
    ok('and marks it added', /added/.test(body));
    ok('the review lists the edited channel', /Channel 1/.test(body));
    ok('and marks it changed', /changed/.test(body));
    ok('and names the field that changed', /Name/.test(body), body.slice(0, 200));
    ok('and shows a byte count', /\d+\s*bytes/.test(body));
    $(doc, 'modalCancel').click();
    await until(() => /cancelled/i.test(txt(doc, 'msg')), 4000, 'cancel');
    eq('cancelling sends nothing', port._radio.written, 0);
    ok('and the tool is usable again', !$(doc, 'btnWrite').disabled);

    // now confirm. Wait for the tool to finish winding down from the cancel
    // first: while an operation is in flight the buttons are disabled, so a
    // click during that window is silently swallowed.
    await until(() => !$(doc, 'btnWrite').disabled
      && !$(doc, 'scrim').classList.contains('on'), 8000, 'tool idle after cancel');
    $(doc, 'btnWrite').click();
    await until(() => $(doc, 'scrim').classList.contains('on'), 12000, 'review modal 2');
    $(doc, 'modalOk').click();
    await until(() => !$(doc, 'scrim').classList.contains('on'), 5000, 'modal closes on confirm');
    await until(() => txt(doc, 'meterText') === 'verified', 25000, 'write+verify');
    eq('22 blocks written after confirming', port._radio.written, 22);
    const onRadio = new T.Codeplug(port._radio.image);
    eq('the change reached the radio', onRadio.getChannel(3).name, 'REVIEW');
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ------------------------------------------------------ 11. radio settings
  console.log('\nradio settings panel');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);
    w.Blob = class { constructor(p) { this.parts = p; } };
    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'file load');
    $(doc, 'tabSettings').click();

    const panel = $(doc, 'setFields');
    // layout: the container must not be a grid, or the headings land in a
    // column beside the fields instead of spanning the panel
    ok('the intro line appears once, not twice',
      (panel.textContent.match(/Intro screen/g) || []).length <= 1,
      panel.textContent.slice(0, 120));
    ok('no obsolete question-mark legend',
      !/option order has not been checked/.test(doc.body.textContent));
    ok('the settings container is not itself a grid',
      !panel.classList.contains('fields'), panel.className);
    // each group is now a fold: the container holds <details>, and every
    // heading is the summary of one of them
    ok('the container holds one fold per group',
      Array.from(panel.children).every((c) => c.tagName === 'DETAILS'),
      Array.from(panel.children).map((c) => c.tagName).join(','));
    ok('each heading is the summary of its own fold',
      Array.from(panel.querySelectorAll('.subhead')).every(
        (h) => h.tagName === 'SUMMARY' && h.parentElement.classList.contains('grp')));
    eq('one heading per group', panel.querySelectorAll('.subhead').length, T.SETTINGS_GROUPS.length);
    ok('each heading is followed by its own field grid',
      Array.from(panel.querySelectorAll('.subhead')).every(
        (h) => h.nextElementSibling && h.nextElementSibling.classList.contains('fields')));
    ok('every field sits inside a grid, not loose in the container',
      panel.querySelectorAll(':scope > .f').length === 0);

    // each group folds, and only Keys starts open
    {
      const grps = Array.from(panel.querySelectorAll('details.grp'));
      eq('one fold per group', grps.length, T.SETTINGS_GROUPS.length);
      const openNow = grps.filter((d) => d.open).map((d) => d.dataset.grp);
      eq('only Keys is open to begin with', openNow.join(','), 'keys');
      ok('no count badges', !panel.querySelector('.count'));
      ok('the groups use the browser marker, as About does',
        Array.from(doc.querySelectorAll('style')).map((x) => x.textContent).join('')
          .replace(/\s+/g, ' ').includes('summary.subhead{ display:list-item'));
      ok('a folded group still holds its fields',
        $(doc, 'set_sql') !== null && !$(doc, 'set_sql').closest('details.grp').open);
    }

    ok('the groups are shown', /Radio/.test(panel.textContent)
      && /Display and sound/.test(panel.textContent)
      && /Transmit/.test(panel.textContent) && /Keys/.test(panel.textContent)
      && /Security/.test(panel.textContent), panel.textContent.slice(0, 90));

    ok('every control is a dropdown', panel.querySelectorAll('input[type=number]').length === 0);
    const vol = $(doc, 'set_volume');
    eq('volume is a select', vol.tagName, 'SELECT');
    eq('with one option per level', vol.options.length, 32);
    eq('backlight is a select', $(doc, 'set_light').tagName, 'SELECT');
    eq('with seven levels', $(doc, 'set_light').options.length, 7);
    eq('backlight shows the radio value', $(doc, 'set_light').value, '7');

    // the manufacturer's key names are opaque, so each option explains itself
    {
      const sel = $(doc, 'set_p1Short');
      eq('every key function is offered', sel.options.length, T.KEY_FN.length);
      const missing = Array.from(sel.options)
        .filter((o) => (o.getAttribute('title') || '').length < 15)
        .map((o) => o.textContent);
      ok('and each one explains itself', missing.length === 0, missing.join(', '));
      const moni = Array.from(sel.options).find((o) => o.textContent === 'KEY-MONI');
      ok('MONI says it opens the squelch',
        /opens the squelch/.test(moni.getAttribute('title')), moni.getAttribute('title'));
      const rev = Array.from(sel.options).find((o) => o.textContent === 'Frequency Reverse');
      ok('reverse says it swaps transmit and receive',
        /swaps transmit and receive/.test(rev.getAttribute('title')));
      const save = Array.from(sel.options).find((o) => o.textContent === 'KEY-Save');
      ok('and the uncertain one admits it',
        /ambiguous/.test(save.getAttribute('title')), save.getAttribute('title'));
      ok('the field itself names the current choice',
        /Currently KEY-Low/.test(sel.getAttribute('title')), sel.getAttribute('title'));
      // a field that is not a key list gets no per-option tooltips
      ok('other dropdowns are left alone',
        !$(doc, 'set_sql').options[0].getAttribute('title'));
    }

    eq('TX channel is named properly', $(doc, 'set_txChSelect').options[0].textContent, 'Main CH');
    eq('TX tone is named properly', $(doc, 'set_txTone').options[1].textContent, 'END');
    ok('no uncertainty marks remain', !/\?/.test(panel.innerHTML.replace(/<[^>]*>/g, '')));

    // P5 long is the power button: shown, labelled, and not editable
    ok('P5 long has no dropdown', $(doc, 'set_p5Long') === null);
    const p5 = Array.from(panel.querySelectorAll('.f')).find(
      (d) => /P5 long/.test(d.textContent));
    ok('P5 long is present', !!p5);
    ok('and reads Power Button', /Power Button/.test(p5.querySelector('input').value),
      p5.querySelector('input').value);
    ok('and is disabled', p5.querySelector('input').disabled);
    ok('and says it is fixed', /fixed/i.test(p5.textContent), p5.textContent);
    ok('with an explanation on hover', /power button/i.test(p5.getAttribute('title') || ''),
      p5.getAttribute('title'));

    // help text on every control
    const missing = T.SETTINGS_FIELDS.filter((f) => {
      const el = $(doc, 'set_' + f.key);
      const box = el ? el.closest('.f') : null;
      return !(box && (box.getAttribute('title') || '').length > 20);
    }).map((f) => f.key).filter((k) => k !== 'p5Long');
    ok('every setting explains itself on hover', missing.length === 0, missing.join(','));
    ok('scan type spells out To, Co and Se',
      /time operated/i.test($(doc, 'set_scanType').getAttribute('title'))
      && /carrier operated/i.test($(doc, 'set_scanType').getAttribute('title')));
    ok('squelch tail gives the full OEM wording',
      /Eliminate Squelch Tail When No CTC\/DCS Signaling/
        .test($(doc, 'set_sqlTail').getAttribute('title')),
      $(doc, 'set_sqlTail').getAttribute('title'));

    // conditional rows
    ok('intro lines are hidden while intro screen is not Char String',
      $(doc, 'introA') === null);
    $(doc, 'set_introMode').value = '2';
    $(doc, 'set_introMode').dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('choosing Char String reveals both lines',
      $(doc, 'introA') !== null && $(doc, 'introB') !== null);
    eq('line 1 is filled in', $(doc, 'introA').value, 'TH-2000');
    $(doc, 'set_introMode').value = '0';
    $(doc, 'set_introMode').dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('and switching away hides them again', $(doc, 'introA') === null);

    ok('the password box is hidden while the feature is off', $(doc, 'set_pwd') === null);
    $(doc, 'set_pwdEnable').value = '1';
    $(doc, 'set_pwdEnable').dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('turning it on reveals the password box', $(doc, 'set_pwd') !== null);
    eq('prefilled from the radio', $(doc, 'set_pwd').value, '000000');

    // the password takes digits only
    $(doc, 'set_pwd').value = 'ab12cd';
    $(doc, 'set_pwd').dispatchEvent(new w.Event('input', { bubbles: true }));
    eq('letters are stripped as you type', $(doc, 'set_pwd').value, '12');
    $(doc, 'set_pwd').value = '9';
    $(doc, 'set_pwd').dispatchEvent(new w.Event('change', { bubbles: true }));
    eq('and a short code is padded to six', $(doc, 'set_pwd').value, '900000');

    // FM now has its own tab
    $(doc, 'tabFm').click();
    ok('the FM tab shows the presets', $(doc, 'fmList').children.length > 0);
    ok('and the VFO', $(doc, 'fmVfo') !== null);
    ok('FM is no longer on the settings tab',
      !$(doc, 'panSettings').contains($(doc, 'fmList')));
    $(doc, 'tabSettings').click();
    ok('band limits stayed with settings',
      $(doc, 'panSettings').contains($(doc, 'bandHint')));

    // a real edit reaches the bytes
    $(doc, 'set_light').value = '2';
    $(doc, 'set_light').dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('changing backlight is reported', /Backlight set/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    $(doc, 'set_p1Short').value = '13';
    $(doc, 'set_p1Short').dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('changing a key assignment is reported', /P1 short set/.test(txt(doc, 'msg')));
    ok('the codeplug is marked unsaved', /Unsaved/.test(txt(doc, 'dirty')));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // --------------------------------------------------- 12. layout and menus
  console.log('\nnavigation and header menus');
  {
    const port = makeFakePort(image, false);
    const { doc, w } = await loadPage(port);

    // the label uses a non-breaking space so it never wraps mid-name
    // Structure, not just presence. getElementById finds an element however
    // deeply it is buried, so every earlier test passed while four panels were
    // nested inside the first one and therefore invisible.
    const rail = doc.querySelector('.rail');
    const panels = Array.from(doc.querySelectorAll('.tabpanel'));
    eq('five panels', panels.length, 5);
    ok('each panel is a direct child of the rail',
      panels.every((p) => p.parentElement === rail),
      panels.filter((p) => p.parentElement !== rail).map((p) => p.id).join(','));
    ok('no panel contains another',
      panels.every((p) => p.querySelectorAll('.tabpanel').length === 0));
    ok('every tab points at a panel that exists',
      Array.from(doc.querySelectorAll('.tabs button'))
        .every((b) => doc.getElementById(b.dataset.panel)));
    ok('every panel has content',
      panels.every((p) => p.querySelectorAll('section').length > 0),
      panels.filter((p) => !p.querySelectorAll('section').length).map((p) => p.id).join(','));
    // switching tabs really swaps which one is shown
    for (const b of Array.from(doc.querySelectorAll('.tabs button'))) {
      b.click();
      const on = panels.filter((p) => p.classList.contains('on'));
      if (on.length !== 1 || on[0].id !== b.dataset.panel) {
        ok('tab ' + b.textContent.trim() + ' shows its own panel', false,
          on.map((p) => p.id).join(','));
      }
    }
    ok('each tab shows exactly its own panel', true);

    const tabs = Array.from(doc.querySelectorAll('.tabs button'))
      .map((b) => b.textContent.replace(/\u00A0/g, ' ').trim());
    eq('five tabs', tabs.length, 5);
    ok('named for what they hold',
      tabs.join('|') === 'Channels|VFO A/B|FM radio|Radio settings|Options', tabs.join('|'));

    // bulk and checks moved in with the channels
    $(doc, 'tabChannel').click();
    const chan = $(doc, 'panChannel');
    ok('bulk operations live with the channels', chan.contains($(doc, 'btnBulkApply')));
    ok('so do the checks', chan.contains($(doc, 'btnCheck')));

    // bulk edit opens on the selected channel, with the range work put away
    $(doc, 'subBulk').click();
    ok('the switch is on by default', $(doc, 'chkSelOnly').checked);
    ok('so the range boxes are put away', $(doc, 'bulkRangeBoxes').hidden);
    ok('and disabled behind that', $(doc, 'bFrom').disabled);
    ok('and only move, copy and delete are offered',
      $(doc, 'secBulkField').hidden && $(doc, 'secBulkRename').hidden);
    ok('the switch sits above the range boxes',
      $(doc, 'chkSelOnly').compareDocumentPosition($(doc, 'bFrom'))
        & w.Node.DOCUMENT_POSITION_FOLLOWING);
    $(doc, 'subChannel').click();

    // three sub-tabs, each with its own content
    // scoped to this panel: the VFO tab has sub-tabs of its own
    const subs = Array.from(chan.querySelectorAll('.subtabs button')).map((b) => b.textContent.trim());
    eq('sub-tabs', subs.join('|'), 'Channel|Bulk edit|Checks');
    const subPanels = Array.from(chan.querySelectorAll('.subpanel'));
    eq('three sub-panels', subPanels.length, 3);
    ok('each is a direct child of the channels panel',
      subPanels.every((p) => p.parentElement === chan));
    ok('the editor is on the Channel sub-tab',
      $(doc, 'subPanChannel').contains($(doc, 'editor')));
    ok('bulk controls are on the Bulk sub-tab',
      $(doc, 'subPanBulk').contains($(doc, 'btnBulkApply')));
    ok('checks are on the Checks sub-tab',
      $(doc, 'subPanChecks').contains($(doc, 'btnCheck')));
    for (const b of Array.from(chan.querySelectorAll('.subtabs button'))) {
      b.click();
      const on = subPanels.filter((p) => p.classList.contains('on'));
      if (on.length !== 1 || on[0].id !== b.dataset.sub) {
        ok('sub-tab ' + b.textContent.trim() + ' shows its own panel', false, on.map((p) => p.id).join(','));
      }
    }
    ok('each sub-tab shows exactly its own panel', true);

    // the bulk controls explain themselves
    const bulkTips = ['bFrom', 'bTo', 'bField', 'bValue', 'bFind', 'bRepl', 'bDest']
      .filter((id) => {
        const box = $(doc, id).closest('.f');
        return !(box && (box.getAttribute('title') || '').length > 20);
      });
    ok('every bulk input has hover help', bulkTips.length === 0, bulkTips.join(','));
    const bulkBtns = ['btnBulkApply', 'btnRename', 'btnCopyRange', 'btnMoveRange',
      'btnDeleteRange', 'btnCompact'].filter(
      (id) => (($(doc, id).getAttribute('title') || '').length < 20));
    ok('every bulk button has hover help', bulkBtns.length === 0, bulkBtns.join(','));
    ok('the range is described as inclusive',
      /includes both ends/.test($(doc, 'bTo').closest('.f').getAttribute('title')));
    ok('and it says nothing reaches the radio yet',
      /Nothing reaches the radio/.test(txt(doc, 'subPanBulk')), txt(doc, 'subPanBulk').slice(0, 120));

    // options split away from the traffic log
    $(doc, 'tabOptions').click();
    ok('the toggles are on their own tab', $(doc, 'panOptions').contains($(doc, 'chkVerify')));
    ok('and are explained', /Verification reads the codeplug back/.test(txt(doc, 'panOptions')));
    ok('the traffic log sits under the options', $(doc, 'panOptions').contains($(doc, 'log')));
    const optSecs = Array.from($(doc, 'panOptions').querySelectorAll('section'));
    ok('and comes after the toggles',
      optSecs.findIndex((x) => x.contains($(doc, 'chkVerify')))
        < optSecs.findIndex((x) => x.contains($(doc, 'log'))));
    ok('the settings tab does not repeat its own name',
      !/^\s*Settings/.test(txt(doc, 'panSettings')), txt(doc, 'panSettings').slice(0, 40));

    // menus
    // header order: file work on the left, radio work after the spacer
    {
      const head = doc.querySelector('header.panel');
      const seq = Array.from(head.querySelectorAll('[id],.spacer'))
        .map((e) => e.id || (e.classList.contains('spacer') ? 'spacer' : ''))
        .filter((x) => ['btnOpen', 'btnSaveIcf', 'btnToolsMenu', 'spacer',
                        'btnConnect', 'btnRead', 'btnWrite'].includes(x));
      eq('header reads left to right as intended', seq.join(' '),
        'btnOpen btnSaveIcf btnToolsMenu spacer btnConnect btnRead btnWrite');
      const idx = (sel) => Array.prototype.indexOf.call(
        head.children, head.querySelector(sel).closest('header.panel > *'));
      ok('the link lamp sits after the spacer, with the radio buttons',
        idx('#linkText') > idx('.spacer'), 'link before the spacer');
      const css = Array.from(doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      ok('the meter readout is centred and not a fixed width',
        /\.meter output\{[^}]*text-align: ?center/.test(css)
        && !/\.meter output\{[^}]*min-width/.test(css),
        (css.match(/\.meter output\{[^}]*\}/) || [''])[0]);
    }

    // Save is one button now: there is only one codeplug format worth writing,
    // and .bin held the same bytes with no header
    eq('save is a plain button', $(doc, 'btnSaveIcf').tagName, 'BUTTON');
    ok('not inside a menu', !$(doc, 'btnSaveIcf').closest('.menu'));
    eq('save names the format it writes',
      $(doc, 'btnSaveIcf').textContent.trim(), 'Save .icf');
    eq('and open names what it takes',
      $(doc, 'btnOpen').textContent.trim(), 'Open .icf');
    ok('open lists the other formats it accepts',
      /\.img from CHIRP/.test($(doc, 'btnOpen').getAttribute('title')),
      $(doc, 'btnOpen').getAttribute('title'));
    ok('save says it writes everything, not just channels',
      /radio settings/.test($(doc, 'btnSaveIcf').getAttribute('title')),
      $(doc, 'btnSaveIcf').getAttribute('title'));
    ok('the raw save is gone', $(doc, 'btnSaveBin') === null);
    $(doc, 'btnToolsMenu').click();
    ok('tools opens', !$(doc, 'menuTools').hidden);
    // the labels should say what they cover, since CSV is channels only
    eq('csv import says channels', $(doc, 'btnCsvIn').textContent.trim(),
      'Import channels (CSV)');
    eq('csv export says channels', $(doc, 'btnCsvOut').textContent.trim(),
      'Export channels (CSV)');
    ok('and both explain what a CSV leaves out',
      /not in a CSV|not included/.test($(doc, 'btnCsvIn').getAttribute('title'))
      && /not included/.test($(doc, 'btnCsvOut').getAttribute('title')));
    ok('the save button says what it writes',
      /Writes everything/.test($(doc, 'btnSaveIcf').getAttribute('title'))
      && /CHIRP/.test($(doc, 'btnSaveIcf').getAttribute('title')),
      $(doc, 'btnSaveIcf').getAttribute('title'));

    ok('tools holds both csv directions, compare and print',
      $(doc, 'menuTools').contains($(doc, 'btnCsvIn'))
      && $(doc, 'menuTools').contains($(doc, 'btnCsvOut'))
      && $(doc, 'menuTools').contains($(doc, 'btnCompare'))
      && $(doc, 'menuTools').contains($(doc, 'btnPrint')));
    eq('print says what it prints', $(doc, 'btnPrint').textContent.trim(), 'Print channel list');
    eq('compare says what it compares with',
      $(doc, 'btnCompare').textContent.trim().replace(/\u2026|\.\.\./, ''), 'Compare with');
    const items = Array.from($(doc, 'menuTools').querySelectorAll('.btn'));
    eq('and it is the last thing in the menu',
      items[items.length - 1].id, 'btnCompare');
    doc.dispatchEvent(new w.Event('click', { bubbles: true }));
    ok('clicking away closes it', $(doc, 'menuTools').hidden);

    // About sits below the tabs, so it is reachable from every one of them
    const about = doc.querySelector('.rail > details.about');
    ok('about is outside the tab panels', !!about);
    ok('and is set off by a border', /border-top/.test(
      Array.from(doc.querySelectorAll('style')).map((x) => x.textContent).join('')
        .split('details.about')[1] || ''));
    ok('and so is visible on every tab',
      Array.from(doc.querySelectorAll('.tabpanel')).every((p) => !p.contains(about)));
    ok('it still carries the serial-support note', !!$(doc, 'support'));

    // the divider between table and panel
    const bar = $(doc, 'splitter');
    ok('there is a resize handle', !!bar);
    eq('marked up as a separator', bar.getAttribute('role'), 'separator');
    ok('and reachable by keyboard', bar.getAttribute('tabindex') === '0');
    const startWidth = () => w.document.documentElement.style.getPropertyValue('--rail');
    eq('no override until it is used', startWidth(), '');
    bar.dispatchEvent(Object.assign(new w.Event('keydown', { bubbles: true }), { key: 'ArrowLeft' }));
    ok('arrow keys resize it', startWidth() !== '', startWidth());
    bar.dispatchEvent(Object.assign(new w.Event('keydown', { bubbles: true }), { key: 'Home' }));
    eq('Home restores the default', startWidth(), '');
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ---------------------------------------------------- 13. help everywhere
  console.log('\nhover help and rules');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');

    // no escaped newlines leaking into a tooltip
    const allTitles = Array.from(doc.querySelectorAll('[title]'))
      .map((e) => e.getAttribute('title'));
    ok('no tooltip shows a literal backslash-n',
      allTitles.every((t) => t.indexOf('\\n') < 0),
      (allTitles.find((t) => t.indexOf('\\n') >= 0) || '').slice(0, 60));

    // channel editor
    $(doc, 'rows').children[0].click();
    const missing = ['fName', 'fRx', 'fTx', 'fEnc', 'fDec', 'fPwr', 'fBw', 'fStep',
      'fBusy', 'fSql', 'fSig', 'fScr', 'fSkip', 'fDtmf', 'fT5']
      .filter((id) => {
        const box = $(doc, id) && $(doc, id).closest('.f');
        return !(box && (box.getAttribute('title') || '').length > 20);
      });
    ok('every channel field explains itself', missing.length === 0, missing.join(','));
    ok('so do the channel buttons',
      ['btnApply', 'btnClear', 'btnCopyDown']
        .every((id) => ($(doc, id).getAttribute('title') || '').length > 20));

    // options
    $(doc, 'tabOptions').click();
    const optMissing = ['chkVerify', 'chkCompare', 'chkAutoBackup', 'chkLegacy']
      .filter((id) => (($(doc, id).closest('label').getAttribute('title') || '').length < 20));
    ok('every option explains itself', optMissing.length === 0, optMissing.join(','));

    // fm
    $(doc, 'tabFm').click();
    ok('the FM VFO explains itself',
      ($(doc, 'fmVfo').closest('.f').getAttribute('title') || '').length > 20);
    const fmTab = Array.from(doc.querySelectorAll('.tabs button'))
      .find((b) => b.dataset.panel === 'panFm');
    eq('the FM tab says what it is',
      fmTab.textContent.replace(/\u00A0/g, ' ').trim(), 'FM radio');

    // no doubled rule where a panel meets the About block
    const css = Array.from(doc.querySelectorAll('style')).map((x) => x.textContent).join('');
    ok('the last section in a panel drops its bottom rule',
      /section:last-child\s*\{[^}]*border-bottom:\s*0/.test(css.replace(/\s+/g, ' ')),
      'expected a last-child rule');
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ------------------------------------------------------- 14. view changes
  console.log('\nview changes');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    _doc = doc;
    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');

    ok('no view button while nothing has changed', $(doc, 'btnViewChanges').hidden);

    $(doc, 'rows').children[0].click();
    $(doc, 'fName').value = 'EDITED';
    $(doc, 'btnApply').click();
    ok('unsaved changes are flagged', /Unsaved/.test(txt(doc, 'dirty')));
    ok('and the view button appears', !$(doc, 'btnViewChanges').hidden);

    $(doc, 'tabSettings').click();
    $(doc, 'set_light').value = '3';
    $(doc, 'set_light').dispatchEvent(new w.Event('change', { bubbles: true }));

    $(doc, 'btnViewChanges').click();
    await until(() => $(doc, 'scrim').classList.contains('on'), 3000, 'changes modal');
    eq('the dialogue is titled plainly', txt(doc, 'modalTitle'), 'Unsaved changes');
    const body = txt(doc, 'modalBody');
    ok('it names the edited channel', /Channel 1/.test(body), body.slice(0, 140));
    // what changed comes first; the note and the tally follow it
    // the arrows in each row need a stated direction
    {
      const dir = mbDir();
      ok('a direction line is shown', !!dir);
      eq('from side', dir.querySelector('.from').textContent.trim(), 'As loaded');
      eq('to side', dir.querySelector('.to').textContent.trim(), 'Current state');
      ok('and it sits above the changes',
        mb0().innerHTML.indexOf('dirline') < mb0().innerHTML.indexOf('Channel 1'));
    }

    // order: direction, then what changed, then the tally
    const html = $(doc, 'modalBody').innerHTML;
    const iDir = html.indexOf('dirline');
    const iChange = html.indexOf('Channel 1');
    const iCount = html.indexOf('class="summary"');
    ok('the direction comes first', iDir >= 0 && iDir < iChange,
      'direction at ' + iDir + ', change at ' + iChange);
    ok('then the changes', iChange < iCount,
      'change at ' + iChange + ', tally at ' + iCount);
    ok('and the tally last', iCount > iDir);
    {
      const css = Array.from(doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      const rule = (css.match(/\.summary\{[^}]*\}/) || [''])[0];
      ok('the tally is set apart from the changes above it',
        /margin: ?1?[0-9]+px/.test(rule) && /border-top/.test(rule), rule);
    }
    ok('a decoded region is not also counted in bytes',
      !/global settings \(/.test(body), body.slice(0, 200));
    ok('and the edited setting', /Backlight/.test(body), body);
    ok('with readable values', /7\s*→\s*3|7\s*->\s*3/.test(body.replace(/\s+/g, ' ')), body);
    const folded = doc.querySelector('#modalBody details.bytes');
    ok('the byte table is offered but closed', !!folded && !folded.open);
    $(doc, 'modalCancel').click();

    // saving clears both the flag and the button
    w.Blob = class { constructor(p) { this.parts = p; } };
    $(doc, 'btnSaveIcf').click();
    ok('saving clears the unsaved flag', !/Unsaved/.test(txt(doc, 'dirty')), txt(doc, 'dirty'));
    ok('and hides the view button', $(doc, 'btnViewChanges').hidden);
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // -------------------------------------------------- 15. inline cell editing
  console.log('\ninline editing');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');

    const cell = (row, col) => $(doc, 'rows').children[row].children[col];
    const dbl = (row, col) => cell(row, col)
      .dispatchEvent(new w.Event('dblclick', { bubbles: true }));
    const key = (el, k, shift) => el.dispatchEvent(Object.assign(
      new w.Event('keydown', { bubbles: true }), { key: k, shiftKey: !!shift,
        preventDefault() {} }));

    // the row must survive a double-click: an earlier version rebuilt the
    // table on the first click, so the second landed on a detached node
    dbl(0, 3);
    let ed = cell(0, 3).querySelector('.cellEdit');
    ok('double-click opens an editor in the cell', !!ed);
    eq('prefilled with the current value', ed.value, '435.00000');
    ok('and the row is selected too', $(doc, 'rows').children[0]
      .getAttribute('aria-selected') === 'true');

    // commit with Enter, which should drop to the same column one row down
    ed.value = '145.500';
    key(ed, 'Enter');
    eq('the value reaches the codeplug', cell(0, 3).textContent.trim(), '145.50000');
    ok('Enter moves down a row', !!cell(1, 3).querySelector('.cellEdit'));
    key(cell(1, 3).querySelector('.cellEdit'), 'Escape');

    // Escape leaves the value alone
    dbl(0, 2);
    ed = cell(0, 2).querySelector('.cellEdit');
    ed.value = 'THROWAWAY';
    key(ed, 'Escape');
    ok('Escape discards the edit', !/THROWAWAY/.test(cell(0, 2).textContent), cell(0, 2).textContent);

    // Tab moves across the editable columns only
    dbl(0, 2);
    key(cell(0, 2).querySelector('.cellEdit'), 'Tab');
    ok('Tab skips the derived Shift column and lands on Receive',
      !!cell(0, 3).querySelector('.cellEdit'));
    key(cell(0, 3).querySelector('.cellEdit'), 'Escape');

    // a bad frequency is refused and the editor stays open
    dbl(0, 3);
    ed = cell(0, 3).querySelector('.cellEdit');
    ed.value = 'banana';
    key(ed, 'Enter');
    ok('a bad frequency is refused', ed.getAttribute('aria-invalid') === 'true');
    ok('and explained', /145\.500/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('with the editor still open', !!cell(0, 3).querySelector('.cellEdit'));
    key(ed, 'Escape');

    // dropdown columns
    dbl(0, 8);
    const sel = cell(0, 8).querySelector('.cellEdit');
    eq('power edits as a dropdown', sel.tagName, 'SELECT');
    eq('with the radio value selected', sel.options[sel.selectedIndex].textContent, 'High');
    sel.value = '2';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('choosing a value commits it', /Low/.test(cell(0, 8).textContent), cell(0, 8).textContent);

    // tone columns reuse the full picker
    dbl(0, 6);
    const tone = cell(0, 6).querySelector('.cellEdit');
    eq('encode edits as a dropdown', tone.tagName, 'SELECT');
    eq('with every valid tone', tone.options.length, T.toneChoices().length);
    tone.value = '88.5';
    tone.dispatchEvent(new w.Event('change', { bubbles: true }));
    ok('the tone lands', /88\.5/.test(cell(0, 6).textContent), cell(0, 6).textContent);

    // the side panel must agree with what the grid just did
    ok('the side panel follows an inline edit',
      $(doc, 'fEnc').value === '88.5' && $(doc, 'fPwr').value === '2',
      $(doc, 'fEnc').value + ' / ' + $(doc, 'fPwr').value);

    // and the grid must follow the side panel
    $(doc, 'fName').value = 'PANEL';
    $(doc, 'btnApply').click();
    ok('the grid follows the side panel', /PANEL/.test(cell(0, 2).textContent));

    // an empty slot must present as empty, not as whatever the factory left in
    // it - on this radio every unused record holds 435.00000, which made empty
    // rows look like a copy of channel 1
    $(doc, 'rows').children[7].click();
    eq('an empty slot shows no receive frequency', $(doc, 'fRx').value, '');
    eq('and no transmit frequency', $(doc, 'fTx').value, '');
    eq('and no name', $(doc, 'fName').value, '');
    eq('and no tone', $(doc, 'fEnc').value, 'off');
    ok('and the leftover record is still on disk untouched',
      new T.Codeplug(image).getChannel(7).rxHz === 435000000);

    // every column shows something: a cell that renders blank looks like the
    // edit did not take
    {
      const row0 = $(doc, 'rows').children[0];
      const blanks = [2, 3, 4, 6, 7, 8, 9, 10, 11]
        .filter((i) => row0.children[i].textContent.trim() === '');
      ok('no editable column renders blank', blanks.length === 0, 'blank columns: ' + blanks.join(','));
    }
    // every operation that changes the codeplug must also redraw the table.
    // Copy to next did not, so it reported success over a stale row.
    {
      $(doc, 'rows').children[0].click();
      $(doc, 'fName').value = 'SOURCE';
      $(doc, 'fRx').value = '145.500';
      $(doc, 'fTx').value = '145.500';
      $(doc, 'btnApply').click();
      $(doc, 'btnCopyDown').click();
      ok('copy to next shows up in the table',
        /SOURCE/.test($(doc, 'rows').children[1].textContent),
        $(doc, 'rows').children[1].textContent);
      ok('and names both channels', /channel 1 into channel 2/i.test(txt(doc, 'msg')), txt(doc, 'msg'));
      ok('and selects the copy', $(doc, 'rows').children[1]
        .getAttribute('aria-selected') === 'true');
      eq('the side panel follows', $(doc, 'fName').value, 'SOURCE');

      // an empty source has nothing to copy
      $(doc, 'rows').children[40].click();
      $(doc, 'btnCopyDown').click();
      ok('copying an empty channel is refused', /nothing to copy/.test(txt(doc, 'msg')), txt(doc, 'msg'));
      ok('and leaves the next row empty', /free/.test($(doc, 'rows').children[41].textContent));

      // bulk copy and move, which share none of that code path
      $(doc, 'subBulk').click();
      $(doc, 'chkSelOnly').checked = false;
      $(doc, 'chkSelOnly').dispatchEvent(new w.Event('change', { bubbles: true }));
      $(doc, 'bFrom').value = '1'; $(doc, 'bTo').value = '1'; $(doc, 'bDest').value = '60';
      $(doc, 'btnCopyRange').click();
      ok('bulk copy lands in the table', /SOURCE/.test($(doc, 'rows').children[59].textContent),
        $(doc, 'rows').children[59].textContent);
      ok('and the source stays', /SOURCE/.test($(doc, 'rows').children[0].textContent));
      $(doc, 'bFrom').value = '60'; $(doc, 'bTo').value = '60'; $(doc, 'bDest').value = '70';
      $(doc, 'btnMoveRange').click();
      ok('bulk move lands', /SOURCE/.test($(doc, 'rows').children[69].textContent));
      ok('and clears the source', /free/.test($(doc, 'rows').children[59].textContent),
        $(doc, 'rows').children[59].textContent);
      $(doc, 'subChannel').click();
      $(doc, 'rows').children[1].click();
      $(doc, 'btnClear').click();
      $(doc, 'rows').children[69].click();
      $(doc, 'btnClear').click();
      $(doc, 'rows').children[0].click();
    }

    // acting on the selected channel instead of the range
    {
      // give three channels something to tell them apart
      [[0, 'AAA'], [1, 'BBB'], [2, 'CCC']].forEach(([i, n]) => {
        $(doc, 'subChannel').click();
        $(doc, 'rows').children[i].click();
        $(doc, 'fName').value = n;
        $(doc, 'fRx').value = '145.' + (500 + i);
        $(doc, 'fTx').value = '145.' + (500 + i);
        $(doc, 'btnApply').click();
      });

      $(doc, 'subBulk').click();
      $(doc, 'chkSelOnly').checked = true;
      $(doc, 'chkSelOnly').dispatchEvent(new w.Event('change', { bubbles: true }));
      ok('with it on, the range boxes are hidden',
        $(doc, 'bulkRangeBoxes').hidden && $(doc, 'bFrom').disabled);
      ok('and the range-only sections are hidden',
        $(doc, 'secBulkField').hidden && $(doc, 'secBulkRename').hidden);
      ok('while move, copy and delete stay available',
        !$(doc, 'btnCopyRange').closest('section').hidden);

      // select channel 2 and copy it somewhere; the range says 1-200 and must be ignored
      $(doc, 'subChannel').click();
      $(doc, 'rows').children[1].click();
      $(doc, 'subBulk').click();
      ok('the label names the selected channel',
        /channel 2/.test(txt(doc, 'selOnlyWho')), txt(doc, 'selOnlyWho'));
      $(doc, 'bFrom').value = '1'; $(doc, 'bTo').value = '200'; $(doc, 'bDest').value = '80';
      $(doc, 'btnCopyRange').click();
      ok('only the selected channel is copied',
        /BBB/.test($(doc, 'rows').children[79].textContent),
        $(doc, 'rows').children[79].textContent);
      ok('the others are left where they are',
        /AAA/.test($(doc, 'rows').children[0].textContent)
        && /CCC/.test($(doc, 'rows').children[2].textContent));
      ok('and nothing landed beside the copy',
        /free/.test($(doc, 'rows').children[80].textContent),
        $(doc, 'rows').children[80].textContent);

      // it governs the field setter too. That section is hidden while the
      // switch is on, so reach the controls directly.
      $(doc, 'bField').value = '0';
      $(doc, 'bField').dispatchEvent(new w.Event('change', { bubbles: true }));
      $(doc, 'bValue').value = '1';                       // Mid, which nothing else has set
      $(doc, 'btnBulkApply').click();
      ok('setting a field touches one channel', /1 channel/.test(txt(doc, 'msg')), txt(doc, 'msg'));
      ok('and it is the selected one', /Mid/.test($(doc, 'rows').children[1].textContent),
        $(doc, 'rows').children[1].textContent);
      ok('not its neighbours', !/Mid/.test($(doc, 'rows').children[0].textContent)
        && !/Mid/.test($(doc, 'rows').children[2].textContent));

      // and delete
      $(doc, 'btnDeleteRange').click();
      await until(() => $(doc, 'scrim').classList.contains('on'), 3000, 'delete confirm');
      ok('the confirmation names one channel', /Delete 1 channel\?/.test(txt(doc, 'modalTitle')),
        txt(doc, 'modalTitle'));
      $(doc, 'modalOk').click();
      await until(() => /free/.test($(doc, 'rows').children[1].textContent), 3000, 'delete applied');
      ok('only that channel goes', /free/.test($(doc, 'rows').children[1].textContent));
      ok('its neighbours survive', /AAA/.test($(doc, 'rows').children[0].textContent)
        && /CCC/.test($(doc, 'rows').children[2].textContent));

      // unticking restores the range behaviour
      $(doc, 'chkSelOnly').checked = false;
      $(doc, 'chkSelOnly').dispatchEvent(new w.Event('change', { bubbles: true }));
      ok('the range boxes come back',
        !$(doc, 'bulkRangeBoxes').hidden && !$(doc, 'bFrom').disabled && !$(doc, 'bTo').disabled);
      ok('and so do the range-only sections',
        !$(doc, 'secBulkField').hidden && !$(doc, 'secBulkRename').hidden);
      eq('and the label clears', txt(doc, 'selOnlyWho'), '');
      $(doc, 'bFrom').value = '1'; $(doc, 'bTo').value = '3';
      $(doc, 'bField').value = '0';
      $(doc, 'bField').dispatchEvent(new w.Event('change', { bubbles: true }));
      $(doc, 'bValue').value = '1';
      $(doc, 'btnBulkApply').click();
      ok('the range applies again', /2 channels/.test(txt(doc, 'msg')), txt(doc, 'msg'));

      // tidy up
      [0, 2, 79].forEach((i) => {
        $(doc, 'subChannel').click();
        $(doc, 'rows').children[i].click();
        $(doc, 'btnClear').click();
      });
      $(doc, 'rows').children[0].click();
      $(doc, 'fName').value = 'SOURCE';
      $(doc, 'fRx').value = '145.500'; $(doc, 'fTx').value = '145.500';
      $(doc, 'btnApply').click();
    }

    // the delete control must not be clipped by the column's overflow rule
    {
      const css = Array.from(doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      ok('the delete cell does not ellipsis its contents',
        /td\.delcell\{[^}]*text-overflow: ?clip/.test(css), 'no clip rule for .delcell');
      ok('and selects leave room for their arrow',
        /\.f select\{[^}]*padding-right/.test(css) && /select\.cellEdit\{[^}]*padding-right/.test(css),
        'no padding-right on selects');
    }

    // a delete control on each row
    {
      $(doc, 'rows').children[0].click();
      const del = $(doc, 'rows').children[0].querySelector('[data-del]');
      ok('used rows carry a delete control', !!del);
      ok('and it says what it does', /Clear channel 1/.test(del.getAttribute('title')),
        del.getAttribute('title'));
      ok('empty rows do not', !$(doc, 'rows').children[6].querySelector('[data-del]'));
      eq('one control per column count', $(doc, 'rows').children[0].children.length,
        doc.querySelectorAll('.grid-wrap thead th').length);

      // clearing row 1 must not also change the selection or touch its neighbour
      const before2 = $(doc, 'rows').children[1].textContent;
      del.click();
      ok('the row empties', /free/.test($(doc, 'rows').children[0].textContent),
        $(doc, 'rows').children[0].textContent);
      ok('and says so', /Channel 1 cleared/.test(txt(doc, 'msg')), txt(doc, 'msg'));
      eq('the row below is untouched', $(doc, 'rows').children[1].textContent, before2);
      ok('the codeplug is marked unsaved', /Unsaved/.test(txt(doc, 'dirty')));

      // put it back for the checks that follow
      $(doc, 'rows').children[0].click();
      $(doc, 'fRx').value = '145.500';
      $(doc, 'fTx').value = '145.500';
      $(doc, 'btnApply').click();
    }

    // an empty slot must leave both frequency boxes blank, not one of them
    {
      $(doc, 'rows').children[6].click();
      eq('receive is blank on an empty slot', $(doc, 'fRx').value, '');
      eq('transmit is blank too', $(doc, 'fTx').value, '');
      // and a claimed slot with no frequency behaves the same way
      $(doc, 'fName').value = 'NOFREQ';
      $(doc, 'btnApply').click();
      ok('claiming without a frequency is refused by the panel',
        /required/i.test(txt(doc, 'msg')), txt(doc, 'msg'));
      $(doc, 'rows').children[0].click();
    }

    // "off" must survive every formatter. One of them used to miss the
    // sentinel and print 42949.67295 MHz.
    {
      $(doc, 'rows').children[0].click();
      $(doc, 'fTx').value = 'off';
      $(doc, 'btnApply').click();
      const row = $(doc, 'rows').children[0];
      eq('the table says off', row.children[4].textContent.trim(), 'off');
      ok('and never the raw sentinel', !/42949/.test(row.textContent), row.textContent);
      eq('the shift column agrees', row.children[5].textContent.trim(), 'rx only');
      eq('the side panel says off', $(doc, 'fTx').value, 'off');
      dbl(0, 4);
      eq('and so does the inline editor', cell(0, 4).querySelector('.cellEdit').value, 'off');
      key(cell(0, 4).querySelector('.cellEdit'), 'Escape');

      let captured = null;
      w.Blob = class { constructor(parts) { captured = parts[0]; } };
      $(doc, 'btnCsvOut').click();
      ok('the csv says off', /,off,/.test(captured.split('\r\n')[1]), captured.split('\r\n')[1]);
      w.open = () => null;
      $(doc, 'btnPrint').click();
      ok('the printed sheet says rx only', /rx only/.test(captured));
      ok('and shows no sentinel anywhere', !/42949/.test(captured));

      // A blank cell on paper reads as missing data. Every column must say
      // something - Scan printed nothing for an included channel until it did.
      {
        const head = (captured.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
        const cols = (head.match(/<th>/g) || []).length;
        const firstRow = (captured.match(/<tbody><tr>[\s\S]*?<\/tr>/) || [''])[0];
        const cells = (firstRow.match(/<td>/g) || []).length;
        eq('every column has a cell', cells, cols);
        ok('none of them is empty', !/<td><\/td>/.test(captured),
          (captured.match(/<td><\/td>/) || [''])[0]);
        ok('Scan says include, not nothing', /<td>include<\/td>/.test(captured)
          || /<td>skip<\/td>/.test(captured), 'no scan value printed');
        for (const h of ['Shift', 'Step', 'Scan', 'Power', 'BW'])
          ok('the sheet has a ' + h + ' column', head.indexOf('<th>' + h) >= 0, head);
        ok('and says how many channels it lists',
          /\d+ of 200 channels/.test(captured), captured.slice(0, 400));
      }

      // put it back
      $(doc, 'rows').children[0].click();
      $(doc, 'fTx').value = '145.500';
      $(doc, 'btnApply').click();
    }

    // narrow screens must scroll rather than crush the columns
    {
      const css = Array.from(doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      ok('the grid has a minimum width', /table\{[^}]*min-width: ?\d+px/.test(css), 'no min-width on the table');
      ok('and its container scrolls', /\.grid-wrap\{[^}]*overflow: ?auto/.test(css));
    }

    // opening an editor must not move the columns. jsdom has no layout engine,
    // so this checks the mechanism that guarantees it rather than pixels.
    {
      const css = Array.from(doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      ok('the grid uses a fixed layout', /table\{[^}]*table-layout: ?fixed/.test(css), 'no table-layout:fixed');
      const cols = doc.querySelectorAll('.grid-wrap colgroup col');
      eq('every column has a declared width', cols.length,
        doc.querySelectorAll('.grid-wrap thead th').length);
      ok('all of them are actually set',
        Array.from(cols).every((c) => /\d/.test(c.style.width)),
        Array.from(cols).map((c) => c.style.width).join(','));
      ok('cells do not change padding while editing', !/:has\(\.cellEdit\)/.test(css));
      ok('the editor is capped to its cell', /\.cellEdit\{[^}]*max-width: ?100%/.test(css));
    }

    dbl(0, 11);
    const scanSel = cell(0, 11).querySelector('.cellEdit');
    scanSel.value = '1';
    scanSel.dispatchEvent(new w.Event('change', { bubbles: true }));
    eq('scan shows skip', cell(0, 11).textContent.trim(), 'skip');
    dbl(0, 11);
    const scanSel2 = cell(0, 11).querySelector('.cellEdit');
    scanSel2.value = '0';
    scanSel2.dispatchEvent(new w.Event('change', { bubbles: true }));
    eq('and shows include rather than nothing', cell(0, 11).textContent.trim(), 'include');

    // any column can start an empty row off, not just Receive
    ok('channel 8 starts empty', /free/.test($(doc, 'rows').children[7].textContent));
    dbl(7, 2);
    const byName = cell(7, 2).querySelector('.cellEdit');
    ok('a name can be typed on an empty row', !!byName);
    byName.value = 'FIRST';
    key(byName, 'Enter');
    ok('which claims the channel', !/free/.test($(doc, 'rows').children[7].textContent),
      $(doc, 'rows').children[7].textContent);
    ok('and warns that it has no frequency yet',
      /no receive frequency yet/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('the frequency reads as absent, not as zero',
      /not set/.test($(doc, 'rows').children[7].children[3].textContent),
      $(doc, 'rows').children[7].children[3].textContent);
    $(doc, 'tabChannel').click();
    $(doc, 'subChecks').click();
    $(doc, 'btnCheck').click();
    ok('and the checks flag it',
      /channel 8 is in use but has no receive frequency/i.test(txt(doc, 'issues')),
      txt(doc, 'issues').slice(0, 140));
    $(doc, 'subChannel').click();
    dbl(7, 3);
    const claim = cell(7, 3).querySelector('.cellEdit');
    claim.value = '433.500';
    key(claim, 'Enter');
    ok('giving it a frequency settles it',
      /433\.50000/.test($(doc, 'rows').children[7].textContent),
      $(doc, 'rows').children[7].textContent);
    key(cell(8, 3).querySelector('.cellEdit'), 'Escape');

    // claiming must not inherit the factory leftovers
    const claimedRow = $(doc, 'rows').children[7];
    ok('the claimed channel took the frequency typed',
      /433\.50000/.test(claimedRow.children[3].textContent), claimedRow.textContent);
    eq('and a neutral step, not the factory 10 kHz',
      claimedRow.children[10].textContent.trim(), String(T.STEPS_KHZ[0]));
    eq('and its name survived being claimed first', 
      claimedRow.children[2].textContent.trim(), 'FIRST');
    eq('and no inherited encode tone', claimedRow.children[6].textContent.trim(), 'off');
    eq('and no inherited decode tone', claimedRow.children[7].textContent.trim(), 'off');

    // losing focus with an unreadable value must not hold the caret hostage
    dbl(0, 3);
    const loose = cell(0, 3).querySelector('.cellEdit');
    loose.value = 'nonsense';
    loose.dispatchEvent(new w.Event('blur', { bubbles: true }));
    await sleep(30);
    ok('a soft cancel closes the editor', !cell(0, 3).querySelector('.cellEdit'));
    ok('says nothing was changed', /Nothing was changed/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    ok('and leaves the value alone', /145\.50000/.test(cell(0, 3).textContent), cell(0, 3).textContent);

    // the same on a codeplug with no channels at all
    {
      const blank = await loadPage(makeFakePort(image, false));
      const bc = (r, c) => $(blank.doc, 'rows').children[r].children[c];
      bc(2, 3).dispatchEvent(new blank.w.Event('dblclick', { bubbles: true }));
      const ed2 = bc(2, 3).querySelector('.cellEdit');
      ok('an empty codeplug opens an empty editor', ed2 && ed2.value === '', ed2 && ed2.value);
      ed2.dispatchEvent(new blank.w.Event('blur', { bubbles: true }));
      await sleep(30);
      ok('and closes quietly when abandoned', !bc(2, 3).querySelector('.cellEdit'));
      ok('claiming nothing', /free/.test($(blank.doc, 'rows').children[2].textContent));
      blank.w.close();
    }

    // non-editable columns do nothing
    dbl(0, 1);
    ok('the channel number is not editable', !cell(0, 1).querySelector('.cellEdit'));
    dbl(0, 5);
    ok('the derived Shift column is not editable', !cell(0, 5).querySelector('.cellEdit'));
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ------------------------------------------------ 16. theme and preferences
  console.log('\ntheme and remembered preferences');
  {
    const mem = {};
    const fakeStore = {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; }
    };
    const boot = async (dark) => {
      const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
      const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
      const w = dom.window;
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.navigator.serial = { requestPort: async () => ({}) };
      Object.defineProperty(w, 'localStorage', { value: fakeStore, configurable: true });
      w.matchMedia = () => ({ matches: !!dark, addEventListener() {} });
      if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
        w.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
      }
      for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (m[1].trim()) w.eval(m[1]);
      }
      return { w, doc: w.document };
    };

    let p1 = await boot(false);
    eq('a fresh page follows the system, which is light here',
      p1.doc.documentElement.getAttribute('data-theme'), 'light');
    eq('and the control shows Auto', $(p1.doc, 'selTheme').value, 'auto');

    $(p1.doc, 'selTheme').value = 'dark';
    $(p1.doc, 'selTheme').dispatchEvent(new p1.w.Event('change', { bubbles: true }));
    eq('choosing dark applies it', p1.doc.documentElement.getAttribute('data-theme'), 'dark');
    ok('and it is remembered', mem['th2000.theme'] === '"dark"', mem['th2000.theme']);

    // toggles and panel width are remembered too, codeplugs are not
    $(p1.doc, 'chkAutoBackup').checked = false;
    $(p1.doc, 'chkAutoBackup').dispatchEvent(new p1.w.Event('change', { bubbles: true }));
    $(p1.doc, 'splitter').dispatchEvent(Object.assign(
      new p1.w.Event('keydown', { bubbles: true }), { key: 'ArrowLeft', preventDefault() {} }));
    await sleep(25);
    p1.w.close();

    const p2 = await boot(false);
    eq('the theme survives a reload', p2.doc.documentElement.getAttribute('data-theme'), 'dark');
    eq('so does the control', $(p2.doc, 'selTheme').value, 'dark');
    eq('and a toggle', $(p2.doc, 'chkAutoBackup').checked, false);
    ok('and the panel width', p2.doc.documentElement.style.getPropertyValue('--rail') !== '',
      p2.doc.documentElement.style.getPropertyValue('--rail'));
    ok('no codeplug is remembered',
      !Object.keys(mem).some((k) => /codeplug|image|channel/i.test(k)),
      Object.keys(mem).join(','));
    await sleep(25);
    p2.w.close();

    // auto follows the system when that is what is chosen
    mem['th2000.theme'] = '"auto"';
    const p3 = await boot(true);
    eq('auto picks up a dark system', p3.doc.documentElement.getAttribute('data-theme'), 'dark');

    // dark mode must reach the native controls too. Without color-scheme the
    // checkboxes and the FM inputs stay white on a dark panel.
    {
      const css = Array.from(p3.doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      ok('the light palette declares its colour scheme', /:root\{[^}]*color-scheme: ?light/.test(css));
      ok('and the dark one declares dark',
        /:root\[data-theme="dark"\]\{[^}]*color-scheme: ?dark/.test(css));
      const unthemed = [];
      // strip comments first: a selector is not a comment, and a comment
      // containing the word "selected" was being read as a <select> rule
      const rules = css.replace(/\/\*[\s\S]*?\*\//g, ' ').match(/[^{}]+\{[^}]*\}/g) || [];
      for (const r of rules) {
        const [sel, body] = [r.slice(0, r.indexOf('{')), r.slice(r.indexOf('{'))];
        if (!/input|select|textarea/.test(sel)) continue;
        if (!/border|padding/.test(body)) continue;
        if (/background/.test(body)) continue;
        // padding-only helpers inherit from the combined rule above them
        if (/^\s*(\.f select|select\.cellEdit)\s*$/.test(sel)) continue;
        unthemed.push(sel.trim());
      }
      ok('every control that draws itself sets a themed background',
        unthemed.length === 0, unthemed.join(' | '));
      ok('the FM presets are set apart from the VFO',
        /\.fmlist\{[^}]*margin-top/.test(css) && /Presets/.test(p3.doc.body.textContent));
    }
    await sleep(25);
    p3.w.close();

    // storage that throws must not break the page
    const hostile = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); }
    };
    const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
    const w4 = dom.window;
    w4.HTMLElement.prototype.scrollIntoView = function () {};
    w4.navigator.serial = { requestPort: async () => ({}) };
    Object.defineProperty(w4, 'localStorage', { value: hostile, configurable: true });
    w4.matchMedia = () => ({ matches: false, addEventListener() {} });
    let threw = null;
    try {
      if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
        w4.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
      }
      for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (m[1].trim()) w4.eval(m[1]);
      }
    } catch (e) { threw = e.message; }
    ok('a page with blocked storage still starts', threw === null, threw);
    eq('and still renders the grid', w4.document.getElementById('rows').children.length, 200);
    w4.close();
  }


  // ------------------------------------------------------- 17. the nameplate
  console.log('\nnameplate');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    w.Blob = class { constructor(p) { this.parts = p; } };

    eq('a fresh page shows plain capacity', txt(doc, 'plateLine'), 'codeplug \u00B7 200 ch');
    // textContent includes <script> bodies, so look at what is actually shown
    const visible = Array.from(doc.querySelectorAll('header, main, footer'))
      .map((e) => e.textContent).join(' ');
    ok('the old byte count is gone from the interface', !/0x2B80/.test(visible));
    ok('codeplug is explained on hover',
      /Motorola/.test(doc.querySelector('.plate').getAttribute('title') || ''),
      doc.querySelector('.plate').getAttribute('title'));

    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');
    eq('loading a file switches to how many are in use', txt(doc, 'plateLine'),
      'codeplug \u00B7 1 of 200 ch');

    // the count follows the codeplug
    $(doc, 'rows').children[4].click();
    $(doc, 'fRx').value = '145.500';
    $(doc, 'fTx').value = '145.500';
    $(doc, 'btnApply').click();
    eq('adding a channel updates the count', txt(doc, 'plateLine'), 'codeplug \u00B7 2 of 200 ch');
    $(doc, 'rows').children[4].querySelector('[data-del]').click();
    eq('and removing one updates it back', txt(doc, 'plateLine'), 'codeplug \u00B7 1 of 200 ch');

    // a read says where it came from
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');
    eq('a radio read counts too', txt(doc, 'plateLine'), 'codeplug \u00B7 1 of 200 ch');
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // -------------------------------------------------- 18. keyboard shortcuts
  console.log('\nkeyboard on the channel list');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');

    // dispatch from the body, which is where a real keypress lands when no
    // field has focus
    const press = (key, opts) => doc.body.dispatchEvent(new w.KeyboardEvent('keydown',
      Object.assign({ key: key, bubbles: true, cancelable: true }, opts || {})));

    // name a channel so the copy is recognisable
    $(doc, 'rows').children[0].click();
    $(doc, 'fName').value = 'CLIP';
    $(doc, 'btnApply').click();

    // nothing copied yet
    press('v', { ctrlKey: true });
    ok('paste with an empty clipboard explains itself',
      /Nothing has been copied yet/.test(txt(doc, 'msg')), txt(doc, 'msg'));

    // copy, then paste somewhere else
    $(doc, 'rows').children[0].click();
    press('c', { ctrlKey: true });
    ok('copy confirms', /Copied channel 1/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    $(doc, 'rows').children[9].click();
    press('v', { ctrlKey: true });
    ok('paste lands', /CLIP/.test($(doc, 'rows').children[9].textContent),
      $(doc, 'rows').children[9].textContent);
    ok('and the source is still there', /CLIP/.test($(doc, 'rows').children[0].textContent));
    ok('the plate counts the new one', /2 of 200 ch/.test(txt(doc, 'plateLine')), txt(doc, 'plateLine'));

    // cut clears the source
    $(doc, 'rows').children[9].click();
    press('x', { ctrlKey: true });
    ok('cut empties the row', /free/.test($(doc, 'rows').children[9].textContent),
      $(doc, 'rows').children[9].textContent);
    $(doc, 'rows').children[14].click();
    press('v', { ctrlKey: true });
    ok('and it can be placed elsewhere', /CLIP/.test($(doc, 'rows').children[14].textContent));

    // delete
    press('Delete');
    ok('Delete clears the selected channel', /free/.test($(doc, 'rows').children[14].textContent));
    press('Delete');
    ok('and says so when it is already empty', /already empty/.test(txt(doc, 'msg')), txt(doc, 'msg'));

    // copying an empty row has nothing to offer
    press('c', { ctrlKey: true });
    ok('copying an empty channel is refused', /nothing to copy/.test(txt(doc, 'msg')), txt(doc, 'msg'));

    // the shortcuts must survive a keyboard layout that produces other letters
    {
      $(doc, 'rows').children[0].click();
      $(doc, 'fName').value = 'CYR';
      $(doc, 'btnApply').click();
      const layoutPress = (key, code, opts) => doc.body.dispatchEvent(
        new w.KeyboardEvent('keydown', Object.assign(
          { key: key, code: code, bubbles: true, cancelable: true }, opts || {})));

      // Cyrillic: the character is different, the physical key is not
      layoutPress('\u0441', 'KeyC', { ctrlKey: true });
      ok('Ctrl+C works on a Cyrillic layout', /Copied channel 1/.test(txt(doc, 'msg')),
        txt(doc, 'msg'));
      $(doc, 'rows').children[19].click();
      layoutPress('\u043C', 'KeyV', { ctrlKey: true });
      ok('and so does Ctrl+V', /CYR/.test($(doc, 'rows').children[19].textContent),
        $(doc, 'rows').children[19].textContent);
      layoutPress('\u0447', 'KeyX', { ctrlKey: true });
      ok('and Ctrl+X', /free/.test($(doc, 'rows').children[19].textContent));

      // Dvorak: the letter is right but sits on a different physical key
      $(doc, 'rows').children[0].click();
      layoutPress('c', 'KeyI', { ctrlKey: true });
      ok('Ctrl+C works on Dvorak too', /Copied channel 1/.test(txt(doc, 'msg')),
        txt(doc, 'msg'));

      // and an unrelated key with a matching character must not fire
      const before = $(doc, 'rows').children[21].textContent;
      $(doc, 'rows').children[21].click();
      layoutPress('q', 'KeyQ', { ctrlKey: true });
      eq('an unrelated shortcut does nothing',
        $(doc, 'rows').children[21].textContent, before);
      $(doc, 'rows').children[0].click();
    }

    // the last change must not draw a rule into the tally's own rule
    {
      const css = Array.from(doc.querySelectorAll('style'))
        .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
      ok('the final list item has no bottom rule',
        /\.dlist li:last-child\{[^}]*border-bottom: ?0/.test(css),
        'no last-child rule');
    }

    // a field must keep its own keys
    $(doc, 'rows').children[0].click();
    const before = $(doc, 'rows').children[3].textContent;
    $(doc, 'fName').focus();
    $(doc, 'fName').dispatchEvent(new w.KeyboardEvent('keydown',
      { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
    eq('typing in a field is not hijacked', $(doc, 'rows').children[3].textContent, before);

    // nor should a dialogue be interrupted
    $(doc, 'btnCompare').click();
    setFileOnInput(w, doc, 'fileCmp', 'other.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => $(doc, 'scrim').classList.contains('on'), 4000, 'compare modal');
    const rowBefore = $(doc, 'rows').children[0].textContent;
    press('Delete');
    eq('shortcuts are off while a dialogue is open',
      $(doc, 'rows').children[0].textContent, rowBefore);
    $(doc, 'modalCancel').click();
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ------------------------------------------------------- 19. the tab title
  console.log('\ntab title');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    w.Blob = class { constructor(p) { this.parts = p; } };

    ok('an empty page names the tool',
      /TH-2000 codeplug/.test(doc.title), doc.title);
    ok('and says nothing is loaded yet',
      /New codeplug/.test(doc.title), doc.title);

    setFileOnInput(w, doc, 'file', 'ORIGIN_BACKUP_ConFile.icf',
      fs.readFileSync(path.join(WEB, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');
    ok('opening a file puts its name in the tab',
      /^ORIGIN_BACKUP_ConFile\.icf \u2014 TH-2000 codeplug$/.test(doc.title), doc.title);

    $(doc, 'rows').children[0].click();
    $(doc, 'fName').value = 'EDIT';
    $(doc, 'btnApply').click();
    ok('an unsaved edit marks the tab',
      doc.title.startsWith('\u2022 '), doc.title);
    ok('and keeps the filename', /ORIGIN_BACKUP_ConFile\.icf/.test(doc.title));

    $(doc, 'btnSaveIcf').click();
    ok('saving clears the mark', !doc.title.startsWith('\u2022 '), doc.title);

    // a radio read says so rather than inventing a filename
    $(doc, 'btnConnect').click();
    await until(() => !$(doc, 'btnRead').disabled, 3000, 'connect');
    $(doc, 'btnRead').click();
    await until(() => txt(doc, 'meterText') === '22 / 22', 8000, 'read');
    ok('a radio read is named in the tab',
      /Read from radio/.test(doc.title), doc.title);

    // the direction line is centred
    const css = Array.from(doc.querySelectorAll('style'))
      .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
    ok('the direction line is centred',
      /\.dirline\{[^}]*justify-content: ?center/.test(css), 'no centring rule');
    await sleep(25);   // let anything in flight settle before teardown
    w.close();
  }


  // ------------------------------------------- 20. folded groups are remembered
  console.log('\nsettings groups fold and are remembered');
  {
    const mem = {};
    const fake = {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; }
    };
    const boot = async () => {
      const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
      const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
      const w = dom.window;
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.navigator.serial = { requestPort: async () => ({}) };
      Object.defineProperty(w, 'localStorage', { value: fake, configurable: true });
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
        w.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
      }
      for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (m[1].trim()) w.eval(m[1]);
      }
      w.document.getElementById('tabSettings').click();
      return { w, doc: w.document };
    };
    const grp = (doc, g) => doc.querySelector('details.grp[data-grp="' + g + '"]');

    let a = await boot();
    eq('keys open on a fresh page', grp(a.doc, 'keys').open, true);
    eq('radio folded away', grp(a.doc, 'radio').open, false);

    // open two, close Keys
    for (const [g, want] of [['radio', true], ['security', true], ['keys', false]]) {
      const d = grp(a.doc, g);
      d.open = want;
      d.dispatchEvent(new a.w.Event('toggle', { bubbles: false }));
    }
    ok('the choice is written down', 'th2000.grpOpen' in mem, Object.keys(mem).join(','));
    await sleep(25);
    a.w.close();

    const b = await boot();
    eq('radio comes back open', grp(b.doc, 'radio').open, true);
    eq('security too', grp(b.doc, 'security').open, true);
    eq('and keys stays closed', grp(b.doc, 'keys').open, false);
    eq('a group never touched keeps its default', grp(b.doc, 'display').open, false);
    await sleep(25);
    b.w.close();

    // storage that refuses must not break the panel
    const hostile = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
    const html = fs.readFileSync(path.join(WEB, PAGE), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://localhost/' });
    const w3 = dom.window;
    w3.HTMLElement.prototype.scrollIntoView = function () {};
    w3.navigator.serial = { requestPort: async () => ({}) };
    Object.defineProperty(w3, 'localStorage', { value: hostile, configurable: true });
    w3.matchMedia = () => ({ matches: false, addEventListener() {} });
    let threw = null;
    try {
      if (/<script\s+src=["']th2000-core\.js["']/.test(html)) {
        w3.eval(fs.readFileSync(path.join(WEB, 'th2000-core.js'), 'utf8'));
      }
      for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (m[1].trim()) w3.eval(m[1]);
      }
    } catch (e) { threw = e.message; }
    ok('the page still starts with storage blocked', threw === null, threw);
    eq('and falls back to the default', 
      w3.document.querySelector('details.grp[data-grp="keys"]').open, true);
    await sleep(25);
    w3.close();
  }


  // -------------------------------------------------------------- 21. the VFOs
  console.log('\nVFO tab');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    setFileOnInput(w, doc, 'file', 'vfo.icf',
      fs.readFileSync(path.join(WEB, 'th2000-backup-202608071325.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');
    $(doc, 'tabVfo').click();

    // two sub-tabs, matching the manufacturer's own A/B split
    {
      const subs = Array.from($(doc, 'panVfo').querySelectorAll('.subtabs button'))
        .map((b) => b.textContent.trim());
      eq('sub-tabs', subs.join('|'), 'VFO A (left)|VFO B (right)');
      ok('A holds the left pair',
        $(doc, 'subPanVfoA').contains($(doc, 'v_leftV_rx'))
        && $(doc, 'subPanVfoA').contains($(doc, 'v_leftU_rx')));
      ok('B holds the right pair',
        $(doc, 'subPanVfoB').contains($(doc, 'v_rightV_rx'))
        && $(doc, 'subPanVfoB').contains($(doc, 'v_rightU_rx')));
      ok('A is open first', $(doc, 'subPanVfoA').classList.contains('on'));
      // the fields the manufacturer's VFO window offers
      for (const f of ['signalling', 'busyLock', 'scrambler', 'dtmfPttId', 'rev', 'talk']) {
        ok('left VHF has ' + f, $(doc, 'v_leftV_' + f) !== null);
      }
      // every VFO field explains itself
      const bare = ['rx', 'tx', 'enc', 'dec', 'power', 'bandwidth', 'step',
                    'signalling', 'busyLock', 'scrambler', 'dtmfPttId', 'rev', 'talk']
        .filter((n) => {
          const box = $(doc, 'v_leftV_' + n);
          const f = box && box.closest('.f');
          return !(f && (f.getAttribute('title') || '').length > 20);
        });
      ok('and every one of them has hover help', bare.length === 0, bare.join(','));
      ok('the transmit box explains the offset difference',
        /direction and an offset/.test(
          $(doc, 'v_leftV_tx').closest('.f').getAttribute('title')));
    }

    // the four the radio actually uses, decoded from a real read
    eq('left VHF',  $(doc, 'v_leftV_rx').value,  '145.50000');
    eq('left UHF',  $(doc, 'v_leftU_rx').value,  '433.50000');
    eq('right VHF', $(doc, 'v_rightV_rx').value, '145.55000');
    eq('right UHF', $(doc, 'v_rightU_rx').value, '433.55000');
    eq('power reads through', $(doc, 'v_leftV_power').value, '0');
    eq('so does bandwidth', $(doc, 'v_leftV_bandwidth').value, '0');
    ok('the 220 MHz slots are not offered', $(doc, 'v_left220_rx') === null);
    ok('and the tab says why',
      /220/.test(txt(doc, 'panVfo')) && /no such band/.test(txt(doc, 'panVfo')),
      txt(doc, 'panVfo').slice(-160));
    eq('one Apply per VFO', doc.querySelectorAll('[data-vfo]').length, 4);

    // editing one must touch nothing else
    const before = new T.Codeplug(new Uint8Array(
      T.icfParse(fs.readFileSync(path.join(WEB, 'th2000-backup-202608071325.icf'),
        'latin1')).bytes));
    $(doc, 'v_leftV_rx').value = '145.5875';
    $(doc, 'v_leftV_tx').value = '145.5875';
    $(doc, 'v_leftV_power').value = '2';
    doc.querySelector('[data-vfo="leftV"]').click();
    ok('applying is reported', /VFO A \(left\) . VHF set/.test(txt(doc, 'msg')),
      txt(doc, 'msg'));
    eq('and reads back', $(doc, 'v_leftV_rx').value, '145.58750');
    eq('with the new power', $(doc, 'v_leftV_power').value, '2');
    ok('the other VFOs are untouched',
      $(doc, 'v_rightV_rx').value === '145.55000'
      && $(doc, 'v_leftU_rx').value === '433.50000');
    ok('the codeplug is marked unsaved', /Unsaved/.test(txt(doc, 'dirty')));

    // a bad frequency is refused rather than stored
    $(doc, 'v_rightU_rx').value = 'banana';
    $(doc, 'subVfoB').click();
    doc.querySelector('[data-vfo="rightU"]').click();
    ok('nonsense is refused', /should look like/.test(txt(doc, 'msg')), txt(doc, 'msg'));
    eq('and nothing changed', $(doc, 'v_rightU_rx').value, 'banana');

    // a VFO change must be spelled out in a comparison, not left as bytes
    {
      $(doc, 'btnViewChanges').click();
      await until(() => $(doc, 'scrim').classList.contains('on'), 3000, 'changes');
      const body = txt(doc, 'modalBody');
      ok('the comparison has a VFO section', /VFO/.test(body), body.slice(0, 200));
      ok('naming the one that moved, as the tabs name it',
        /VFO A \(left\)/.test(body), body.slice(0, 300));
      ok('and not the old wording', !/Left VFO,/.test(body));
      ok('with readable values', /145\.50000 MHz.*145\.58750 MHz/.test(
        body.replace(/\s+/g, ' ')), body.slice(0, 300));
      ok('and the power change too', /High.*Low/.test(body.replace(/\s+/g, ' ')));
      ok('not just a byte tally for the region',
        !/VFO records \(/.test(body), body);
      $(doc, 'modalCancel').click();
    }

    // a VFO edit must not be mistaken for a channel edit
    $(doc, 'tabChannel').click();
    ok('no channel appeared', !/145\.58750/.test($(doc, 'rows').textContent));
    w.close();
  }


  // -------------------------------------------- 22. sub-tabs stay independent
  console.log('\nsub-tabs are per panel');
  {
    const { doc, w } = await loadPage(makeFakePort(image, false));
    setFileOnInput(w, doc, 'file', 'vfo.icf',
      fs.readFileSync(path.join(WEB, 'th2000-backup-202608071325.icf'), 'latin1'));
    await until(() => /Opened/.test(txt(doc, 'msg')), 4000, 'load');

    // Channels starts on its first sub-tab
    $(doc, 'tabChannel').click();
    ok('the channel editor is showing', $(doc, 'subPanChannel').classList.contains('on'));

    // wander through the VFO sub-tabs, then come back
    $(doc, 'tabVfo').click();
    $(doc, 'subVfoB').click();
    ok('VFO B opens', $(doc, 'subPanVfoB').classList.contains('on'));
    ok('and VFO A closes', !$(doc, 'subPanVfoA').classList.contains('on'));

    $(doc, 'tabChannel').click();
    ok('the channel sub-tab is still selected',
      $(doc, 'subChannel').getAttribute('aria-selected') === 'true');
    ok('and its panel is still showing',
      $(doc, 'subPanChannel').classList.contains('on'),
      'the channels panel came back empty');

    // and the other way round
    $(doc, 'subBulk').click();
    $(doc, 'tabVfo').click();
    ok('VFO B is still where it was', $(doc, 'subPanVfoB').classList.contains('on'));
    $(doc, 'tabChannel').click();
    ok('and Bulk is still where it was', $(doc, 'subPanBulk').classList.contains('on'));

    // tab names are never cut short; the panel has a floor wide enough to hold
    // them, and they wrap rather than truncate if it is ever narrower
    const css = Array.from(doc.querySelectorAll('style'))
      .map((x) => x.textContent).join('').replace(/\s+/g, ' ');
    ok('a tab is never truncated',
      !/\.tabs button\{[^}]*text-overflow/.test(css),
      (css.match(/\.tabs button\{[^}]*\}/) || [''])[0]);
    ok('each tab is at least as wide as its name',
      /\.tabs button\{[^}]*min-width: ?max-content/.test(css));
    ok('each tab says what it holds',
      Array.from(doc.querySelectorAll('.tabs button'))
        .every((b) => (b.getAttribute('title') || '').length > 10));
    w.close();
  }

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
  if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nharness error:', e); process.exit(2); });
