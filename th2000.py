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
th2000.py - clean-room reference implementation of the TYT TH-2000,
also sold as the UV-99 family
programming protocol and .icf codeplug format.

Derived by static analysis of TH-2000.exe (managed .NET assembly, namespace
_8890DTest, class Class1 / TongXun). No code from the original is reused - only
the wire format and file layout, which are facts about the hardware.

Two independent layers:

  1. ICF        - the on-disk codeplug text format; read and write it
                without a radio
  2. Radio      - the serial protocol (needs pyserial)

Both are usable on their own. You can build a full editor with layer 1 only and
never touch a radio, which is how you should start.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Memory map (from Class1..cctor)
# ---------------------------------------------------------------------------

CODEPLUG_SIZE = 0x2B80          # 11136 - ConMaxReadAdrr / ConMaxWriteAdrr
BLOCK_SIZE = 512                # ConOneTmReadCt / ConOneTmWriteCt

CHANNEL_COUNT = 200             # ConTotalRow + 1
CHANNEL_RECORD = 21             # ConOneChDatCt
CHANNEL_NAME_LEN = 10           # ConOneChNameDatCt

ADDR_CHANNELS = 0x0000          # ChInfAddr
ADDR_CH_NAMES = 0x1140          # ChInfNameAddr   (4416)
ADDR_CH_VALID = 0x1F00          # ChinfBegAddr    (7936) 32-byte bitmap
ADDR_CH_SKIP = 0x1F20           # ChSkipBegAddr   (7968) 32-byte bitmap
ADDR_BAND_LIMITS = 0x1F40       # FreBandBegAddr  (8000)
ADDR_POWERON_NAME = 0x1F70      # OpenRadioNameAddr (8048) 2 x 16 ASCII
ADDR_FRE_CODE = 0x1F90          # ConFreCodeBegAddr (8080)
ADDR_SETTINGS = 0x2020          # ConSetBegAddr   (8224)
ADDR_DTMF_CH = 0x2040           # ConDtmfChBegAddr (8256), 13 bytes each
ADDR_DTMF_SET = 0x2120          # ConDtmfSetAddr  (8480), 64 bytes
ADDR_2TONE_TX = 0x2160          # Tone2BegAddr    (8544), 11 bytes each
ADDR_2TONE_RX = 0x2220          # Tone2RxAddr     (8736)
ADDR_5TONE_TX = 0x2260          # Tone5TxBegAddr  (8800), 32 bytes each
ADDR_5TONE_SET = 0x2460         # Tone5SetAddr    (9312)
ADDR_5TONE_RX = 0x2480          # Tone5RxBegAddr  (9344), 16 bytes each
ADDR_FM_RADIO = 0x2500          # ConRadioBegAdd  (9472), 4 bytes each
ADDR_FM_ENABLE = 0x2580         # ConRadioEnableBegAdd (9600)
ADDR_FM_VFO = 0x2584            # ConFMVfoBegAdd  (9604)

# Separate address spaces, not part of the 0x2B80 codeplug:
ADDR_VOICE_BEGIN = 0x40000      # ConVoiceBegAdd
ADDR_VOICE_END = 0xD0000        # ConVoiceMaxAdd
ADDR_FONT_BEGIN = 0xD0000       # ConFontBegAdd
ADDR_FONT_END = 0x120000        # ConFontMaxAdd

TONE_OFF = 0x0FFF               # sentinel stored in tone slots when disabled

CTCSS = [
    62.5, 67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8,
    97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8,
    136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 169.9, 171.3,
    173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5,
    206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1,
]

TUNING_STEPS_KHZ = [2.5, 5.0, 6.25, 10.0, 12.5, 25.0, 50.0, 100.0]


# ---------------------------------------------------------------------------
# Tone encoding
# ---------------------------------------------------------------------------

