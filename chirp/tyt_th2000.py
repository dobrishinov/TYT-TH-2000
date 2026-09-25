# Copyright 2026 Georgi Dobrishinov (LZ1WOW)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
#
# TYT TH-2000 (also sold as UV-99; the OEM CPS ships one binary for both).
#
# The channel layout is very close to chirp/drivers/th_uv88.py, which is no
# accident - same product family. Two things differ, and they are why this is
# a separate driver rather than a th_uv88 subclass:
#
#   1. Memory size and internal addresses: 0x2B80 here vs 0x22A0 there.
#   2. The framing. TH-UV88 sends plain frames with a two's-complement
#      checksum. The TH-2000 CPS adds a +0x80 bias plus byte stuffing and uses
#      a plain additive checksum. See _encode_body() below.
#
# Set LEGACY_FRAMING = True on the class if a particular unit turns out to
# speak the older th_uv88-style protocol - opcodes and addressing are
# identical, only the body transform differs.
#
# Derived by static analysis of the OEM CPS (TH-2000.exe, an unobfuscated .NET
# assembly). No OEM code is reused. Field names that th_uv88 marks unknown -
# squelch mode, the 5-tone PTT-ID, the true width of the step field - were
# recovered from the CPS's own UI label tables.

import logging
import struct

from chirp import bitwise
import re

from chirp import chirp_common
from chirp import directory
from chirp import errors
from chirp import memmap
from chirp import util
from chirp.settings import RadioSetting, RadioSettingGroup, RadioSettings
from chirp.settings import RadioSettingValueInteger, RadioSettingValueList
from chirp.settings import RadioSettingValueString

LOG = logging.getLogger(__name__)

MEM_SIZE = 0x2B80
BLOCK_SIZE = 512            # ConOneTmReadCt in the OEM CPS
CHAN_NUM = 200

# Cosmetic. The radio's MCU (an ARTERY AT32 - USB VID 2E3C, PID 8800) speaks
# USB CDC-ACM directly, so there is no UART on the link: this value becomes a
# CDC SET_LINE_CODING request that firmware discards. Kept because it matches
# the OEM software. If a transfer misbehaves, this is not the knob to turn.
BAUD_RATE = 57600
STIMEOUT = 2

MODEL_ID = b"2000"          # ConRadioType, echoed in the handshake

HDR_TX = b"\xFE\xFE\xEE\xEF"
HDR_RX = b"\xFE\xFE\xEF\xEE"
END = 0xFD

OP_HANDSHAKE = 0xE0
OP_HANDSHAKE_ACK = 0xE1
OP_ENTER_READ = 0xE2
OP_ENTER_WRITE = 0xE3
OP_DATA = 0xE4
OP_END = 0xE5
OP_ACK = 0xE6
OP_READ_BLOCK = 0xEB

# Option lists, taken from the string tables in the OEM software.
KEY_FN = ['None', 'KEY-Low', 'KEY-Shift', 'KEY-MHZ', 'KEY-10MHZ', 'KEY-TONE',
          'KEY-M/V', 'KEY-Save', 'KEY-A/B', 'KEY-Band', 'KEY-MONI',
          '1750 TONE', 'Talk Around', 'Frequency Reverse']
SQL_LEVEL = ['OFF'] + [str(n) for n in range(1, 10)]
TOT_LIST = ['OFF'] + ['%d Second' % n for n in range(30, 300, 30)]
LED_MODE = ['OFF', 'ON', '5S', '10S', '15S', '20S', '25S', '30S']
SCAN_TYPE = ['To', 'Co', 'Se']
POWER_OFF = ['OFF', '30 Minute', '1 Hour', '2 Hour']
RX_LIGHT = ['Always On', 'Code On', 'OFF']
KEY_MODE = ['ALL', 'PTT', 'KEY', 'KEY & Side Key']
KEY_LOCK = ['OFF', 'Auto']
DIS_MODE = ['Frequency', 'Channel', 'Name']
INTRO_SCREEN = ['OFF', 'Voltage', 'Char String']
TX_CH_KIND = ['Main CH', 'Last CH']
TX_TONE_KIND = ['OFF', 'END']
OFF_ON = ['OFF', 'ON']

POWER_LEVELS = [chirp_common.PowerLevel("High", watts=25.00),
                chirp_common.PowerLevel("Mid", watts=10.00),
                chirp_common.PowerLevel("Low", watts=5.00)]

MODES = ["FM", "FM", "NFM"]          # wide, mid, narrow
SCRAMBLE_LIST = ["OFF", "1", "2", "3", "4", "5", "6", "7", "8"]
B_LOCK_LIST = ["OFF", "Sub", "Carrier"]
OPTSIG_LIST = ["OFF", "DTMF", "2TONE", "5TONE"]
PTTID_LIST = ["OFF", "BOT", "EOT", "Both"]
SQL_MODE_LIST = ["SQ", "CT", "Tone", "CT/Tone", "CTC&Tone"]
STEPS = [2.5, 5.0, 6.25, 10.0, 12.5, 25.0, 50.0, 100.0]
LIST_STEPS = [str(x) for x in STEPS]

