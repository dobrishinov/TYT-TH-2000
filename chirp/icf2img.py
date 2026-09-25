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

"""Convert between the TYT OEM .icf codeplug and a CHIRP .img file.

    icf2img.py to-img   DefaulFile.icf  radio.img
    icf2img.py to-icf   radio.img       out.icf

Writing a .img needs CHIRP importable, because CHIRP identifies images by a
metadata sidecar appended to the file rather than by sniffing the contents.
Point PYTHONPATH at your CHIRP checkout, or install CHIRP, before using
`to-img`. `to-icf` works either way.
"""

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))   # th2000.py lives at the root

import th2000                                                   # noqa: E402

MEM_SIZE = 0x2B80


def _load_chirp():
    try:
        from chirp import memmap
        from chirp.drivers import tyt_th2000
    except ImportError as e:
        raise SystemExit(
            "Could not import CHIRP (%s).\n"
            "Install CHIRP, or set PYTHONPATH to your checkout, and make sure "
            "tyt_th2000.py is in chirp/drivers/." % e)
    return memmap, tyt_th2000


def to_img(src, dst):
    memmap, tyt_th2000 = _load_chirp()
    header, cp = th2000.icf_load(src)
    raw = bytes(cp.data)
    if len(raw) < MEM_SIZE:
        print("note: %s only covers 0x%X bytes; padding to 0x%X with 0xFF"
              % (src, len(raw), MEM_SIZE))
        raw = raw.ljust(MEM_SIZE, b"\xFF")
    elif len(raw) > MEM_SIZE:
        print("note: %s covers 0x%X bytes; truncating to the 0x%X the radio "
              "accepts" % (src, len(raw), MEM_SIZE))
        raw = raw[:MEM_SIZE]

    radio = tyt_th2000.TYTTH2000Radio(None)
    radio._mmap = memmap.MemoryMapBytes(raw)
    radio.process_mmap()
    radio.save_mmap(dst)

    used = sum(1 for n in range(1, 201) if not radio.get_memory(n).empty)
    print("wrote %s (%d channels in use)" % (dst, used))


def to_icf(src, dst):
    with open(src, "rb") as f:
        raw = f.read()
    # A CHIRP .img is the raw image followed by a metadata sidecar; the leading
    # MEM_SIZE bytes are what we want.
    if len(raw) < MEM_SIZE:
        raise SystemExit("%s is only %d bytes, expected at least %d"
                         % (src, len(raw), MEM_SIZE))
    if len(raw) > MEM_SIZE:
        print("note: ignoring %d trailing bytes (CHIRP metadata sidecar)"
              % (len(raw) - MEM_SIZE))
    cp = th2000.Codeplug(raw[:MEM_SIZE])
    th2000.icf_save(dst, cp)
    print("wrote %s" % dst)
    print("Open it in the OEM CPS to cross-check the layout - if it displays "
          "correctly there, the map is right.")


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("to-img", help="OEM .icf -> CHIRP .img")
    a.add_argument("src")
    a.add_argument("dst")
    b = sub.add_parser("to-icf", help="CHIRP .img -> OEM .icf")
    b.add_argument("src")
    b.add_argument("dst")
    args = p.parse_args()
    (to_img if args.cmd == "to-img" else to_icf)(args.src, args.dst)


if __name__ == "__main__":
    main()