# Tone words are 12 bits, not 16. The top nibble of each 16-bit slot carries
# unrelated flags (ChinfDetail_2.ChgChStringPro assembles them nibble by
# nibble). 0x0FFF in the low 12 bits means "no tone".
#
# CTCSS is stored as hz*10          -> 625 .. 2541
# DCS   is stored as the octal code -> 19 .. 492  (023 octal = 0x13)
# The two ranges do not overlap, so the value alone tells you which it is.

TONE_MAX_DCS = 0x0200           # anything below this is a DCS code


def encode_ctcss(hz: float) -> int:
    """88.5 -> 885 (0x0375, stored little-endian as 75 03)."""
    return int(round(hz * 10))


def decode_ctcss(word: int) -> float:
    return (word & 0x0FFF) / 10.0


def encode_dcs(code: int | str) -> int:
    """DCS codes are quoted in octal. '023' -> 0x13.

    Inversion is NOT part of this word - it lives in bits 6 and 7 of byte 11.
    """
    return int(str(code), 8)


def decode_dcs(word: int) -> str:
    return format(word & 0x0FFF, "03o")


def is_dcs(word: int) -> bool:
    return 0 < (word & 0x0FFF) < TONE_MAX_DCS


def is_off(word: int) -> bool:
    # 0x0FFF is the documented sentinel, but a zeroed slot means the same
    # thing: there is no DCS code 000, so zero cannot be a real tone.
    return (word & 0x0FFF) in (TONE_OFF, 0)


def tone_str(word: int, inverted: bool = False) -> str:
    if is_off(word):
        return "off"
    if is_dcs(word):
        return f"D{decode_dcs(word)}{'I' if inverted else 'N'}"
    return f"{decode_ctcss(word):.1f}"


# ---------------------------------------------------------------------------
# Channel record
# ---------------------------------------------------------------------------

# Bit layout of bytes 8..14, from ChinfDetail_2.ChgChStringPro. Combo boxes
# were named by cross-referencing load_GroBox1_comboBoxPro (which table fills
# which control) against Class1.lableArrName_Ch_En (the UI labels).
#
#   byte  8..9   RX tone, low 12 bits ("Decode")
#         9      bits 12-15  scrambler, 0=off 1-8   (ScrChSet_EngCh)
#   byte 10..11  TX tone, low 12 bits ("Encode")
#        11      bit 12      tone-mode flag (checkBox6, unconfirmed)
#                bit 14      RX DCS inverted
#                bit 15      TX DCS inverted
#   byte 12      bit 0       boolean A (checkBox4)
#                bit 1       boolean B (checkBox3)
#                bits 2-3    busy lock   OFF / Sub / Carrier
#                bits 4-5    bandwidth   Wide / Mid / Narrow
#                bits 6-7    tx power    High / Mid / Low
#   byte 13      bit 0       boolean C (checkBox5)
#                bit 1       boolean D (checkBox2)
#                bit 2       name present (tail != all spaces)
#                bits 3-4    signalling  OFF / DTMF / 2TONE / 5TONE
#                bits 5-7    squelch mode SQ / CT / Tone / CT+Tone / CTC&Tone
#   byte 14      bits 0-3    tuning step (index into TUNING_STEPS_KHZ)
#                bits 4-5    DTMF PTT-ID  OFF / BEGIN / END / BOTH
#                bits 6-7    5-tone PTT-ID OFF / BEGIN / END / BOTH
#
# The four booleans are Compander, Tx Inhibit, Reverse and Talk Around in some
# order - the labels are known but the control-to-label pairing is not, and one
# diff per checkbox in the original CPS settles it.

TX_POWER = ["High", "Mid", "Low"]
BANDWIDTH = ["Wide", "Mid", "Narrow"]
BUSY_LOCK = ["OFF", "Sub", "Carrier"]
SIGNALLING = ["OFF", "DTMF", "2TONE", "5TONE"]
SQUELCH_MODE = ["SQ", "CT", "Tone", "CT/Tone", "CTC&Tone"]
PTT_ID = ["OFF", "BEGIN", "END", "BOTH"]
SCRAMBLER = ["OFF", "1", "2", "3", "4", "5", "6", "7", "8"]