# Bit layout of the 21-byte channel record. Tone slots are 12 bits; the top
# nibble of each carries unrelated flags.
#
# CAUTION: th_uv88.py places decodeDSCI at bit 15 and encodeDSCI at bit 14.
# The TH-2000 CPS unambiguously does the opposite - ChgChStringPro tests the
# decode combo into bit 6 of byte 11 (word bit 14) and the encode combo into
# bit 7 (word bit 15). One of the two drivers has it backwards. It only
# affects inverted DCS, so if polarity comes out swapped on real hardware,
# exchange these two lines and report it upstream.
MEM_FORMAT = """
struct chns {
  ul32 rxfreq;
  ul32 txfreq;
  ul16 scramble:4,
       rxtone:12;
  ul16 encodeDSCI:1,
       decodeDSCI:1,
       unknown11:1,
       tone_flag:1,
       txtone:12;
  u8   power:2,
       wide:2,
       b_lock:2,
       reverse:1,          // confirmed: Rev in the VFO window
       unknown12:1;
  u8   sql_mode:3,
       signal:2,
       display_name:1,
       talkaround:1,       // confirmed: Talk Off in the VFO window
       unknown13:1;
  u8   tone5_pttid:2,
       dtmf_pttid:2,
       step:4;
  u8   name[6];
};

struct chname {
  u8 extra_name[10];
};

struct chns chan_mem[200];       // at 0x0000

// Ten more channel records sit between the channel array and the name table,
// at 0x1068-0x1140 - a region nothing had mapped until a radio was read with
// known VFO settings. Slots 204-209 are the two VFOs, one per band. The middle
// slot of each is a 220 MHz band this radio does not have.
#seekto 0x10BC;
struct chns vfo[6];              // 204..209

#seekto 0x1140;
struct chname chan_name[200];

#seekto 0x1F00;
struct {
  u8 bitmap[32];
} chan_avail;

#seekto 0x1F20;
struct {
  u8 bitmap[32];
} chan_skip;

#seekto 0x1F40;
struct {
  ul32 lower;
  ul32 upper;
} band_limit[6];

#seekto 0x1F70;
struct {
  char line1[16];
  char line2[16];
} intro;

// Radio-wide settings. Every named field was confirmed by changing one
// thing in the OEM software and diffing the bytes - 59 in all - not
// inferred from decompiled code. The unknown* members exist so bitwise carries
// those bits through untouched: eleven of the 32 bytes have no known meaning,
// and the OEM software preserves most of them too.
#seekto 0x2020;
struct {
  u8 p2short:4, p1short:4;                                       // +0
  u8 p2long:4,  p1long:4;                                        // +1
  u8 unknown2:6, rxlight:2;                                      // +2
  u8 unknown3:3, volume:5;                                       // +3
  u8 unknown4[8];                                                // +4..+11
  u8 unknown12:4, sql:4;                                         // +12
  u8 beep:1, unknown13a:2, intro:2, unknown13b:2, txchannel:1;  // +13
  u8 unknown14a:1, poweroff:2, unknown14b:1, tot:4;              // +14
  u8 unknown15a:1, txtone:1, unknown15b:6;                       // +15
  u8 scantype:2, dismode:2, unknown16:1, ledmode:3;              // +16
  u8 unknown17;                                                  // +17
  u8 pwdenable:1, sqltail:1, unknown18:6;                        // +18
  u8 unknown19;                                                  // +19
  u8 unknown20a:1, monitor:1, keylock:1, dualwait:1,
     unknown20b:1, light:3;                                      // +20
  u8 unknown21;                                                  // +21
  u8 unknown22:6, keymode:2;                                     // +22
  u8 p3long:4, p3short:4;                                        // +23
  u8 p4long:4, p4short:4;                                        // +24
  u8 p5long:4, p5short:4;                                        // +25
  char password[6];                                              // +26..+31
} settings;

#seekto 0x2500;
struct { ul32 freq; } fmpreset[32];

#seekto 0x2580;
struct { u8 bitmap[4]; } fmenable;

#seekto 0x2584;
struct { ul32 freq; } fmvfo;
"""


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

def _checksum_additive(data):
    """Plain 8-bit sum. Used by the stuffed (TH-2000) framing."""
    return sum(data) & 0xFF


def _checksum_twos(data):
    """Two's complement. Used by the legacy (th_uv88) framing."""
    num = sum(data) % 256
    return 0 if num == 0 else 256 - num


def _stuff(body):
    """Bias each byte by 0x80 and escape anything that lands in 0xFA-0xFF,
    so no reserved byte can appear inside a frame."""
    out = bytearray()
    for b in body:
        v = (b + 0x80) & 0xFF
        if v > 0xF9:
            out += bytes((0xFF, v & 0x0F))
        else:
            out.append(v)
    return bytes(out)


def _unstuff(data):
    out = bytearray()
    i = 0
    while i < len(data):
        if data[i] == 0xFF:
            if i + 1 >= len(data):
                raise errors.RadioError("Truncated escape sequence in frame")
            v = 0xF0 | (data[i + 1] & 0x0F)
            i += 2
        else:
            v = data[i]
            i += 1
        out.append((v + 0x80) & 0xFF)
    return bytes(out)


