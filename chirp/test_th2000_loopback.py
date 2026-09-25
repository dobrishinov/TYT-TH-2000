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

"""Protocol loopback test for the TH-2000 CHIRP driver.

Stands up a fake radio that speaks the framing recovered from the OEM CPS,
then drives the real driver's sync_in()/sync_out() against it. This exercises
the handshake, mode entry, the block loop, byte stuffing in both directions,
checksums and the acknowledgement sequence - everything except the actual
UART. It is not a substitute for testing on hardware, but it does prove the
driver and the framing agree with each other.

Run: python3 test_th2000_loopback.py
"""

import struct
import os
import re
import sys

CHIRP = os.environ.get("CHIRP_PATH")
if CHIRP:
    sys.path.insert(0, CHIRP)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))   # th2000.py at the root

from chirp.drivers import tyt_th2000 as drv                     # noqa: E402


# Deliberately narrow: only what pyserial's Serial actually offers. An earlier
# version had a log() method the real thing does not, so the driver called it,
# these tests passed, and a real radio failed with
# 'Serial object has no attribute log'.
class FakeRadio:
    """Minimal TH-2000 firmware emulator sitting behind a serial-like API."""

    def __init__(self, image, legacy=False):
        self.image = bytearray(image)
        self.legacy = legacy
        self.out = bytearray()      # bytes the radio has produced
        self.inbuf = bytearray()    # bytes the PC has sent, not yet parsed
        self.mode = None
        self.timeout = 1
        self.baudrate = 9600
        self.parity = "N"
        self.bytesize = 8
        self.stopbits = 1
        self.rts = False
        self.dtr = False
        self.writes = 0
        self.blocks_served = 0
        self.blocks_written = 0

    # --- serial-ish surface used by the driver ---------------------------

    def write(self, data):
        self.writes += 1
        self.inbuf += data
        while True:
            end = self.inbuf.find(bytes([drv.END]))
            if end < 0:
                break
            frame = bytes(self.inbuf[:end + 1])
            del self.inbuf[:end + 1]
            self._handle(frame)

    def read(self, n):
        chunk = bytes(self.out[:n])
        del self.out[:n]
        return chunk

    # --- framing --------------------------------------------------------

    def _body(self, payload):
        if self.legacy:
            return payload + bytes((drv._checksum_twos(payload),))
        return drv._stuff(payload + bytes((drv._checksum_additive(payload),)))

    def _reply(self, opcode, payload=b""):
        self.out += drv.HDR_RX + bytes((opcode,)) + self._body(payload) \
            + bytes((drv.END,))

    def _handle(self, frame):
        assert frame.startswith(drv.HDR_TX), "PC sent a bad header"
        opcode = frame[4]
        body = frame[5:-1] if self.legacy else drv._unstuff(frame[5:-1])
        payload, cksum = body[:-1], body[-1]
        want = (drv._checksum_twos(payload) if self.legacy
                else drv._checksum_additive(payload))
        assert cksum == want, "PC sent a bad checksum"

        if opcode == drv.OP_HANDSHAKE:
            assert payload == drv.MODEL_ID
            self._reply(drv.OP_HANDSHAKE_ACK, drv.MODEL_ID)
        elif opcode in (drv.OP_ENTER_READ, drv.OP_ENTER_WRITE):
            start, end = struct.unpack(">II", payload)
            assert start == 0 and end == len(self.image)
            self.mode = opcode
            self._reply(drv.OP_ACK, b"\x00")
        elif opcode == drv.OP_READ_BLOCK:
            assert self.mode == drv.OP_ENTER_READ, "read outside read mode"
            addr, length = struct.unpack(">IH", payload)
            data = bytes(self.image[addr:addr + length])
            self._reply(drv.OP_DATA, struct.pack(">IH", addr, length) + data)
            self.blocks_served += 1
        elif opcode == drv.OP_DATA:
            assert self.mode == drv.OP_ENTER_WRITE, "write outside write mode"
            addr, length = struct.unpack_from(">IH", payload, 0)
            self.image[addr:addr + length] = payload[6:6 + length]
            self._reply(drv.OP_ACK, b"\x00")
            self.blocks_written += 1
        elif opcode == drv.OP_END:
            self.mode = None
            self._reply(drv.OP_ACK, b"\x00")
        else:
            raise AssertionError("unexpected opcode %02X" % opcode)