def _bits(v: int, lo: int, n: int) -> int:
    return (v >> lo) & ((1 << n) - 1)


def _put(v: int, lo: int, n: int, x: int) -> int:
    mask = ((1 << n) - 1) << lo
    return (v & ~mask) | ((x << lo) & mask)


def _bw(v):
    return BANDWIDTH[v] if v < 3 else "?"


def _pw(v):
    return TX_POWER[v] if v < 3 else "?"


@dataclass
class Channel:
    """One 21-byte channel record plus its 10-byte name from the name table."""
    index: int
    rx_hz: int = 0
    tx_hz: int = 0
    rx_tone: int = TONE_OFF         # low 12 bits only
    tx_tone: int = TONE_OFF
    scrambler: int = 0              # 0 = off, 1..8
    rx_dcs_invert: bool = False
    tx_dcs_invert: bool = False
    tone_mode_flag: bool = False    # checkBox6, meaning unconfirmed
    # tx tone word bit 13 - carried through, never dropped
    unknown13: bool = False
    bool_a: bool = False            # checkBox4
    bool_b: bool = False            # checkBox3
    bool_c: bool = False            # checkBox5
    bool_d: bool = False            # checkBox2
    busy_lock: int = 0
    bandwidth: int = 0
    tx_power: int = 0
    signalling: int = 0
    squelch_mode: int = 0
    step: int = 0
    dtmf_ptt_id: int = 0
    tone5_ptt_id: int = 0
    # The displayed name is 16 characters: the first 6 live in the record at
    # offset 15, the remaining 10 in the separate table at 0x1140. CHIRP's
    # th_uv88 driver concatenates them the same way.
    name: str = ""
    valid: bool = False
    skip: bool = False

    @property
    def rx_mhz(self) -> float:
        return self.rx_hz / 1_000_000

    @property
    def tx_mhz(self) -> float:
        return self.tx_hz / 1_000_000

    @classmethod
    def unpack(cls, index: int, rec: bytes, name: bytes,
               valid: bool, skip: bool):
        rx, tx, rxw, txw = struct.unpack_from("<IIHH", rec, 0)
        b12, b13, b14 = rec[12], rec[13], rec[14]
        return cls(
            index=index,
            rx_hz=rx * 10,                  # stored in units of 10 Hz
            tx_hz=tx * 10,
            rx_tone=rxw & 0x0FFF,
            tx_tone=txw & 0x0FFF,
            scrambler=_bits(rxw, 12, 4),
            tone_mode_flag=bool(txw & 0x1000),
            unknown13=bool(txw & 0x2000),
            rx_dcs_invert=bool(txw & 0x4000),
            tx_dcs_invert=bool(txw & 0x8000),
            bool_a=bool(b12 & 0x01),
            bool_b=bool(b12 & 0x02),
            busy_lock=_bits(b12, 2, 2),
            bandwidth=_bits(b12, 4, 2),
            tx_power=_bits(b12, 6, 2),
            bool_c=bool(b13 & 0x01),
            bool_d=bool(b13 & 0x02),
            signalling=_bits(b13, 3, 2),
            squelch_mode=_bits(b13, 5, 3),
            step=_bits(b14, 0, 4),
            dtmf_ptt_id=_bits(b14, 4, 2),
            tone5_ptt_id=_bits(b14, 6, 2),
            name=(rec[15:21] + name).decode("latin1").rstrip("\x00 "),
            valid=valid,
            skip=skip,
        )

    def pack(self) -> bytes:
        rxw = (self.rx_tone & 0x0FFF) | ((self.scrambler & 0xF) << 12)
        txw = (self.tx_tone & 0x0FFF)
        txw |= 0x1000 if self.tone_mode_flag else 0
        txw |= 0x2000 if self.unknown13 else 0
        txw |= 0x4000 if self.rx_dcs_invert else 0
        txw |= 0x8000 if self.tx_dcs_invert else 0

        b12 = 0
        b12 |= 0x01 if self.bool_a else 0
        b12 |= 0x02 if self.bool_b else 0
        b12 = _put(b12, 2, 2, self.busy_lock)
        b12 = _put(b12, 4, 2, self.bandwidth)
        b12 = _put(b12, 6, 2, self.tx_power)

        b13 = 0
        b13 |= 0x01 if self.bool_c else 0
        b13 |= 0x02 if self.bool_d else 0
        b13 |= 0x04 if self.name.strip() else 0      # name-present flag
        b13 = _put(b13, 3, 2, self.signalling)
        b13 = _put(b13, 5, 3, self.squelch_mode)

        b14 = _put(_put(_put(0, 0, 4, self.step),
                        4, 2, self.dtmf_ptt_id),
                   6, 2, self.tone5_ptt_id)

        rec = struct.pack("<IIHHBBB", self.rx_hz // 10, self.tx_hz // 10,
                          rxw, txw, b12, b13, b14)
        rec += self._padded_name()[:6]
        assert len(rec) == CHANNEL_RECORD
        return rec

    def _padded_name(self) -> bytes:
        return self.name.encode("latin1")[:16].ljust(16, b" ")

    def pack_name(self) -> bytes:
        """The tail 10 characters, which live in the table at 0x1140."""
        return self._padded_name()[6:16]

    def describe(self) -> str:
        return (f"{self.index:3d} {self.name:<10s} "
                f"rx {self.rx_mhz:10.5f}  tx {self.tx_mhz:10.5f}  "
                f"enc {tone_str(self.tx_tone, self.tx_dcs_invert):>7s} "
                f"dec {tone_str(self.rx_tone, self.rx_dcs_invert):>7s}  "
                f"{_pw(self.tx_power):<5s} "
                f"{_bw(self.bandwidth):<7s} "
                f"{TUNING_STEPS_KHZ[self.step] if self.step < 8 else '?'}K"
                f"{'  [skip]' if self.skip else ''}")

    __str__ = describe