class _Framer:
    """Encapsulates the two framing variants so the session logic below does
    not have to care which one is in use."""

    def __init__(self, legacy=False):
        self.legacy = legacy

    def build(self, opcode, payload=b""):
        if self.legacy:
            body = payload + bytes((_checksum_twos(payload),))
            return HDR_TX + bytes((opcode,)) + body + bytes((END,))
        body = payload + bytes((_checksum_additive(payload),))
        return HDR_TX + bytes((opcode,)) + _stuff(body) + bytes((END,))

    def parse(self, frame):
        if len(frame) < 6:
            raise errors.RadioError("Short frame from radio")
        if not frame.startswith(HDR_RX):
            LOG.debug("Bad frame: %s" % util.hexprint(frame))
            raise errors.RadioError("Unexpected frame header from radio")
        if frame[-1] != END:
            raise errors.RadioError("Frame not terminated with 0xFD")
        opcode = frame[4]
        body = frame[5:-1] if self.legacy else _unstuff(frame[5:-1])
        payload, got = body[:-1], body[-1]
        want = (_checksum_twos(payload) if self.legacy
                else _checksum_additive(payload))
        if got != want:
            LOG.debug("Bad checksum: %s" % util.hexprint(frame))
            raise errors.RadioError(
                "Checksum mismatch from radio (got %02X want %02X)"
                % (got, want))
        return opcode, payload


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

def _clean_buffer(radio):
    radio.pipe.timeout = 0.005
    junk = radio.pipe.read(1024)
    radio.pipe.timeout = STIMEOUT
    if junk:
        LOG.debug("Discarded %i bytes of junk before starting" % len(junk))


def _send(radio, framer, opcode, payload=b""):
    frame = framer.build(opcode, payload)
    LOG.debug("TX op %02X, %i bytes" % (opcode, len(frame)))
    try:
        radio.pipe.write(frame)
    except Exception:
        raise errors.RadioError("Error sending data to radio")


def _recv(radio, framer):
    """Read one frame, terminated by an unescaped 0xFD."""
    buf = bytearray()
    while len(buf) < 4096:
        b = radio.pipe.read(1)
        if not b:
            if not buf:
                raise errors.RadioNoResponse()
            raise errors.RadioError(
                "Timeout waiting for the rest of a frame from the radio")
        buf += b
        # 0xFD cannot occur inside a stuffed body, so the first one ends it
        if b[0] == END and len(buf) >= 6:
            return framer.parse(bytes(buf))
    raise errors.RadioError("Runaway frame from radio")


def _expect(radio, framer, opcode):
    op, payload = _recv(radio, framer)
    if op != opcode:
        raise errors.RadioError("Expected opcode %02X from radio, got %02X"
                                % (opcode, op))
    return payload


def _do_ident(radio, framer):
    radio.pipe.baudrate = BAUD_RATE
    radio.pipe.parity = "N"
    radio.pipe.bytesize = 8
    radio.pipe.stopbits = 1
    radio.pipe.timeout = STIMEOUT
    try:
        radio.pipe.rts = True
        radio.pipe.dtr = True
    except Exception:
        LOG.debug("Could not assert RTS/DTR; continuing anyway")

    _clean_buffer(radio)
    _send(radio, framer, OP_HANDSHAKE, MODEL_ID)
    ident = _expect(radio, framer, OP_HANDSHAKE_ACK)
    LOG.info("Radio ident: %s" % util.hexprint(ident))
    if not ident.startswith(MODEL_ID):
        LOG.debug("Ident payload was %r, expected it to start with %r"
                  % (ident, MODEL_ID))
        raise errors.RadioError(
            "This radio did not identify as a TH-2000. Check that you picked "
            "the right model.")
    return ident


def _exit_program_mode(radio, framer):
    try:
        _send(radio, framer, OP_END, MODEL_ID)
        _recv(radio, framer)
    except Exception:
        # The radio often just drops the link here; nothing to do about it
        LOG.debug("No clean acknowledgement of session end")


def _enter_mode(radio, framer, opcode):
    _send(radio, framer, opcode, struct.pack(">II", 0, MEM_SIZE))
    _expect(radio, framer, OP_ACK)


def _download(radio):
    framer = _Framer(radio.LEGACY_FRAMING)
    _do_ident(radio, framer)
    try:
        _enter_mode(radio, framer, OP_ENTER_READ)

        status = chirp_common.Status()
        status.cur = 0
        status.max = MEM_SIZE // BLOCK_SIZE + 1
        status.msg = "Downloading from radio"

        data = b""
        addr = 0
        while addr < MEM_SIZE:
            length = min(BLOCK_SIZE, MEM_SIZE - addr)
            _send(radio, framer, OP_READ_BLOCK,
                  struct.pack(">IH", addr, length))
            payload = _expect(radio, framer, OP_DATA)
            if len(payload) < 6:
                raise errors.RadioError("Short data block from radio")
            got_addr, got_len = struct.unpack_from(">IH", payload, 0)
            if got_addr != addr or got_len != length:
                raise errors.RadioError(
                    "Radio returned block %04X/%i, expected %04X/%i"
                    % (got_addr, got_len, addr, length))
            block = payload[6:6 + got_len]
            if len(block) != got_len:
                raise errors.RadioError("Block shorter than its header claims")
            data += block
            addr += length
            status.cur += 1
            radio.status_fn(status)
    finally:
        _exit_program_mode(radio, framer)

    return memmap.MemoryMapBytes(data)


