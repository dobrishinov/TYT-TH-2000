/*
 * Node test for th2000-core.js.
 *
 * Cross-checks the JS against known-good values established during the
 * reverse engineering and against the OEM default codeplug. Includes a
 * loopback that runs the full read/write session against a simulated radio.
 *
 * Run: node th2000-core.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./th2000-core.js');

let pass = 0;
const fail = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail.push(name); console.log('  FAIL ' + name + (detail ? '  ->  ' + detail : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got ' + g + ' want ' + w);
}

// ------------------------------------------------------------------ framing

console.log('\nframing');

// The handshake frame, verified against the Python implementation:
// "2000" = 32 30 30 30, biased by 0x80 -> B2 B0 B0 B0, checksum C2 -> 42
eq('handshake frame',
  T.hex(T.buildFrame(T.OP.HANDSHAKE, T.MODEL_ID, false)),
  'FE FE EE EF E0 B2 B0 B0 B0 42 FD');

eq('read block 0 length 512',
  T.hex(T.buildFrame(T.OP.READ_BLOCK, [...T.be32(0), ...T.be16(512)], false)),
  'FE FE EE EF EB 80 80 80 80 82 80 82 FD');

let allRoundTrip = true, leaks = false;
for (let b = 0; b < 256; b++) {
  const back = T.unstuff(T.stuff([b]));
  if (back.length !== 1 || back[0] !== b) allRoundTrip = false;
}
for (const v of T.stuff(Array.from({ length: 256 }, (_, i) => i))) {
  if (v >= 0xFA && v !== 0xFF) leaks = true;
  if (v === T.END) leaks = true;
}
ok('stuffing round-trips all 256 byte values', allRoundTrip);
ok('stuffing never emits FA-FE', !leaks);

// A synthetic radio reply parses and validates
{
  const payload = [...T.be32(0), ...T.be16(512)];
  for (let i = 0; i < 512; i++) payload.push(i & 0xFF);
  const body = T.stuff([...payload, T.checksumAdditive(payload)]);
  const frame = Uint8Array.from([...T.HDR_RX, T.OP.DATA, ...body, T.END]);
  const parsed = T.parseFrame(frame, false);
  eq('reply opcode', parsed.opcode, T.OP.DATA);
  eq('reply payload length', parsed.payload.length, 518);
  ok('reply payload intact', parsed.payload.every((b, i) => b === payload[i]));
}

// Corruption is caught rather than silently accepted
{
  const good = T.buildFrame(T.OP.HANDSHAKE, T.MODEL_ID, false);
  const bad = Uint8Array.from(good);
  bad[0] = 0xFE; bad[2] = 0xEF; bad[3] = 0xEE;   // make it look like an RX frame
  bad[6] ^= 0x01;                                // then corrupt a payload byte
  let threw = false;
  try { T.parseFrame(bad, false); } catch (e) { threw = /Checksum/.test(e.message); }
  ok('bad checksum is rejected', threw);
}

eq('legacy checksum is two\'s complement', T.checksumTwos([0x01, 0x02]), 253);
eq('legacy checksum of zero stays zero', T.checksumTwos([0x00]), 0);

// --------------------------------------------------------------- block plan

console.log('\nblock plan');
const plan = T.blockPlan();
eq('block count', plan.length, 22);
eq('final block is short', plan[21], { addr: 0x2A00, len: 384 });
eq('blocks cover the codeplug exactly',
  plan.reduce((n, b) => n + b.len, 0), T.MEM_SIZE);

// ------------------------------------------------------------------- tones

console.log('\ntones');
eq('CTCSS 88.5 encodes to 0x375', T.parseTone('88.5').word, 0x375);
eq('DCS 023 encodes to 0x13', T.parseTone('D023').word, 0x13);
eq('DCS inverted flag', T.parseTone('D023I').inverted, true);
eq('off', T.parseTone('off').word, T.TONE_OFF);
eq('label CTCSS', T.toneLabel(0x375, false), '88.5');
eq('label DCS normal', T.toneLabel(0x13, false), 'D023N');
eq('label DCS inverted', T.toneLabel(0x13, true), 'D023I');
eq('label off', T.toneLabel(T.TONE_OFF, false), 'off');
ok('nonsense tone is rejected', T.parseTone('banana') === null);
ok('out of range CTCSS is rejected', T.parseTone('9.9') === null);
ok('DCS digit 8 is rejected as non-octal', T.parseTone('D089') === null);
eq('a zero tone slot reads as off', T.toneLabel(0, false), 'off');
eq('and parses back to the off sentinel', T.parseTone(T.toneLabel(0, false)).word, T.TONE_OFF);
ok('DCS 000 is not a code', T.parseTone('D000') === null);
{
  // label -> parse -> label must be stable for every representable value
  let unstable = [];
  for (let v = 0; v <= 0x0FFF; v++) {
    const label = T.toneLabel(v, false);
    const back = T.parseTone(label);
    if (!back) { unstable.push(v); continue; }
    if (T.toneLabel(back.word, false) !== label) unstable.push(v);
  }
  ok('every tone value survives label -> parse -> label',
    unstable.length === 0, unstable.length + ' unstable, first: ' + unstable.slice(0, 6));
}

{
  const blank = new T.Codeplug(new Uint8Array(T.MEM_SIZE));
  eq('a zeroed codeplug reports no band limits', blank.bandLimits().filter(Boolean).length, 0);
  ok('so nothing is flagged out of band', blank.inBand(145500000));
  eq('and every channel is free', blank.channels().filter((c) => c.used).length, 0);
}

// ---------------------------------------------------------------- codeplug

console.log('\ncodeplug against the OEM default file');
const icfPath = path.join(__dirname, 'DefaulFile.icf');
if (!fs.existsSync(icfPath)) {
  console.log('  SKIP DefaulFile.icf not next to this test');
} else {
  const parsed = T.icfParse(fs.readFileSync(icfPath, 'latin1'));
  eq('icf record count', parsed.records, 392);
  eq('icf coverage', parsed.coverage, 0x3100);
  eq('icf header baud', parsed.header.baud, '38400');

  const cp = new T.Codeplug(parsed.bytes);
  eq('power-on name', cp.powerOnName, 'UV8800');
  eq('band label', cp.bandLabel, '400-480');
  const bands = cp.bandLimits().filter(Boolean).map((b) => [b.lo / 1e6, b.hi / 1e6]);
  eq('band slots', bands, [[108, 174], [108, 174], [400, 480], [400, 480]]);

  const used = cp.channels().filter((c) => c.used);
  eq('channels in use', used.length, 1);
  eq('channel 1 rx', used[0].rxHz, 435300000);
  eq('channel 1 not skipped', used[0].skip, false);
  eq('channel 1 step index', used[0].step, 3);

  // edit, write back, read again
  const c = cp.getChannel(4);
  Object.assign(c, {
    used: true, rxHz: 145500000, txHz: 145500000, name: 'PLOVDIV',
    txTone: T.parseTone('88.5').word, rxTone: T.parseTone('D023').word,
    rxInv: true, power: 0, bandwidth: 2, step: 4, scrambler: 3, sqlMode: 1,
    skip: true
  });
  cp.setChannel(c);
  const b = cp.getChannel(4);
  eq('edited rx', b.rxHz, 145500000);
  eq('edited name', b.name, 'PLOVDIV');
  eq('edited encode tone', T.toneLabel(b.txTone, b.txInv), '88.5');
  eq('edited decode tone', T.toneLabel(b.rxTone, b.rxInv), 'D023I');
  eq('edited scrambler', b.scrambler, 3);
  eq('edited bandwidth', b.bandwidth, 2);
  eq('edited step', b.step, 4);
  eq('edited squelch mode', b.sqlMode, 1);
  eq('edited skip', b.skip, true);

  // The exact bytes the Python reference produced for this same edit
  const o = 4 * T.CHAN_REC;
  eq('raw record matches the python reference',
    T.hex(cp.data.subarray(o, o + T.CHAN_REC)),
    'F0 03 DE 00 F0 03 DE 00 13 30 75 43 20 24 04 50 4C 4F 56 44 49');

  // setChannel never blanks - an unused channel keeps its record bytes,
  // exactly as a real radio stores them
  const keep = cp.getChannel(4);
  keep.used = false;
  cp.setChannel(keep);
  eq('marking a channel unused clears only the bitmap', cp.getChannel(4).used, false);
  eq('...and leaves the record intact', cp.getChannel(4).name, 'PLOVDIV');
  eq('...and leaves the frequency intact', cp.getChannel(4).rxHz, 145500000);

  // deleting is explicit
  cp.setChannel(Object.assign(cp.getChannel(4), { used: true }));
  cp.clearChannel(4);
  eq('clearChannel marks it unused', cp.getChannel(4).used, false);
  eq('clearChannel blanks the name', cp.getChannel(4).name, '');
  ok('clearChannel blanks the record',
    Array.from(cp.data.subarray(4 * T.CHAN_REC, 4 * T.CHAN_REC + 15))
      .every((b) => b === 0xFF));

  // the undocumented bit 13 survives a round trip
  {
    const probe = new T.Codeplug(cp.data.slice());
    const o = 7 * T.CHAN_REC;
    probe.data[o + 10] = 0x75; probe.data[o + 11] = 0x23;   // bit 13 + 88.5
    const c13 = probe.getChannel(7);
    eq('bit 13 is read', c13.unknown13, true);
    probe.setChannel(c13);
    eq('bit 13 is written back', probe.data[o + 11], 0x23);
  }

  // icf serialise round-trip
  const text = T.icfSerialize(cp.data, parsed.header);
  const again = T.icfParse(text);
  ok('icf round-trip is byte identical',
    again.bytes.length >= T.MEM_SIZE
    && Array.from(cp.data).every((v, i) => v === again.bytes[i]));

  // malformed input is reported, not swallowed
  let threw = '';
  try { T.icfParse('COM1\n#x\n38400\nZZZZZZ\n'); } catch (e) { threw = e.message; }
  ok('malformed icf line is reported', /Unexpected characters/.test(threw), threw);
  threw = '';
  try { T.icfParse('COM1\n'); } catch (e) { threw = e.message; }
  ok('short icf file is reported', /too few lines/.test(threw), threw);
}

// ------------------------------------------------------------------- csv

console.log('\ncsv');
{
  const real = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);
  // give it some content worth exporting
  const mk = (i, name, rx, tx, enc, dec, extra) => {
    const c = real.getChannel(i);
    Object.assign(c, { used: true, name: name, rxHz: rx, txHz: tx,
      txTone: T.parseTone(enc).word, txInv: T.parseTone(enc).inverted,
      rxTone: T.parseTone(dec).word, rxInv: T.parseTone(dec).inverted }, extra || {});
    real.setChannel(c);
  };
  mk(0, 'R70 PLOVDIV', 145600000, 145000000, '88.5', '88.5', { power: 0, bandwidth: 0, step: 4 });
  mk(1, 'SIMPLEX', 145500000, 145500000, 'off', 'off', { power: 2, bandwidth: 2, step: 4, skip: true });
  mk(2, 'DCS TEST', 433500000, 433500000, 'D023I', 'D754', { power: 1, step: 5, scrambler: 3, sqlMode: 1 });
  mk(3, 'RX ONLY', 446000000, 0xFFFFFFFF * 10, 'off', 'off', {});

  const csv = T.csvSerialize(real);
  const lines = csv.trim().split('\r\n');
  eq('header row', lines[0], T.CSV_COLUMNS.join(','));
  eq('one row per used channel', lines.length - 1, 4);
  ok('name with a space survives unquoted', /R70 PLOVDIV/.test(lines[1]));
  ok('receive-only exports as off', /,off,/.test(lines[4]), lines[4]);
  ok('inverted DCS exports', /D023I/.test(lines[3]), lines[3]);

  // round trip: export, re-import into a blank codeplug, compare fields
  const back = T.csvParse(csv);
  eq('re-import has no errors', back.errors, []);
  eq('re-import channel count', back.channels.length, 4);
  const fresh = new T.Codeplug(real.data.slice());
  for (let i = 0; i < T.CHAN_NUM; i++) fresh.clearChannel(i);
  back.channels.forEach((c) => fresh.setChannel(c));
  let same = true, firstBad = null;
  for (const i of [0, 1, 2, 3]) {
    const a = real.getChannel(i), b = fresh.getChannel(i);
    for (const k of ['name', 'rxHz', 'txHz', 'txTone', 'rxTone', 'txInv', 'rxInv',
                     'power', 'bandwidth', 'step', 'skip', 'scrambler', 'sqlMode']) {
      if (a[k] !== b[k]) { same = false; firstBad = firstBad || (i + '.' + k + ' ' + a[k] + ' vs ' + b[k]); }
    }
  }
  ok('every exported field survives a csv round trip', same, firstBad);

  // tolerant headers, reordered columns, missing optional columns
  const hand = 'name,rx freq,TX,Tone\nHOME,145.500,145.500,88.5\nWORK,433.100,,\n';
  const r2 = T.csvParse(hand);
  eq('hand-written csv parses', r2.errors, []);
  eq('hand-written row count', r2.channels.length, 2);
  eq('auto-numbered from 1', r2.channels[0].index, 0);
  eq('blank tx defaults to rx', r2.channels[1].txHz, r2.channels[1].rxHz);
  eq('tone column read as encode', T.toneLabel(r2.channels[0].txTone, false), '88.5');

  // errors are reported with line numbers and nothing is applied
  const bad = 'Channel,RX MHz\n1,145.500\n1,146.000\n5,banana\n999,145.000\n';
  const r3 = T.csvParse(bad);
  eq('three bad rows caught', r3.errors.length, 3);
  ok('duplicate channel flagged', /more than once/.test(r3.errors[0].message), r3.errors[0].message);
  ok('bad frequency flagged', /not a number of MHz/.test(r3.errors[1].message));
  ok('out-of-range channel flagged', /outside 1-200/.test(r3.errors[2].message));
  ok('line numbers are 1-based and match the file',
    r3.errors.map((e) => e.line).join(',') === '3,4,5', r3.errors.map((e) => e.line).join(','));

  const noRx = T.csvParse('Name,Comment\nfoo,bar\n');
  ok('a file with no frequency column is rejected clearly',
    /no receive-frequency column/.test(noRx.errors[0].message));

  const quoted = T.csvParse('Channel,Name,RX MHz\n1,"HOME, MAIN",145.500\n');
  eq('quoted field with a comma', quoted.channels[0].name, 'HOME, MAIN');
}

// ------------------------------------------------------------------ diff

console.log('\ndiff');
{
  const base = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);
  const next = new T.Codeplug(base.data.slice());
  eq('identical codeplugs differ in nothing', T.diffCodeplugs(base, next).bytes, 0);

  const c = next.getChannel(0);
  c.rxHz = 435100000; c.name = 'CHANGED';
  next.setChannel(c);
  const add = next.getChannel(9);
  Object.assign(add, { used: true, rxHz: 145500000, txHz: 145500000, name: 'NEW' });
  next.setChannel(add);
  next.powerOnName = 'HELLO';

  const d = T.diffCodeplugs(base, next);
  ok('byte count is reported', d.bytes > 0);
  const changed = d.channels.find((x) => x.index === 0);
  eq('channel 1 marked changed', changed.kind, 'changed');
  ok('the changed fields are named',
    changed.fields.map((f) => f.label).sort().join(',') === 'Name,Receive',
    changed.fields.map((f) => f.label).join(','));
  eq('field values are human readable', changed.fields.find((f) => f.key === 'rxHz').to, '435.10000 MHz');
  eq('channel 10 marked added', d.channels.find((x) => x.index === 9).kind, 'added');
  ok('the power-on name region is listed',
    d.regions.some((r) => /power-on/.test(r.name)), d.regions.map((r) => r.name).join(','));

  // settings and FM are decoded too, not left as raw bytes
  {
    const other = new T.Codeplug(base.data.slice());
    other.setSetting('light', 3);
    other.setSetting('p1Short', 13);
    other.setPassword('123456');
    other.setIntroLine(2, 'HELLO');
    other.setFmPreset(0, 101700000, true);
    other.setFmVfo(99900000);
    const sd = T.diffCodeplugs(base, other);
    const byLabel = Object.fromEntries(sd.settings.map((x) => [x.label, x]));
    eq('backlight change is readable', [byLabel['Backlight'].from, byLabel['Backlight'].to], ['7', '3']);
    eq('key assignment uses its name', byLabel['P1 short'].to, 'Frequency Reverse');
    eq('password change is shown', byLabel['Boot-strap password'].to, '123456');
    ok('intro line change is shown', !!byLabel['Intro line 2']);
    eq('fm preset change', sd.fm[0].to, '101.70 MHz');
    ok('and the vfo', sd.fm.some((x) => x.label === 'FM VFO'));
    eq('an unchanged pair reports no settings differences',
      T.diffCodeplugs(base, new T.Codeplug(base.data.slice())).settings.length, 0);
  }

  // bytes moving inside slots that are unused on both sides are counted, so
  // the summary can account for its own byte total
  {
    const poke = new T.Codeplug(base.data.slice());
    const o = 5 * T.CHAN_REC;
    ok('slot 6 is unused to begin with', !poke.getChannel(5).used);
    poke.data[o] ^= 0xFF;
    const pd = T.diffCodeplugs(base, poke);
    eq('no channel is reported added, changed or removed', pd.channels.length, 0);
    eq('but the empty slot is counted', pd.emptySlots, 1);
    ok('and the byte count is not zero', pd.bytes > 0);
    eq('an identical pair reports none', T.diffCodeplugs(base, new T.Codeplug(base.data.slice())).emptySlots, 0);
  }

  const gone = new T.Codeplug(base.data.slice());
  gone.clearChannel(0);
  eq('removed channel detected', T.diffCodeplugs(base, gone).channels[0].kind, 'removed');
}

// ------------------------------------------------------------ validation

console.log('\nvalidation');
{
  const cp = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);
  const set = (i, patch) => { const c = cp.getChannel(i); Object.assign(c, { used: true }, patch); cp.setChannel(c); };
  set(0, { rxHz: 145500000, txHz: 145500000, step: 4 });          // clean
  set(1, { rxHz: 300000000, txHz: 300000000, step: 4 });          // out of band
  set(2, { rxHz: 145500000, txHz: 145500000, step: 4 });          // duplicate of ch1
  set(3, { rxHz: 145501230, txHz: 145501230, step: 4 });          // off-step
  const v = T.validate(cp);
  ok('out-of-band transmit is an error',
    v.some((x) => x.index === 1 && x.level === 'error' && /transmits on/.test(x.message)));
  ok('out-of-band receive is a warning',
    v.some((x) => x.index === 1 && x.level === 'warning' && /receives on/.test(x.message)));
  ok('duplicate channel flagged', v.some((x) => x.index === 2 && /duplicates channel 1/.test(x.message)));
  ok('off-step frequency flagged', v.some((x) => x.index === 3 && /multiple of its 12.5 kHz step/.test(x.message)));
  ok('the clean channel raises nothing', !v.some((x) => x.index === 0));
}

// ------------------------------------------------------- bulk operations

console.log('\nbulk operations');
{
  const cp = new T.Codeplug(new Uint8Array(T.MEM_SIZE));
  for (let i = 0; i < 10; i++) {
    cp.setChannel(Object.assign(cp.getChannel(i), {
      used: true, rxHz: 145000000 + i * 25000, txHz: 145000000 + i * 25000,
      name: 'CH' + (i + 1), power: 0, bandwidth: 0
    }));
  }
  eq('apply to a range', T.applyToRange(cp, 2, 5, { power: 2, bandwidth: 2 }), 4);
  eq('field applied', cp.getChannel(3).power, 2);
  ok('outside the range untouched', cp.getChannel(1).power === 0 && cp.getChannel(6).power === 0);

  eq('find and replace in names', T.renameRange(cp, 0, 9, 'CH', 'RPT'), 10);
  eq('renamed', cp.getChannel(0).name, 'RPT1');

  // a range that is mostly empty must not blank the destination
  {
    const wide = new T.Codeplug(cp.data.slice());
    const before = wide.data.slice();
    const moved = T.copyRange(wide, 0, 199, 30);
    eq('copying a mostly empty range touches only the real channels', moved, 10);
    const untouched = [];
    for (let i = 41; i < 200; i++) {
      const o = i * T.CHAN_REC;
      for (let k = 0; k < T.CHAN_REC; k++) {
        if (before[o + k] !== wide.data[o + k]) { untouched.push(i); break; }
      }
    }
    ok('and leaves every empty slot exactly as it was', untouched.length === 0,
      'slots changed: ' + untouched.slice(0, 6).join(','));
  }

  eq('copy a block', T.copyRange(cp, 0, 2, 20), 3);
  eq('copy landed', cp.getChannel(20).name, 'RPT1');
  ok('source still there after copy', cp.getChannel(0).used);

  eq('move a block', T.moveRange(cp, 0, 2, 30), 3);
  eq('move landed', cp.getChannel(30).name, 'RPT1');
  ok('source cleared after move', !cp.getChannel(0).used);

  eq('delete a range', T.deleteRange(cp, 30, 32), 3);
  ok('deleted', !cp.getChannel(30).used);

  const before = cp.channels().filter((c) => c.used).length;
  eq('compact keeps every channel', T.compact(cp), before);
  const after = cp.channels().filter((c) => c.used);
  ok('compact leaves no gaps', after.every((c, k) => c.index === k),
    after.map((c) => c.index).join(','));
}

// ------------------------------------------------------------------- fm

console.log('\nfm broadcast presets');
{
  const cp = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);
  const p = cp.fmPresets();
  eq('preset count', p.length, 32);
  eq('factory preset 1 reads 90.4 MHz', p[0].hz, 90400000);
  eq('fm vfo reads 90.6 MHz', cp.fmVfo(), 90600000);
  cp.setFmPreset(0, 101700000, true);
  eq('preset written back', cp.fmPresets()[0].hz, 101700000);
  ok('preset enable bit set', cp.fmPresets()[0].enabled);
  cp.setFmVfo(99900000);
  eq('vfo written back', cp.fmVfo(), 99900000);
}

// ------------------------------------------------------------- bit diff

console.log('\nbit-level diff');
{
  const a = new T.Codeplug(new Uint8Array(T.MEM_SIZE));
  const b = new T.Codeplug(a.data.slice());
  a.data[0x2020] = 0x31; b.data[0x2020] = 0x33;      // one bit
  a.data[0x2030] = 0x00; b.data[0x2030] = 0xE0;      // a 3-bit field
  a.data[0x0000] = 0x00; b.data[0x0000] = 0x01;      // a channel byte

  const all = T.diffBits(a, b);
  eq('every changed byte is found', all.length, 3);
  const settings = T.diffBits(a, b, { skipChannels: true });
  eq('channel bytes can be filtered out', settings.length, 2);

  eq('region is named', settings[0].region, 'global settings');
  eq('single bit reported', settings[0].bitText, 'bit 1');
  eq('consecutive bits collapse to a range', settings[1].bitText, 'bits 5-7');
  eq('the field value before', settings[1].fieldFrom, 0);
  eq('the field value after', settings[1].fieldTo, 7);

  eq('bitRuns handles a gap', T.bitRuns([0, 1, 4]), 'bits 0-1, bit 4');
  eq('binary is grouped in nibbles', T.bin8(0xE0), '1110 0000');

  const txt = T.formatBitDiff(settings);
  ok('the text output has a header', /addr\s+off\s+region/.test(txt));
  ok('and shows the settings offset', /\+16/.test(txt), txt);
  ok('and shows before and after in binary', /0000 0000  E0 1110 0000/.test(txt), txt);
  eq('nothing to report reads plainly', T.formatBitDiff([]), 'no byte differences');

  eq('addresses outside the map are labelled', T.regionOf(0x3000), 'outside the codeplug');
  eq('the settings block is named', T.regionOf(0x2025), 'global settings');
}

// -------------------------------------------------------- radio settings

console.log('\nradio settings');
{
  const cp = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);

  // decoded values, cross-checked against the mapping session
  eq('backlight', cp.getSetting('light'), 7);
  eq('squelch level', cp.getSetting('sql'), 3);
  eq('time-out timer is off', cp.getSetting('tot'), 0);
  eq('P1 short is KEY-Low', T.KEY_FN[cp.getSetting('p1Short')], 'KEY-Low');
  eq('P2 short is KEY-MHZ', T.KEY_FN[cp.getSetting('p2Short')], 'KEY-MHZ');
  eq('P5 long is unassigned', T.KEY_FN[cp.getSetting('p5Long')], 'None');
  eq('password', cp.getPassword(), '000000');
  eq('intro line 1', cp.introLine(1), 'TH-2000');
  eq('intro line 2', cp.introLine(2), '  136/400');

  // the two encodings that differ, which is the whole reason for measuring
  const before = cp.data[T.ADDR_SETTINGS + 20];
  cp.setSetting('light', 2);
  eq('backlight stores one less than it shows', cp.data[T.ADDR_SETTINGS + 20] & 0x07, 1);
  eq('and reads back as shown', cp.getSetting('light'), 2);
  ok('and leaves the rest of that byte alone',
    (cp.data[T.ADDR_SETTINGS + 20] & 0xF8) === (before & 0xF8));

  cp.setSetting('volume', 31);
  eq('volume stores the number itself', cp.data[T.ADDR_SETTINGS + 3] & 0x1F, 31);
  eq('and reads back', cp.getSetting('volume'), 31);

  // writing one nibble must not disturb its neighbour
  cp.setSetting('p1Short', 13);
  eq('P1 short written', cp.getSetting('p1Short'), 13);
  eq('P2 short untouched', T.KEY_FN[cp.getSetting('p2Short')], 'KEY-MHZ');
  cp.setSetting('p2Short', 0);
  eq('P2 short written', cp.getSetting('p2Short'), 0);
  eq('P1 short still 13', cp.getSetting('p1Short'), 13);

  // out of range is refused rather than silently truncated
  let threw = '';
  try { cp.setSetting('sql', 16); } catch (e) { threw = e.message; }
  ok('a value too wide for the field is refused', /does not fit in 4 bits/.test(threw), threw);
  threw = '';
  try { cp.getSetting('nonesuch'); } catch (e) { threw = e.message; }
  ok('an unknown setting is refused', /unknown setting/.test(threw));

  // every mapped field round-trips through its own accessor
  const fresh = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);
  let bad = [];
  for (const f of T.SETTINGS_FIELDS) {
    const max = f.kind === 'num' ? f.max : f.list.length - 1;
    for (const v of [f.kind === 'num' ? f.min : 0, max]) {
      fresh.setSetting(f.key, v);
      if (fresh.getSetting(f.key) !== v) bad.push(f.key + '=' + v);
    }
  }
  ok('every field round-trips at both ends of its range', bad.length === 0, bad.join(','));

  // and nothing outside the mapped bits ever moves
  const orig = new T.Codeplug(T.icfParse(fs.readFileSync(
    path.join(__dirname, 'ORIGIN_BACKUP_ConFile.icf'), 'latin1')).bytes);
  const work = new T.Codeplug(orig.data.slice());
  for (const f of T.SETTINGS_FIELDS) work.setSetting(f.key, work.getSetting(f.key));
  work.setPassword(work.getPassword());
  let moved = [];
  for (let i = 0; i < T.MEM_SIZE; i++) if (orig.data[i] !== work.data[i]) moved.push(i);
  ok('writing every setting back unchanged moves nothing', moved.length === 0,
    moved.map((i) => '0x' + i.toString(16)).join(','));

  // the unmapped bytes are untouched even when everything is rewritten
  const w2 = new T.Codeplug(orig.data.slice());
  for (const f of T.SETTINGS_FIELDS) w2.setSetting(f.key, f.kind === 'num' ? f.min : 0);
  const gaps = [4, 5, 6, 7, 8, 9, 10, 11, 17, 19, 21];
  ok('the eleven unmapped bytes are never written',
    gaps.every((g) => w2.data[T.ADDR_SETTINGS + g] === orig.data[T.ADDR_SETTINGS + g]),
    gaps.filter((g) => w2.data[T.ADDR_SETTINGS + g] !== orig.data[T.ADDR_SETTINGS + g]).join(','));

  eq('password writes six ascii digits', (() => {
    const c = new T.Codeplug(orig.data.slice());
    c.setPassword('123456');
    return Array.from(c.data.subarray(T.ADDR_SETTINGS + 26, T.ADDR_SETTINGS + 32))
      .map((b) => String.fromCharCode(b)).join('');
  })(), '123456');

  eq('P5 long is marked read-only',
    !!T.SETTINGS_FIELDS.find((f) => f.key === 'p5Long').readOnly, true);
}

// ------------------------------------------------------ chirp csv interop

console.log('\nCHIRP CSV import');
{
  // CHIRP's export uses its own column names and writes power as a wattage,
  // because it converts through its generic power levels on the way out.
  const chirpCsv = [
    'Location,Name,Frequency,Duplex,Offset,Tone,rToneFreq,cToneFreq,DtcsCode,'
      + 'DtcsPolarity,RxDtcsCode,CrossMode,Mode,TStep,Skip,Power,Comment',
    '1,R70,145.600000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,25W,',
    '2,NARROW,438.650000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,NFM,5.00,S,10W,',
    '3,LOW,144.800000,,0.000000,,88.5,88.5,023,NN,023,Tone->Tone,FM,5.00,,5W,'
  ].join('\r\n');
  const r = T.csvParse(chirpCsv);
  eq('CHIRP column names are understood', r.channels.length, 3);
  eq('with no errors', r.errors.length, 0);
  eq('Location becomes the channel number', r.channels[0].index, 0);
  eq('Frequency becomes receive', r.channels[0].rxHz, 145600000);
  eq('Name carries over', r.channels[0].name, 'R70');
  eq('25W maps to High', T.POWER[r.channels[0].power], 'High');
  eq('10W maps to Mid', T.POWER[r.channels[1].power], 'Mid');
  eq('5W maps to Low', T.POWER[r.channels[2].power], 'Low');
  eq('NFM becomes narrow', T.BANDWIDTH[r.channels[1].bandwidth], 'Narrow');
  eq('Skip is honoured', r.channels[1].skip, true);
  eq('and absent Skip means include', r.channels[0].skip, false);

  // a wattage nothing matches exactly still picks the nearest level
  const near = T.csvParse('Location,Frequency,Power\r\n1,145.500,20W');
  eq('an unfamiliar wattage picks the nearest level',
    T.POWER[near.channels[0].power], 'High');

  // and the friendly names still work
  const named = T.csvParse('Channel,RX MHz,Power\r\n1,145.500,Low');
  eq('High/Mid/Low still work', T.POWER[named.channels[0].power], 'Low');
  const bad = T.csvParse('Channel,RX MHz,Power\r\n1,145.500,banana');
  ok('and nonsense is still refused', bad.errors.length === 1
    && /wattage such as 25W/.test(bad.errors[0].message), bad.errors[0].message);
}

// ------------------------------------------------------- label consistency

console.log('\nlabel consistency');
{
  // Channel field names and settings labels appear in the same list in a
  // comparison. They were written weeks apart and drifted into different
  // cases, which reads as an accident because it was one.
  const chan = Object.values(T.FIELD_LABELS);
  const sett = T.SETTINGS_FIELDS.map((f) => f.label);
  const lower = chan.concat(sett).filter((v) => /^[a-z]/.test(v));
  ok('every label in a diff starts with a capital', lower.length === 0, lower.join(', '));
  // acronyms like DTMF, LED, RX and TX are meant to be capitalised
}

// -------------------------------------------------------------- loopback

console.log('\nsession loopback against a simulated radio');

function simulate(image, legacy) {
  const radio = {
    image: Uint8Array.from(image), mode: null,
    served: 0, written: 0
  };
  radio.exchange = (frame) => {
    const { opcode, payload } = (() => {
      // parse a PC->radio frame
      const mid = frame.slice(5, frame.length - 1);
      const body = legacy ? mid : T.unstuff(mid);
      const p = body.slice(0, body.length - 1);
      const sum = legacy ? T.checksumTwos(p) : T.checksumAdditive(p);
      if (body[body.length - 1] !== sum) throw new Error('PC sent a bad checksum');
      return { opcode: frame[4], payload: p };
    })();
    const reply = (op, pl) => {
      const s = legacy ? T.checksumTwos(pl) : T.checksumAdditive(pl);
      const body = legacy ? Uint8Array.from([...pl, s]) : T.stuff([...pl, s]);
      return Uint8Array.from([...T.HDR_RX, op, ...body, T.END]);
    };
    const rd32 = (o) => (payload[o] << 24 | payload[o + 1] << 16
      | payload[o + 2] << 8 | payload[o + 3]) >>> 0;
    const rd16 = (o) => payload[o] << 8 | payload[o + 1];

    switch (opcode) {
      case T.OP.HANDSHAKE:
        return reply(T.OP.HANDSHAKE_ACK, T.MODEL_ID);
      case T.OP.ENTER_READ:
      case T.OP.ENTER_WRITE:
        if (rd32(0) !== 0 || rd32(4) !== T.MEM_SIZE) throw new Error('bad range');
        radio.mode = opcode;
        return reply(T.OP.ACK, [0x00]);
      case T.OP.READ_BLOCK: {
        if (radio.mode !== T.OP.ENTER_READ) throw new Error('read outside read mode');
        const a = rd32(0), n = rd16(4);
        radio.served++;
        return reply(T.OP.DATA, [...T.be32(a), ...T.be16(n),
          ...radio.image.subarray(a, a + n)]);
      }
      case T.OP.DATA: {
        if (radio.mode !== T.OP.ENTER_WRITE) throw new Error('write outside write mode');
        const a = rd32(0), n = rd16(4);
        radio.image.set(payload.subarray(6, 6 + n), a);
        radio.written++;
        return reply(T.OP.ACK, [0x00]);
      }
      case T.OP.END:
        radio.mode = null;
        return reply(T.OP.ACK, [0x00]);
      default:
        throw new Error('unexpected opcode ' + T.hx(opcode));
    }
  };
  return radio;
}

function session(radio, legacy, imageToWrite) {
  const send = (op, pl) => T.parseFrame(radio.exchange(T.buildFrame(op, pl, legacy)), legacy);

  const id = send(T.OP.HANDSHAKE, T.MODEL_ID);
  if (id.opcode !== T.OP.HANDSHAKE_ACK) throw new Error('no handshake ack');

  if (imageToWrite) {
    send(T.OP.ENTER_WRITE, [...T.be32(0), ...T.be32(T.MEM_SIZE)]);
    for (const blk of T.blockPlan()) {
      const r = send(T.OP.DATA, [...T.be32(blk.addr), ...T.be16(blk.len),
        ...imageToWrite.subarray(blk.addr, blk.addr + blk.len)]);
      if (r.opcode !== T.OP.ACK) throw new Error('no ack for block');
    }
    send(T.OP.END, T.MODEL_ID);
    return null;
  }

  send(T.OP.ENTER_READ, [...T.be32(0), ...T.be32(T.MEM_SIZE)]);
  const out = new Uint8Array(T.MEM_SIZE);
  for (const blk of T.blockPlan()) {
    const r = send(T.OP.READ_BLOCK, [...T.be32(blk.addr), ...T.be16(blk.len)]);
    if (r.opcode !== T.OP.DATA) throw new Error('no data for block');
    out.set(r.payload.subarray(6, 6 + blk.len), blk.addr);
  }
  send(T.OP.END, T.MODEL_ID);
  return out;
}

for (const legacy of [false, true]) {
  const label = legacy ? 'legacy framing' : 'stuffed framing';
  const original = new Uint8Array(T.MEM_SIZE);
  for (let i = 0; i < T.MEM_SIZE; i++) original[i] = (i * 7 + (i >> 8)) & 0xFF;

  const r1 = simulate(original, legacy);
  const got = session(r1, legacy, null);
  ok(label + ': download matches radio contents',
    got.every((b, i) => b === original[i]));
  eq(label + ': blocks served', r1.served, 22);

  const r2 = simulate(new Uint8Array(T.MEM_SIZE), legacy);
  session(r2, legacy, original);
  ok(label + ': upload lands byte for byte',
    r2.image.every((b, i) => b === original[i]));
  eq(label + ': blocks written', r2.written, 22);
}

// -------------------------------------------------------------------- done

console.log('\n' + pass + ' passed, ' + fail.length + ' failed');
if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1); }