# ---------------------------------------------------------------------------
# Codeplug image
# ---------------------------------------------------------------------------

class Codeplug:
    """The 11136-byte radio image, with typed accessors."""

    def __init__(self, data: bytes | None = None):
        self.data = bytearray(data or bytes(CODEPLUG_SIZE))
        if len(self.data) < CODEPLUG_SIZE:
            self.data.extend(b"\xFF" * (CODEPLUG_SIZE - len(self.data)))

    # --- bitmaps ----------------------------------------------------------
    # Class2.StringChUsefulPro: byte = base + i // 8, mask = 1 << (i % 8)

    def _bit(self, base: int, i: int) -> bool:
        return bool(self.data[base + i // 8] & (1 << (i % 8)))

    def _set_bit(self, base: int, i: int, on: bool) -> None:
        off, mask = base + i // 8, 1 << (i % 8)
        if on:
            self.data[off] |= mask
        else:
            self.data[off] &= ~mask & 0xFF

    # --- channels ---------------------------------------------------------

    def channel(self, i: int) -> Channel:
        if not 0 <= i < CHANNEL_COUNT:
            raise IndexError(i)
        off = ADDR_CHANNELS + i * CHANNEL_RECORD
        noff = ADDR_CH_NAMES + i * CHANNEL_NAME_LEN
        return Channel.unpack(
            i,
            bytes(self.data[off:off + CHANNEL_RECORD]),
            bytes(self.data[noff:noff + CHANNEL_NAME_LEN]),
            valid=self._bit(ADDR_CH_VALID, i),
            # NOTE inverted: the bit means "allow in scan", so skip = not bit
            skip=not self._bit(ADDR_CH_SKIP, i),
        )

    def set_channel(self, ch: Channel) -> None:
        off = ADDR_CHANNELS + ch.index * CHANNEL_RECORD
        noff = ADDR_CH_NAMES + ch.index * CHANNEL_NAME_LEN
        self.data[off:off + CHANNEL_RECORD] = ch.pack()
        self.data[noff:noff + CHANNEL_NAME_LEN] = ch.pack_name()
        self._set_bit(ADDR_CH_VALID, ch.index, ch.valid)
        self._set_bit(ADDR_CH_SKIP, ch.index, not ch.skip)

    def clear_channel(self, index: int) -> None:
        """Delete a channel: blank the record and clear its in-use bit."""
        off = ADDR_CHANNELS + index * CHANNEL_RECORD
        noff = ADDR_CH_NAMES + index * CHANNEL_NAME_LEN
        self.data[off:off + 15] = b"\xFF" * 15
        self.data[off + 15:off + CHANNEL_RECORD] = b" " * 6
        self.data[noff:noff + CHANNEL_NAME_LEN] = b" " * CHANNEL_NAME_LEN
        self._set_bit(ADDR_CH_VALID, index, False)
        self._set_bit(ADDR_CH_SKIP, index, True)

    def channels(self, only_valid: bool = True):
        for i in range(CHANNEL_COUNT):
            ch = self.channel(i)
            if ch.valid or not only_valid:
                yield ch

    # --- misc -------------------------------------------------------------

    @property
    def band_limits(self):
        """Six 8-byte (low, high) slots between 0x1F40 and 0x1F70 - matches
        ConMaxVfo = 6. Unused slots are 0xFF-filled and come back
        as None."""
        out = []
        for n in range(6):
            off = ADDR_BAND_LIMITS + n * 8
            raw = self.data[off:off + 8]
            if raw == b"\xFF" * 8:
                out.append(None)
                continue
            lo, hi = struct.unpack("<II", raw)
            out.append((lo * 10, hi * 10))
        return out

    @property
    def poweron_name(self) -> str:
        raw = self.data[ADDR_POWERON_NAME:ADDR_POWERON_NAME + 16]
        return raw.decode("latin1").rstrip()

    @poweron_name.setter
    def poweron_name(self, s: str) -> None:
        self.data[ADDR_POWERON_NAME:ADDR_POWERON_NAME + 16] = \
            s.encode("latin1")[:16].ljust(16, b" ")

    @property
    def band_label(self) -> str:
        a = ADDR_POWERON_NAME + 16
        return self.data[a:a + 16].decode("latin1").rstrip()


# ---------------------------------------------------------------------------
# .icf file format
# ---------------------------------------------------------------------------
#
#   line 1  : COM port the file was last used with, e.g. "COM1"
#   line 2  : "#Comment=... #MapRev=1"
#   line 3  : baud rate, e.g. "38400"
#   line 4+ : AAAALLDDDD...  - 4 hex address, 2 hex length (always 0x20),
#             then length*2 hex digits. 70 chars per line.
#
# Line endings in the shipped files are a mix of CRLF and bare CR. Anything
# that splits on both reads them fine; write CRLF.

ICF_ROW_BYTES = 32              # ConOneRowDatCt


def icf_load(path: str) -> tuple[dict, Codeplug]:
    raw = open(path, "r", newline="").read()
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    header = {"com": lines[0].strip(), "comment": lines[1].strip(),
              "baud": lines[2].strip()}
    mem = {}
    for line in lines[3:]:
        line = line.strip()
        if len(line) < 6:
            continue
        addr = int(line[0:4], 16)
        n = int(line[4:6], 16)
        chunk = bytes.fromhex(line[6:6 + n * 2])
        for i, b in enumerate(chunk):
            mem[addr + i] = b
    size = max(mem) + 1 if mem else 0
    buf = bytearray(size)
    for a, b in mem.items():
        buf[a] = b
    return header, Codeplug(bytes(buf))


def icf_save(path: str, cp: Codeplug, header: dict | None = None) -> None:
    h = header or {"com": "COM1",
                   "comment": "#Comment=TYT INC.(C)  2013  #MapRev=1",
                   "baud": "38400"}
    data = bytes(cp.data)
    # pad up to a whole number of rows
    if len(data) % ICF_ROW_BYTES:
        data += b"\x00" * (ICF_ROW_BYTES - len(data) % ICF_ROW_BYTES)
    with open(path, "w", newline="") as f:
        f.write(h["com"] + "\r\n")
        f.write(h["comment"] + "\r\n")
        f.write(h["baud"] + "\r\n")
        for addr in range(0, len(data), ICF_ROW_BYTES):
            row = data[addr:addr + ICF_ROW_BYTES]
            f.write(f"{addr:04X}{len(row):02X}{row.hex().upper()}\r\n")


# ---------------------------------------------------------------------------
# Serial protocol
# ---------------------------------------------------------------------------
#
# Every frame:  FE FE <dst> <src> <opcode> [payload...] FD
#   PC  -> radio : dst=EE src=EF
#   radio -> PC  : dst=EF src=EE
#
# The 5-byte header and the trailing FD go out verbatim. Everything between
# them is (a) covered by an 8-bit additive checksum appended to the payload,
# then (b) byte-stuffed so no reserved byte (FA..FF) can appear mid-frame:
#
#   v = (b + 0x80) & 0xFF
#   v <= 0xF9  ->  emit v
#   v >  0xF9  ->  emit 0xFF, then (v & 0x0F)
#
# Decode is the exact inverse. This is what the original calls
# DataEncodPro / DataDecodPro / AddDataLRCPro.

MODEL_ID = b"2000"              # ConRadioType, ASCII

HDR_TX = b"\xFE\xFE\xEE\xEF"    # PC -> radio
HDR_RX = b"\xFE\xFE\xEF\xEE"    # radio -> PC
END = 0xFD

OP_HANDSHAKE = 0xE0
OP_HANDSHAKE_ACK = 0xE1
OP_ENTER_READ = 0xE2
OP_ENTER_WRITE = 0xE3
OP_DATA = 0xE4                  # PC->radio: write block. radio->PC: read reply
OP_END = 0xE5
OP_BAUD = 0xE6
OP_ACK = 0xE6                   # radio->PC ack is FE FE EF EE E6 00 FD
OP_PROGRAM_CODE = 0xE7
OP_READ_BLOCK = 0xEB
OP_WRITE_BAND = 0xEC


def checksum(payload: bytes) -> int:
    """8-bit additive sum over the payload (AddDataLRCPro)."""
    return sum(payload) & 0xFF


def stuff(payload: bytes) -> bytes:
    out = bytearray()
    for b in payload:
        v = (b + 0x80) & 0xFF
        if v > 0xF9:
            out += bytes((0xFF, v & 0x0F))
        else:
            out.append(v)
    return bytes(out)


def unstuff(stuffed: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(stuffed):
        if stuffed[i] == 0xFF:
            v = 0xF0 | (stuffed[i + 1] & 0x0F)
            i += 2
        else:
            v = stuffed[i]
            i += 1
        out.append((v + 0x80) & 0xFF)
    return bytes(out)


def build(opcode: int, payload: bytes = b"") -> bytes:
    """Assemble a complete PC->radio frame."""
    body = payload + bytes((checksum(payload),))
    return HDR_TX + bytes((opcode,)) + stuff(body) + bytes((END,))


def parse(frame: bytes) -> tuple[int, bytes]:
    """Split a radio->PC frame into (opcode, payload).

    Raises on a bad checksum.
    """
    if not frame.startswith(HDR_RX) or frame[-1] != END:
        raise ValueError(f"not a radio frame: {frame.hex(' ')}")
    opcode = frame[4]
    body = unstuff(frame[5:-1])
    payload, got = body[:-1], body[-1]
    want = checksum(payload)
    if got != want:
        raise ValueError(f"checksum {got:02X} != {want:02X}")
    return opcode, payload


class Radio:
    """Serial session. Requires pyserial; import is deferred so the ICF half of
    this module works without it."""

    # The baud rate is cosmetic: the radio presents a USB CDC-ACM virtual COM
    # port (VID 2E3C / PID 8800, an ARTERY AT32 MCU), so there is no UART on
    # the link and the setting is discarded by firmware. 57600 matches the OEM
    # software.
    def __init__(self, port: str, baud: int = 57600, timeout: float = 2.0):
        import serial                                    # noqa: PLC0415
        self.ser = serial.Serial(port=port, baudrate=baud, bytesize=8,
                                 parity="N", stopbits=1, timeout=timeout,
                                 rtscts=False)
        self.ser.rts = True     # the original CPS asserts both
        self.ser.dtr = True

    def close(self):
        self.ser.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # --- framing ----------------------------------------------------------

    def _send(self, opcode: int, payload: bytes = b"") -> None:
        self.ser.write(build(opcode, payload))

    def _recv(self) -> tuple[int, bytes]:
        buf = bytearray()
        while True:
            b = self.ser.read(1)
            if not b:
                raise TimeoutError(f"timeout after {bytes(buf).hex(' ')}")
            buf += b
            if b[0] == END and len(buf) >= 6:
                return parse(bytes(buf))

    def _expect(self, opcode: int) -> bytes:
        op, payload = self._recv()
        if op != opcode:
            raise IOError(f"expected {opcode:02X}, got {op:02X}")
        return payload

    # --- session ----------------------------------------------------------

    def handshake(self) -> bytes:
        """Radio must be on and the cable seated. Returns its ident payload."""
        self._send(OP_HANDSHAKE, MODEL_ID)
        return self._expect(OP_HANDSHAKE_ACK)

    def end(self) -> None:
        self._send(OP_END, MODEL_ID)
        try:
            self._expect(OP_ACK)
        except (TimeoutError, IOError):
            pass    # the radio sometimes just drops the link here

    def _enter(self, opcode: int, size: int) -> None:
        self._send(opcode, struct.pack(">II", 0, size))
        self._expect(OP_ACK)

    def read_codeplug(self, size: int = CODEPLUG_SIZE,
                      progress=None) -> Codeplug:
        self.handshake()
        self._enter(OP_ENTER_READ, size)
        out = bytearray()
        addr = 0
        while addr < size:
            n = min(BLOCK_SIZE, size - addr)
            self._send(OP_READ_BLOCK, struct.pack(">IH", addr, n))
            payload = self._expect(OP_DATA)
            # reply payload: addr(4, BE) + len(2, BE) + data
            r_addr, r_len = struct.unpack_from(">IH", payload, 0)
            if r_addr != addr or r_len != n:
                raise IOError(f"block mismatch: asked {addr:X}/{n}, "
                              f"got {r_addr:X}/{r_len}")
            out += payload[6:6 + r_len]
            addr += n
            if progress:
                progress(addr, size)
        self.end()
        return Codeplug(bytes(out))

    def write_codeplug(self, cp: Codeplug, progress=None) -> None:
        data = bytes(cp.data)
        size = len(data)
        self.handshake()
        self._enter(OP_ENTER_WRITE, size)
        addr = 0
        while addr < size:
            n = min(BLOCK_SIZE, size - addr)
            self._send(OP_DATA,
                       struct.pack(">IH", addr, n) + data[addr:addr + n])
            self._expect(OP_ACK)
            addr += n
            if progress:
                progress(addr, size)
        self.end()


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("usage: th2000.py file.icf")
        raise SystemExit(1)
    hdr, cp = icf_load(sys.argv[1])
    print(hdr)
    print(f"power-on name : {cp.poweron_name!r}   label {cp.band_label!r}")
    for n, b in enumerate(cp.band_limits):
        if b:
            print(f"band slot {n}   : {b[0]/1e6:.4f} - {b[1]/1e6:.4f} MHz")
    print()
    for ch in cp.channels():
        print(ch)