def _find_sample():
    """A codeplug to drive the loopback with.

    This used to be an absolute path into the machine it was written on, which
    meant nobody else could run the test. Look in the places the bundle
    actually puts one.
    """
    names = ("DefaulFile.icf", "ORIGIN_BACKUP_ConFile.icf")
    roots = (HERE,
             os.path.join(HERE, "..", "web"),
             os.path.join(HERE, "..", "reference"),
             os.path.join(HERE, ".."))
    for root in roots:
        for n in names:
            p = os.path.normpath(os.path.join(root, n))
            if os.path.exists(p):
                return p
    raise SystemExit(
        "no sample codeplug found. Put DefaulFile.icf or "
        "ORIGIN_BACKUP_ConFile.icf beside this script.")


def make_image():
    import th2000 as ref
    _, cp = ref.icf_load(_find_sample())
    return bytes(cp.data[:drv.MEM_SIZE]).ljust(drv.MEM_SIZE, b"\xFF")


def run(legacy):
    label = "legacy (th_uv88-style)" if legacy else "stuffed (TH-2000)"
    original = make_image()

    # ---- download ----
    radio = drv.TYTTH2000Radio(None)
    radio.LEGACY_FRAMING = legacy
    fake = FakeRadio(original, legacy=legacy)
    radio.pipe = fake
    radio.status_fn = lambda s: None
    radio.sync_in()

    got = bytes(radio.get_mmap().get_packed()[:drv.MEM_SIZE])
    assert got == original, "downloaded image differs from radio contents"
    print("  %-24s download: %d blocks, %d bytes, image matches"
          % (label, fake.blocks_served, len(got)))

    # ---- edit a channel through the CHIRP API ----
    mem = radio.get_memory(7)
    mem.empty = False
    mem.freq = 145500000
    mem.duplex = "-"
    mem.offset = 600000
    mem.name = "PLOVDIV"
    mem.tmode = "TSQL"
    mem.rtone = mem.ctone = 88.5
    mem.mode = "NFM"
    mem.power = drv.POWER_LEVELS[2]
    mem.skip = "S"
    radio.set_memory(mem)

    back = radio.get_memory(7)
    assert back.freq == 145500000, back.freq
    assert back.duplex == "-" and back.offset == 600000, (back.duplex,
                                                          back.offset)
    assert back.name == "PLOVDIV", repr(back.name)
    assert back.tmode == "TSQL" and back.ctone == 88.5, (back.tmode,
                                                         back.ctone)
    assert back.mode == "NFM" and back.skip == "S"
    assert str(back.power) == "Low", str(back.power)
    print("  %-24s channel edit round-trips through get/set_memory" % label)

    # ---- upload ----
    blank = FakeRadio(bytes(drv.MEM_SIZE), legacy=legacy)
    radio.pipe = blank
    radio.sync_out()
    expect = bytes(radio.get_mmap().get_packed()[:drv.MEM_SIZE])
    assert bytes(blank.image) == expect, "radio image differs after upload"
    print("  %-24s upload:   %d blocks, radio image matches ours"
          % (label, blank.blocks_written))

    # ---- the edit survived the wire ----
    verify = drv.TYTTH2000Radio(None)
    verify.LEGACY_FRAMING = legacy
    verify.pipe = FakeRadio(bytes(blank.image), legacy=legacy)
    verify.status_fn = lambda s: None
    verify.sync_in()
    v = verify.get_memory(7)
    assert (v.freq, v.name, v.tmode, v.ctone) == (145500000, "PLOVDIV",
                                                  "TSQL", 88.5), v
    print("  %-24s edit survived a full write/read cycle" % label)


def stuffing_checks():
    for b in range(256):
        assert drv._unstuff(drv._stuff(bytes([b]))) == bytes([b]), b
    body = drv._stuff(bytes(range(256)))
    assert all(x < 0xFA or x == 0xFF for x in body)
    assert bytes([drv.END]) not in body
    print("  stuffing: all 256 byte values round-trip, no 0xFA-0xFE leakage")


def test_pipe_surface():
    """The driver must only touch what pyserial actually offers.

    This exists because it did not: a call to pipe.log() passed every test,
    because the fake port here had a log() method, and then failed on a real
    radio with 'Serial object has no attribute log'. A test double that is
    more capable than the real thing hides bugs instead of finding them.
    """
    import serial
    import inspect
    src = inspect.getsource(drv)
    used = set(re.findall(r"pipe\.([A-Za-z_][A-Za-z0-9_]*)", src))
    real = set(dir(serial.Serial))
    missing = sorted(used - real)
    assert not missing, "driver uses pipe.%s, which pyserial has not" % (
        ", pipe.".join(missing))
    print("  pipe attributes used: %s - all present on serial.Serial"
          % ", ".join(sorted(used)))


if __name__ == "__main__":
    print("TH-2000 driver loopback test")
    stuffing_checks()
    run(legacy=False)
    run(legacy=True)
    test_pipe_surface()
    print("all loopback checks passed")
