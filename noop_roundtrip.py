#!/usr/bin/env python3
# Copyright 2026 Georgi Dobrishinov (LZ1WOW)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
noop_roundtrip.py - the same codeplug, read and written back unchanged, through
every implementation. All three must change zero bytes.

This is the test that catches "my field model is incomplete": any bit the model
does not carry between read and write shows up here as a changed byte. It runs
against a real radio image rather than a synthetic one, because the interesting
bits are the ones a factory sets and I never thought to model.

Run: python3 noop_roundtrip.py [image.icf]
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, 'chirp'))

DEFAULT_IMAGE = os.path.join(HERE, 'web', 'ORIGIN_BACKUP_ConFile.icf')

results = []


def report(name, changed, detail=''):
    ok = changed == 0
    results.append((name, ok))
    print('  %-34s %s  (%d byte%s changed)%s'
          % (name, 'ok  ' if ok else 'FAIL', changed,
             '' if changed == 1 else 's', detail))


def describe(diffs, orig, after, limit=6):
    if not diffs:
        return ''
    bits = []
    for i in diffs[:limit]:
        where = ('channel %d byte %d' % (i // 21 + 1, i % 21)) if i < 0x1140 \
                else '0x%04X' % i
        bits.append('%s: %02X->%02X' % (where, orig[i], after[i]))
    more = '' if len(diffs) <= limit else ' ...+%d' % (len(diffs) - limit)
    return '\n        ' + '; '.join(bits) + more


def run_python(path):
    import th2000 as t
    _, cp = t.icf_load(path)
    orig = bytes(cp.data[:t.CODEPLUG_SIZE])
    work = t.Codeplug(orig)
    for i in range(t.CHANNEL_COUNT):
        work.set_channel(work.channel(i))
    after = bytes(work.data[:t.CODEPLUG_SIZE])
    diffs = [i for i in range(len(orig)) if orig[i] != after[i]]
    report('python  th2000.py', len(diffs), describe(diffs, orig, after))


def run_chirp(path):
    try:
        sys.path.insert(0, os.environ.get('CHIRP_SRC', '/tmp/chirpsrc'))
        from chirp import memmap
        from chirp.drivers.tyt_th2000 import TYTTH2000Radio, MEM_SIZE
    except ImportError as e:
        print('  %-34s skip  (CHIRP not importable: %s)'
              % ('chirp   driver', e))
        return
    import th2000 as t
    _, cp = t.icf_load(path)
    orig = bytes(cp.data[:MEM_SIZE])
    r = TYTTH2000Radio(None)
    r._mmap = memmap.MemoryMapBytes(orig)
    r.process_mmap()
    # Only channels that exist. Calling set_memory on an empty memory is
    # CHIRP's delete operation and is destructive by contract, not a no-op.
    for n in range(1, 201):
        m = r.get_memory(n)
        if not m.empty:
            r.set_memory(m)
    after = bytes(r.get_mmap().get_packed()[:MEM_SIZE])
    diffs = [i for i in range(len(orig)) if orig[i] != after[i]]
    report('chirp   tyt_th2000.py', len(diffs), describe(diffs, orig, after))


JS = r'''
const fs = require('fs');
const T = require(process.argv[1]);
const p = T.icfParse(fs.readFileSync(process.argv[2], 'latin1'));
const orig = new T.Codeplug(p.bytes).data.slice();
const work = new T.Codeplug(orig);
for (let i = 0; i < T.CHAN_NUM; i++) work.setChannel(work.getChannel(i));
const d = [];
for (let i = 0; i < T.MEM_SIZE; i++) if (orig[i] !== work.data[i]) d.push(i);
const detail = d.slice(0, 6).map((i) => {
  const where = i < 0x1140
    ? 'channel ' + (Math.floor(i / 21) + 1) + ' byte ' + (i % 21)
    : '0x' + i.toString(16).toUpperCase();
  return where + ': ' + orig[i].toString(16).padStart(2, '0') + '->'
       + work.data[i].toString(16).padStart(2, '0');
}).join('; ');
console.log(JSON.stringify({ changed: d.length, detail: detail }));
'''


def run_js(path):
    core = os.path.join(HERE, 'web', 'th2000-core.js')
    if not os.path.exists(core):
        print('  %-34s skip  (th2000-core.js not found)'
              % 'js      th2000-core.js')
        return
    try:
        out = subprocess.run(['node', '-e', JS, core, path],
                             capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        print('  %-34s skip  (node not installed)' % 'js      th2000-core.js')
        return
    if out.returncode != 0:
        print('  %-34s FAIL' % 'js      th2000-core.js')
        print(out.stderr.strip()[:600])
        results.append(('js', False))
        return
    import json
    r = json.loads(out.stdout)
    report('js      th2000-core.js', r['changed'],
           ('\n        ' + r['detail']) if r['detail'] else '')


def make_stress(path):
    """A copy of the image with every bit we do NOT understand set to 1.

    Only genuinely unknown bits are stressed. Documented enum fields are left
    in range on purpose: an implementation that clamps power=3 to power=2 is
    behaving correctly, and flagging that would be noise. What must survive is
    the stuff we cannot interpret - if we drop it, we are silently rewriting
    part of someone's radio.
    """
    import struct
    import th2000 as t
    _, cp = t.icf_load(path)
    d = bytearray(cp.data[:t.CODEPLUG_SIZE])
    name = b'STRESSNAME012345'
    for i in range(t.CHANNEL_COUNT):
        o = i * t.CHANNEL_RECORD
        struct.pack_into('<I', d, o, 14550000)
        struct.pack_into('<I', d, o + 4, 14550000)
        # rx word: valid scrambler, valid tone
        struct.pack_into('<H', d, o + 8, (3 << 12) | 0x0375)
        # tx word: tone plus BOTH undocumented flags (bit 12 and bit 13)
        struct.pack_into('<H', d, o + 10, 0x1000 | 0x2000 | 0x0375)
        # byte 12: unknown bits 0 and 1 set, enums in range
        d[o + 12] = 0x03 | (2 << 2) | (2 << 4) | (2 << 6)
        # byte 13: unknown bits set, name-present consistent with a name
        d[o + 13] = 0x03 | 0x04 | (3 << 3) | (4 << 5)
        d[o + 14] = 7 | (3 << 4) | (3 << 6)
        d[o + 15:o + 21] = name[:6]
        no = t.ADDR_CH_NAMES + i * t.CHANNEL_NAME_LEN
        d[no:no + t.CHANNEL_NAME_LEN] = name[6:16]
        d[t.ADDR_CH_VALID + (i >> 3)] |= 1 << (i & 7)
    out = os.path.join(HERE, '.stress.icf')
    t.icf_save(out, t.Codeplug(bytes(d)))
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_IMAGE
    if not os.path.exists(path):
        raise SystemExit('image not found: %s' % path)
    print('phase 1 - real radio image: %s\n' % os.path.basename(path))
    run_python(path)
    run_js(path)
    run_chirp(path)

    stress = make_stress(path)
    print('\nphase 2 - every undocumented bit set\n')
    run_python(stress)
    run_js(stress)
    run_chirp(stress)
    os.remove(stress)

    bad = [n for n, ok in results if not ok]
    print('\n%d of %d implementations preserve the image exactly'
          % (len(results) - len(bad), len(results)))
    if bad:
        print('failing: ' + ', '.join(bad))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