def _upload(radio):
    framer = _Framer(radio.LEGACY_FRAMING)
    _do_ident(radio, framer)
    try:
        _enter_mode(radio, framer, OP_ENTER_WRITE)

        status = chirp_common.Status()
        status.cur = 0
        status.max = MEM_SIZE // BLOCK_SIZE + 1
        status.msg = "Uploading to radio"

        image = radio.get_mmap().get_byte_compatible()
        addr = 0
        while addr < MEM_SIZE:
            length = min(BLOCK_SIZE, MEM_SIZE - addr)
            block = bytes(image[addr:addr + length])
            _send(radio, framer, OP_DATA,
                  struct.pack(">IH", addr, length) + block)
            _expect(radio, framer, OP_ACK)
            addr += length
            status.cur += 1
            radio.status_fn(status)
    finally:
        _exit_program_mode(radio, framer)


# ---------------------------------------------------------------------------
# Bitmap helper
# ---------------------------------------------------------------------------

def _bitmap_get(bitmap, index):
    return bool(bitmap[index // 8] & (1 << (index % 8)))


def _bitmap_set(bitmap, index, value):
    byte, mask = index // 8, 1 << (index % 8)
    if value:
        bitmap[byte] |= mask
    else:
        bitmap[byte] &= ~mask & 0xFF


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

@directory.register
class TYTTH2000Radio(chirp_common.CloneModeRadio):
    """TYT TH-2000"""
    VENDOR = "TYT"
    MODEL = "TH-2000"
    BAUD_RATE = BAUD_RATE
    NEEDS_COMPAT_SERIAL = False

    # Flip to True if a unit speaks the older, unstuffed th_uv88-style framing
    LEGACY_FRAMING = False

    _memsize = MEM_SIZE

    @classmethod
    def get_prompts(cls):
        rp = chirp_common.RadioPrompts()
        rp.experimental = (
            "This driver was written from static analysis of the OEM CPS "
            "rather than from a captured session, and the serial side has not "
            "yet been confirmed against hardware. Download from your radio "
            "and save that image before you upload anything.\n\n"
            "The DCS inversion bits are the one field known to be uncertain "
            "- see the comment above MEM_FORMAT in the driver source.")
        rp.pre_download = (
            "1. Turn the radio off.\n"
            "2. Connect the programming cable.\n"
            "3. Turn the radio on.\n"
            "4. Click OK to download.\n")
        rp.pre_upload = (
            "1. Turn the radio off.\n"
            "2. Connect the programming cable.\n"
            "3. Turn the radio on.\n"
            "4. Click OK to upload.\n")
        return rp

    # --- the manufacturer's .icf ------------------------------------------

    @staticmethod
    def _icf_parse(text):
        """Bytes from a TYT .icf, or None if it is not one of ours."""
        rows = re.split(r"\r\n|\r|\n", text)
        out = bytearray()
        seen = 0
        for row in rows:
            row = row.strip()
            if len(row) != 70 or not re.fullmatch(r"[0-9A-Fa-f]{70}", row):
                continue
            addr = int(row[0:4], 16)
            length = int(row[4:6], 16)
            data = bytes.fromhex(row[6:6 + length * 2])
            if len(out) < addr + length:
                out.extend(b"\xFF" * (addr + length - len(out)))
            out[addr:addr + length] = data
            seen += 1
        if seen < 2 or len(out) < MEM_SIZE:
            return None
        return bytes(out[:MEM_SIZE])

    @staticmethod
    def _icf_looks_like_ours(data):
        """Guard against sibling products that share the file format.

        The installer ships .icf files for related radios - one has a channel
        named GMR50 - with the same header, the same record count and the same
        21-byte channel record. Nothing in the header separates them. Two
        things do: this radio keeps printable text at 0x1F70, and its band
        limit slots hold sane frequency pairs.
        """
        intro = data[0x1F70:0x1F80]
        if not any(0x20 <= b < 0x7F for b in intro):
            return False
        if any(b != 0xFF and not (0x20 <= b < 0x7F) for b in intro):
            return False
        for n in range(6):
            off = 0x1F40 + n * 8
            lo = int.from_bytes(data[off:off + 4], "little")
            hi = int.from_bytes(data[off + 4:off + 8], "little")
            if lo == 0xFFFFFFFF:
                continue
            if not (1000000 <= lo < hi <= 100000000):
                return False
        return True

    def load_mmap(self, filename):
        """Accept a .icf as well as a raw image."""
        if filename.lower().endswith(".icf"):
            with open(filename, "r", encoding="latin-1") as f:
                data = self._icf_parse(f.read())
            if data is None:
                raise errors.ImageDetectFailed(
                    "Not a TH-2000 configuration file")
            self._mmap = memmap.MemoryMapBytes(data)
            self.process_mmap()
            return
        chirp_common.CloneModeRadio.load_mmap(self, filename)

    def save_mmap(self, filename):
        """Write a .icf when asked for one, otherwise CHIRP's own format."""
        if not filename.lower().endswith(".icf"):
            return chirp_common.CloneModeRadio.save_mmap(self, filename)
        data = self.get_mmap().get_packed()[:MEM_SIZE]
        rows = ["COM1", "#Comment=TYT INC.(C)  2013  #MapRev=1", "38400"]
        for addr in range(0, MEM_SIZE, 32):
            chunk = data[addr:addr + 32]
            rows.append("%04X%02X%s" % (addr, len(chunk), chunk.hex().upper()))
        with open(filename, "w", newline="") as f:
            f.write("\r\n".join(rows) + "\r\n")

    @classmethod
    def match_model(cls, filedata, filename):
        # A raw image is never claimed - new drivers identify by the metadata
        # CHIRP appends, and an 11136-byte blob is not distinctive. A .icf is
        # different: the header is unambiguous and the contents can be checked,
        # so one saved by the manufacturer's software opens directly.
        if not (filename or "").lower().endswith(".icf"):
            return False
        try:
            text = filedata.decode("latin-1")
        except Exception:
            return False
        if "#MapRev=" not in text:
            return False
        data = cls._icf_parse(text)
        return data is not None and cls._icf_looks_like_ours(data)

    def get_features(self):
        rf = chirp_common.RadioFeatures()
        rf.has_settings = True
        rf.has_bank = False
        rf.has_cross = True
        rf.has_rx_dtcs = True
        rf.has_tuning_step = False
        rf.can_odd_split = True
        rf.memory_bounds = (1, CHAN_NUM)

        rf.valid_modes = ["FM", "NFM"]
        rf.valid_tmodes = ["", "Tone", "TSQL", "DTCS", "Cross"]
        # "Tone->" is deliberately absent: the radio cannot distinguish it
        # from tmode "Tone", so it would not survive a round trip.
        rf.valid_cross_modes = ["Tone->Tone", "Tone->DTCS", "DTCS->Tone",
                                "DTCS->", "->Tone", "->DTCS", "DTCS->DTCS"]
        rf.valid_duplexes = ["", "+", "-", "split", "off"]
        rf.valid_power_levels = POWER_LEVELS
        rf.valid_skips = ["", "S"]
        # The radio's own DcsTone table holds exactly the 104 standard codes
        # (023..754), which is chirp_common.DTCS_CODES. Claiming the raw
        # 0..511 range of ALL_DTCS_CODES would promise codes the radio has no
        # entry for, including 0, which is not a DCS code at all.
        rf.valid_dtcs_codes = chirp_common.DTCS_CODES
        rf.valid_name_length = 16
        rf.valid_characters = chirp_common.CHARSET_ASCII
        rf.valid_tuning_steps = STEPS
        rf.valid_bands = [(108000000, 174000000),
                          (400000000, 480000000)]
        return rf

    def process_mmap(self):
        self._memobj = bitwise.parse(MEM_FORMAT, self._mmap)

    def sync_in(self):
        try:
            self._mmap = _download(self)
        except errors.RadioError:
            raise
        except Exception as e:
            LOG.exception("Download failed")
            raise errors.RadioError("Failed to download from radio: %s" % e)
        self.process_mmap()

    def sync_out(self):
        try:
            _upload(self)
        except errors.RadioError:
            raise
        except Exception as e:
            LOG.exception("Upload failed")
            raise errors.RadioError("Failed to upload to radio: %s" % e)

    def get_raw_memory(self, number):
        return repr(self._memobj.chan_mem[number - 1])

    # --- memories ---------------------------------------------------------

    def get_memory(self, number):
        idx = number - 1
        _mem = self._memobj.chan_mem[idx]
        _nam = self._memobj.chan_name[idx]

        mem = chirp_common.Memory()
        mem.number = number

        if not _bitmap_get(self._memobj.chan_avail.bitmap, idx):
            mem.empty = True
            return mem
        mem.empty = False

        # The skip bitmap is inverted: a set bit means "allow in scan".
        if not _bitmap_get(self._memobj.chan_skip.bitmap, idx):
            mem.skip = "S"

        mem.freq = int(_mem.rxfreq) * 10

        if int(_mem.txfreq) == 0xFFFFFFFF:
            mem.duplex = "off"
            mem.offset = 0
        elif int(_mem.rxfreq) == int(_mem.txfreq):
            mem.duplex = ""
            mem.offset = 0
        elif abs(int(_mem.rxfreq) - int(_mem.txfreq)) * 10 > 70000000:
            mem.duplex = "split"
            mem.offset = int(_mem.txfreq) * 10
        else:
            mem.duplex = "-" if int(_mem.rxfreq) > int(_mem.txfreq) else "+"
            mem.offset = abs(int(_mem.rxfreq) - int(_mem.txfreq)) * 10

        # The radio keeps a 6-character name in the record and 10 more in a
        # separate table; together they form the displayed name.
        name = "".join(chr(c) for c in _mem.name)
        name += "".join(chr(c) for c in _nam.extra_name)
        mem.name = name.rstrip()

        self._get_tone(mem, _mem)

        mem.mode = MODES[min(int(_mem.wide), 2)]
        mem.power = POWER_LEVELS[min(int(_mem.power), 2)]

        mem.extra = RadioSettingGroup("extra", "Extra")

        def _list(key, label, options, value):
            rs = RadioSetting(key, label, RadioSettingValueList(
                options, current_index=min(int(value), len(options) - 1)))
            mem.extra.append(rs)

        _list("b_lock", "Busy Lock", B_LOCK_LIST, _mem.b_lock)
        _list("step", "Step", LIST_STEPS, _mem.step)
        _list("scramble", "Scrambler", SCRAMBLE_LIST, _mem.scramble)
        _list("signal", "Optional Signalling", OPTSIG_LIST, _mem.signal)
        _list("sql_mode", "Squelch Mode", SQL_MODE_LIST, _mem.sql_mode)
        _list("dtmf_pttid", "DTMF PTT-ID", PTTID_LIST, _mem.dtmf_pttid)
        _list("tone5_pttid", "5-Tone PTT-ID", PTTID_LIST, _mem.tone5_pttid)

        return mem

    @staticmethod
    def _get_tone(mem, _mem):
        # CTCSS is stored as hz*10 (625..2541); DCS as the octal code taken as
        # a plain integer (19..492). The ranges do not overlap, so the value
        # alone identifies which is in use. 0x0FFF means off.
        txtone = int(_mem.txtone)
        rxtone = int(_mem.rxtone)

        # A zeroed slot is not DCS 000 - there is no such code - so treat it
        # as no tone, the same as the 0x0FFF sentinel.
        if txtone > 2600 or txtone == 0:
            txmode = ""
        elif txtone > 511:
            txmode = "Tone"
            mem.rtone = txtone / 10.0
        else:
            txmode = "DTCS"
            mem.dtcs = int(format(txtone, "o"))

        if rxtone > 2600 or rxtone == 0:
            rxmode = ""
        elif rxtone > 511:
            rxmode = "Tone"
            mem.ctone = rxtone / 10.0
        else:
            rxmode = "DTCS"
            mem.rx_dtcs = int(format(rxtone, "o"))

        mem.dtcs_polarity = ("N", "R")[int(_mem.encodeDSCI)] + \
                            ("N", "R")[int(_mem.decodeDSCI)]

        if txmode == "Tone" and not rxmode:
            mem.tmode = "Tone"
        elif txmode == rxmode == "Tone" and mem.rtone == mem.ctone:
            mem.tmode = "TSQL"
        elif txmode == rxmode == "DTCS" and mem.dtcs == mem.rx_dtcs:
            mem.tmode = "DTCS"
        elif rxmode or txmode:
            mem.tmode = "Cross"
            mem.cross_mode = "%s->%s" % (txmode, rxmode)
        else:
            mem.tmode = ""

    def set_memory(self, mem):
        idx = mem.number - 1
        _mem = self._memobj.chan_mem[idx]
        _nam = self._memobj.chan_name[idx]

        if mem.empty:
            _bitmap_set(self._memobj.chan_avail.bitmap, idx, False)
            _bitmap_set(self._memobj.chan_skip.bitmap, idx, True)
            _mem.set_raw(b"\xFF" * 15 + b"\x20" * 6)
            _nam.set_raw(b"\x20" * 10)
            return

        was_empty = not _bitmap_get(self._memobj.chan_avail.bitmap, idx)
        if was_empty:
            _mem.set_raw(b"\x00" * 15 + b"\x20" * 6)
            _nam.set_raw(b"\x20" * 10)

        _bitmap_set(self._memobj.chan_avail.bitmap, idx, True)
        _bitmap_set(self._memobj.chan_skip.bitmap, idx, mem.skip != "S")

        _mem.rxfreq = mem.freq // 10
        if mem.duplex == "off":
            _mem.txfreq = 0xFFFFFFFF
        elif mem.duplex == "split":
            _mem.txfreq = mem.offset // 10
        elif mem.duplex == "+":
            _mem.txfreq = (mem.freq + mem.offset) // 10
        elif mem.duplex == "-":
            _mem.txfreq = (mem.freq - mem.offset) // 10
        else:
            _mem.txfreq = mem.freq // 10

        padded = mem.name.ljust(16)[:16]
        for i in range(6):
            _mem.name[i] = ord(padded[i])
        for i in range(10):
            _nam.extra_name[i] = ord(padded[6 + i])
        _mem.display_name = 1 if mem.name.strip() else 0

        self._set_tone(mem, _mem)

        _mem.wide = MODES.index(mem.mode) if mem.mode == "FM" else 2
        _mem.power = (POWER_LEVELS.index(mem.power) if mem.power else 0)

        for setting in mem.extra:
            setattr(_mem, setting.get_name(), setting.value)

    @staticmethod
    def _set_tone(mem, _mem):
        ((txmode, txtone, txpol),
         (rxmode, rxtone, rxpol)) = chirp_common.split_tone_encode(mem)

        if txmode == "Tone":
            _mem.txtone = int(round(txtone * 10))
        elif txmode == "DTCS":
            _mem.txtone = int(str(txtone), 8)
        else:
            _mem.txtone = 0x0FFF

        if rxmode == "Tone":
            _mem.rxtone = int(round(rxtone * 10))
        elif rxmode == "DTCS":
            _mem.rxtone = int(str(rxtone), 8)
        else:
            _mem.rxtone = 0x0FFF

        _mem.encodeDSCI = 1 if txpol == "R" else 0
        _mem.decodeDSCI = 1 if rxpol == "R" else 0

    # --- settings ---------------------------------------------------------

    def get_settings(self):
        st = self._memobj.settings

        def lst(key, label, options, value, doc=None):
            rs = RadioSetting(key, label, RadioSettingValueList(
                options, current_index=min(int(value), len(options) - 1)))
            if doc:
                rs.set_doc(doc)
            return rs

        radio = RadioSettingGroup("radio", "Radio")
        radio.append(lst("sql", "Squelch level", SQL_LEVEL, st.sql,
                         "How strong a signal must be before the speaker "
                         "unmutes. OFF leaves the squelch open."))
        radio.append(RadioSetting(
            "volume", "Volume level",
            RadioSettingValueInteger(0, 31, int(st.volume))))
        radio.append(lst("tot", "Time-out timer", TOT_LIST, st.tot,
                         "Longest a single transmission may last."))
        radio.append(lst("poweroff", "Auto power off", POWER_OFF, st.poweroff))
        radio.append(lst("scantype", "Scan type", SCAN_TYPE, st.scantype,
                         "To resumes after a fixed time, Co waits for the "
                         "carrier to drop, Se stops and stays."))
        radio.append(lst("dualwait", "Dual watch", OFF_ON, st.dualwait))
        radio.append(lst("monitor", "Radio monitor", OFF_ON, st.monitor))
        radio.append(lst("sqltail", "Eliminate squelch tail", OFF_ON,
                         st.sqltail,
                         "Full OEM label: Eliminate Squelch Tail When No "
                         "CTC/DCS Signaling."))

        disp = RadioSettingGroup("display", "Display and sound")
        # the radio stores one less than the level it shows
        disp.append(RadioSetting(
            "light", "Backlight",
            RadioSettingValueInteger(1, 7, int(st.light) + 1)))
        disp.append(lst("ledmode", "LED mode", LED_MODE, st.ledmode))
        disp.append(lst("rxlight", "RX light", RX_LIGHT, st.rxlight))
        disp.append(lst("dismode", "Display mode", DIS_MODE, st.dismode))
        disp.append(lst("beep", "Beep", OFF_ON, st.beep))
        disp.append(lst("intro", "Intro screen", INTRO_SCREEN, st.intro))
        for n in (1, 2):
            line = getattr(self._memobj.intro, "line%d" % n)
            cur = str(line).rstrip("\x00 ")
            disp.append(RadioSetting(
                "intro_line%d" % n, "Intro line %d" % n,
                RadioSettingValueString(0, 16, cur, autopad=True,
                                        charset=chirp_common.CHARSET_ASCII)))

        tx = RadioSettingGroup("tx", "Transmit")
        tx.append(lst("txchannel", "TX channel", TX_CH_KIND, st.txchannel,
                      "Which channel is used if you transmit while scanning."))
        tx.append(lst("txtone", "TX tone", TX_TONE_KIND, st.txtone))

        keys = RadioSettingGroup("keys", "Keys")
        keys.append(lst("keymode", "Key mode", KEY_MODE, st.keymode))
        keys.append(lst("keylock", "Key lock", KEY_LOCK, st.keylock))
        for n in (1, 2, 3, 4, 5):
            for kind in ("short", "long"):
                key = "p%d%s" % (n, kind)
                if key == "p5long":
                    # the power button; the OEM software will not reassign it
                    rs = RadioSetting(
                        key, "P5 long (power button)",
                        RadioSettingValueString(0, 16, "Power Button"))
                    rs.set_doc("Fixed by the radio and not reassignable.")
                    keys.append(rs)
                    continue
                keys.append(lst(key, "P%d %s" % (n, kind), KEY_FN,
                                getattr(st, key)))

        sec = RadioSettingGroup("security", "Security")
        sec.append(lst("pwdenable", "Boot-strap password", OFF_ON,
                       st.pwdenable))
        raw = st.password.get_raw()
        pwd = "".join(chr(b) for b in raw if 0x30 <= b <= 0x39) or "000000"
        sec.append(RadioSetting(
            "password", "Password (6 digits)",
            RadioSettingValueString(0, 6, pwd, autopad=True,
                                    charset="0123456789")))

        vfo = RadioSettingGroup("vfo", "VFO")
        # index into the vfo[] array declared above, skipping the 220 MHz slots
        # named as the browser tool names them, and as the radio shows them:
        # A is the left display row, B the right
        for i, tag in ((0, "VFO A (left) VHF"), (2, "VFO A (left) UHF"),
                       (3, "VFO B (right) VHF"), (5, "VFO B (right) UHF")):
            v = self._memobj.vfo[i]
            rs = RadioSetting(
                "vfo%d_freq" % i, tag + " (MHz)",
                RadioSettingValueString(
                    0, 10, "%.5f" % (int(v.rxfreq) / 100000.0),
                    autopad=True, charset="0123456789. "))
            rs.set_doc("The frequency this side of the display falls back to "
                       "when it leaves the memory channels.")
            vfo.append(rs)
            vfo.append(lst("vfo%d_power" % i, tag + " power",
                           [str(p) for p in POWER_LEVELS], v.power))
            vfo.append(lst("vfo%d_bw" % i, tag + " bandwidth",
                           ["Wide", "Mid", "Narrow"], v.wide))
            vfo.append(lst("vfo%d_rev" % i, tag + " reverse", OFF_ON,
                           v.reverse,
                           "Swaps transmit and receive, so you hear a "
                           "repeater's input."))
            vfo.append(lst("vfo%d_talk" % i, tag + " talk around", OFF_ON,
                           v.talkaround,
                           "Transmits on the receive frequency, bypassing the "
                           "repeater."))

        fm = RadioSettingGroup("fm", "FM broadcast")
        fmv = int(self._memobj.fmvfo.freq)
        fm.append(RadioSetting(
            "fmvfo", "FM VFO (MHz)",
            RadioSettingValueString(
                0, 7,
                "" if fmv == 0xFFFFFFFF else "%.2f" % (fmv / 100000.0),
                autopad=True, charset="0123456789. ")))
        for i in range(32):
            raw = int(self._memobj.fmpreset[i].freq)
            fm.append(RadioSetting(
                "fmpreset%d" % i, "Preset %d (MHz)" % (i + 1),
                RadioSettingValueString(
                    0, 7,
                    "" if raw == 0xFFFFFFFF else "%.2f" % (raw / 100000.0),
                    autopad=True, charset="0123456789. ")))

        limits = RadioSettingGroup("limits", "Band limits (read-only)")
        for n in range(6):
            band = self._memobj.band_limit[n]
            lo, hi = int(band.lower), int(band.upper)
            text = "unused" if lo == 0xFFFFFFFF or hi <= lo else \
                "%.4f - %.4f MHz" % (lo / 100000.0, hi / 100000.0)
            rs = RadioSetting("limit%i" % n, "Slot %i" % n,
                              RadioSettingValueString(0, 32, text))
            rs.set_doc("Editing band limits from CHIRP is deliberately not "
                       "supported. Transmitting outside your licence is your "
                       "responsibility.")
            limits.append(rs)

        return RadioSettings(radio, disp, tx, keys, sec, vfo, fm, limits)

    def set_settings(self, settings):
        st = self._memobj.settings
        for element in settings:
            if not isinstance(element, RadioSetting):
                self.set_settings(element)
                continue
            name = element.get_name()
            value = element.value
            if name.startswith("limit") or name == "p5long":
                continue                      # shown for information only
            if name.startswith("intro_line"):
                # Only write when the text actually changed. The radio pads
                # these with a null; we would pad with spaces, so rewriting an
                # unchanged line would move a byte for no reason.
                n = int(name[-1])
                line = getattr(self._memobj.intro, "line%d" % n)
                if str(line).rstrip("\x00 ") != str(value).rstrip():
                    setattr(self._memobj.intro, "line%d" % n,
                            str(value).ljust(16)[:16])
            elif name == "password":
                digits = "".join(c for c in str(value) if c.isdigit())
                digits = digits.ljust(6, "0")[:6]
                raw = st.password.get_raw()
                if "".join(chr(b) for b in raw) != digits:
                    st.password = digits
            elif name == "light":
                st.light = int(value) - 1     # stored one less than shown
            elif re.match(r"^vfo\d_", name):
                i = int(name[3])
                what = name.split("_", 1)[1]
                if what == "freq":
                    try:
                        hz = int(round(float(str(value)) * 100000))
                    except ValueError:
                        continue
                    # a VFO transmits on its own frequency
                    self._memobj.vfo[i].rxfreq = hz
                    self._memobj.vfo[i].txfreq = hz
                elif what == "power":
                    self._memobj.vfo[i].power = int(value)
                elif what == "bw":
                    self._memobj.vfo[i].wide = int(value)
                elif what == "rev":
                    self._memobj.vfo[i].reverse = int(value)
                elif what == "talk":
                    self._memobj.vfo[i].talkaround = int(value)
            elif name == "fmvfo":
                self._memobj.fmvfo.freq = self._fm_hz(value)
            elif name.startswith("fmpreset"):
                idx = int(name[8:])
                self._memobj.fmpreset[idx].freq = self._fm_hz(value)
            else:
                setattr(st, name, int(value))

    @staticmethod
    def _fm_hz(value):
        """MHz as typed, in units of 10 Hz. Blank stores nothing."""
        text = str(value).strip()
        if not text:
            return 0xFFFFFFFF
        try:
            return int(round(float(text) * 100000))
        except ValueError:
            return 0xFFFFFFFF
