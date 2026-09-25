# TH-2000 — complete specification

Everything established about this radio, in one place: the transport, the
memory map, the field-level encodings, and how each was arrived at. Written so
that someone with none of the surrounding conversation can rebuild any of the
tools from it.

Two provenance markers appear throughout:

* **measured** — established by changing one thing in the manufacturer's
  software, saving, and diffing the bytes, or by reading a physical radio.
* **derived** — read out of the manufacturer's software by static analysis and
  not yet confirmed against hardware.

Where the two disagree, measured wins. Every disagreement found so far is
recorded rather than quietly resolved.

---

## 1. The radio and the link

TYT TH-2000, also sold as UV-99. Dual band, 108–174 and 400–480 MHz, 200
channels. The programming software is a .NET 2.0 WinForms application,
unobfuscated, internal namespace `_8890DTest` — inherited from the TH-8890D CPS,
which is why sibling models share so much.

**The link is USB, not a serial port.** *(measured)* The accessory jack carries a
real USB differential pair. The CPS looks for USB `VID 2E3C` / `PID 8800`;
`2E3C` belongs to ARTERY Technology, whose AT32 microcontrollers are
STM32-compatible parts with native USB, and `8800` matches the `UV8800`
power-on name stored in the codeplug. So the radio's own MCU implements USB
CDC-ACM and the host presents a virtual COM port. There is no RS-232 and no
USB-serial bridge chip.

Consequences:

* **Baud rate is meaningless.** It becomes a CDC `SET_LINE_CODING` request the
  firmware discards. This is why `setting.ini` says 57600 and the `.icf` header
  says 38400 with no visible effect. Use 57600 to match the OEM.
* RTS and DTR are equally meaningless, but asserted anyway — harmless, and the
  OEM does it.
* Web Serial reaches it; WebUSB would not, because the OS CDC driver claims the
  interface first.

### Connector

Eight pins on the RJ45: `AD2, AD1, MIC, GND, PTT, USBD+, VDD, USBD-`.

Measured on a real unit *(measured)*:

| Pin | Reading | Meaning |
|---|---|---|
| USBD+ | 3.27 V | 1.5 kΩ pull-up to 3.3 V — a **full-speed USB device**, self-identifying with nothing plugged in |
| USBD− | 0.99 V | floating; a meter's 10 MΩ input settles anywhere |
| VDD | 5 V | the radio **sources** this. An output, not a VBUS sense input |

**Wire GND, D+ and D− only.** Step-by-step instructions are in
[CABLE.md](CABLE.md). Do not connect VDD to the host's VBUS — that ties
the PC's 5 V rail to the radio's regulator. The D+ pull-up is already present so
enumeration does not need it.

VDD sits next to USBD+ on the connector and the MCU's USB transceiver is rated
for about 3.6 V. Shorting them while probing is the most realistic way to
damage this radio.

---

## 2. Wire protocol

Every frame:

```
FE FE <dst> <src> <op> [ stuffed( payload || checksum ) ] FD
```

* PC → radio: `dst=EE src=EF`
* radio → PC: `dst=EF src=EE`

The five-byte header and the trailing `FD` go out verbatim. Everything between
is transformed twice:

**1. Checksum.** Append one byte: the 8-bit additive sum of the payload.

**2. Byte stuffing**, so no reserved byte can appear mid-frame:

```
v = (b + 0x80) & 0xFF
if v <= 0xF9:  emit v
else:          emit 0xFF, then (v & 0x0F)
```

Decoding is the exact inverse. This is why a handshake looks like nonsense on a
scope: `FE FE EE EF E0` + `"2000"` becomes
`FE FE EE EF E0 B2 B0 B0 B0 42 FD`.

### Opcodes

| Op | Direction | Payload | Meaning |
|---|---|---|---|
| `E0` | → | `"2000"` | handshake |
| `E1` | ← | `"2000"` | handshake ack |
| `E2` | → | start(4, BE) + end(4, BE) | enter read mode |
| `E3` | → | start(4, BE) + end(4, BE) | enter write mode |
| `EB` | → | addr(4, BE) + len(2, BE) | request block |
| `E4` | ← | addr(4) + len(2) + data | block reply |
| `E4` | → | addr(4) + len(2) + data | write block |
| `E6` | ← | `00` | generic ack |
| `E6` | → | `"2000" 01` | set baud rate — vestigial here |
| `E5` | → | `"2000"` | end session |
| `E7` | → | — | program-code exchange, if a password is set |
| `EC` | → | — | write band limits |

Addresses and lengths are **big-endian on the wire**. Frequencies inside the
codeplug are **little-endian**. Mixing them up is the classic error.

### Session

```
handshake (E0 / E1)
enter read (E2, 0x00000000 .. 0x00002B80) → ack
22 × request block (EB, addr, 512)  → data (E4)     last block is 384 bytes
end (E5)
```

Write is identical with `E3` then `E4` per block, each acked with `E6`.

### A legacy framing exists

`chirp/drivers/th_uv88.py` covers a sibling that uses the **same opcodes** with
plain frames and a two's-complement checksum — no bias, no stuffing. The CPS
contains a method named `GetChkSum_AddrPro_Leg` ("Leg" for legacy), so both
schemes plausibly exist across the family. Both the CHIRP driver and the browser
tool can switch to it.

### What cannot be reached

There is **no bootloader, firmware-write or erase command** anywhere in the
protocol. *(measured — the whole binary was searched.)* The only `.bin` file
dialogue in the CPS is for voice prompts. A codeplug write cannot damage the
program that runs the radio.

---

## 3. Memory regions

The radio exposes several regions. A normal session touches one.

| Region | Range | Block | Reached by |
|---|---|---|---|
| **Codeplug** | `0x0000`–`0x2B80` | 512 B | plain `EB`/`E4` — this is what a read or write transfers, in full |
| Voice prompts | `0x40000`–`0xD0000` | 512 B | same commands, distinguished by the address alone |
| GB2312 font | `0xD0000`–`0x120000` | 512 B | same |
| **Alignment / calibration** | `0x0000`–`0x16BF` | 32 B | a **different bank**, entered with `F0`, read a byte at a time |
| Batch debug parameters | `0x0000`–`0x0380` | 32 B | same mechanism |

The first three share one flat address space — the address selects them, there
is no mode flag. **Calibration is the one behind a mode switch**, and it has to
be: it is addressed from zero and would otherwise collide with the channels.
`TestModDef.icf` is its default image and covers exactly `0x0000`–`0x16BF`,
matching the `ConMaxReadAdrr = 5823` the alignment window declares.

**A codeplug backup therefore contains no calibration, voice or font.** That
cuts both ways: no codeplug write can damage the alignment, but no `.icf` will
restore it either. The only route to a calibration backup is the OEM software's
test screen (`SaveAllDataToTestFile1`), read-and-save, never write.

---

## 4. Codeplug map — 11136 bytes

| Address | Size | Contents |
|---|---|---|
| `0x0000` | 200 × 21 | channel records |
| `0x1068` | 10 × 21 | **VFO records**. Slots 204-209 are two VFOs, one per band: 204/206 are the left display row's VHF and UHF, 207/209 the right. 205 and 208 are a 220 MHz band this radio does not have. Slots 200-203 hold the factory default and appear unused. *(measured)* |
| `0x1140` | 200 × 10 | channel names, tail 10 characters |
| `0x1910` | 34 | space-filled, unidentified |
| `0x1932` | ~1486 | `0xFF`, unused |
| `0x1F00` | 25 + 7 | in-use bitmap, one bit per channel |
| `0x1F20` | 25 + 7 | scan bitmap — **set means allow**, clear means skip |
| `0x1F40` | 6 × 8 | band limit slots (low, high) |
| `0x1F70` | 2 × 16 | intro screen, two lines of ASCII |
| `0x1F90` | 144 | frequency-code region, `0xFF` on the test radio |
| `0x2020` | 32 | global settings — see §6 |
| `0x2040` | 224 | DTMF channels, 13 bytes each |
| `0x2120` | 64 | DTMF settings |
| `0x2160` | 192 | 2-tone TX, 11 bytes each |
| `0x2220` | 64 | 2-tone RX |
| `0x2260` | 512 | 5-tone TX, 32 bytes each |
| `0x2460` | 32 | 5-tone settings |
| `0x2480` | 128 | 5-tone RX, 16 bytes each |
| `0x2500` | 32 × 4 | FM broadcast presets |
| `0x2580` | 4 | FM preset enable bitmap *(derived)* |
| `0x2584` | 4 | FM VFO |
| `0x2600` | 1408 | `0xFF` on the test radio |

**The in-use bitmap is the sole authority on which channels exist.** *(measured)*
Every one of the 200 records on a factory radio holds the same default pattern;
only the bitmap distinguishes a real channel. Never judge occupancy from record
content.

`.icf` files written by the OEM cover `0x0000`–`0x3100`. The 1408 bytes past
`0x2B80` are template padding, byte-identical between a factory file and a real
radio read, and are correctly discarded.

---

## 5. Channel record — 21 bytes

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | RX frequency, LE uint32, **units of 10 Hz** |
| 4 | 4 | TX frequency, same |
| 8 | 2 | RX tone word |
| 10 | 2 | TX tone word |
| 12 | 1 | flags |
| 13 | 1 | flags |
| 14 | 1 | flags |
| 15 | 6 | name, first 6 characters — the other 10 live at `0x1140` |

`145.025 MHz` → `14502500` → `64 4A DD 00`.

A TX frequency of `0xFFFFFFFF` means **do not transmit**; zero means nothing has
been set. Neither transmits. Writing this test out by hand in several places is
how one formatter came to print 42949.67295 MHz — it should exist once.

### Tone words are 12 bits, not 16

The top nibble carries unrelated flags.

* **CTCSS** = `round(hz × 10)` → 625…2541
* **DCS** = the octal code as a plain integer → 19…492
* The ranges do not overlap, so the value alone identifies which. Below `0x200`
  it is DCS.
* `0x0FFF` means no tone. **Zero also means no tone** — there is no DCS code
  000, so a zeroed slot cannot be a real tone. *(measured: a formatter that
  missed this rendered `D000`, which then would not parse back.)*

The radio's `DcsTone` table holds exactly the 104 standard codes, 023 to 754 —
identical to `chirp_common.DTCS_CODES`. Do not claim the raw 0–511 range.

### Bit layout, bytes 8–14

| Byte | Bits | Field | Values |
|---|---|---|---|
| 8–9 | 0–11 | RX tone ("Decode") | see above |
| 9 | 12–15 | Scrambler | OFF, 1–8 |
| 10–11 | 0–11 | TX tone ("Encode") | |
| 11 | 12 | tone-mode flag | *unconfirmed* |
| 11 | 14 | RX DCS inverted | **disputed — see below** |
| 11 | 15 | TX DCS inverted | **disputed** |
| 12 | 0 | unknown | one of Compander / TX Inhibit |
| 12 | 1 | **Reverse** | *(measured)* |
| 12 | 2–3 | Busy Lock | OFF, Sub, Carrier |
| 12 | 4–5 | Bandwidth | Wide, Mid, Narrow |
| 12 | 6–7 | TX Power | High, Mid, Low |
| 13 | 0 | unknown | the other of Compander / TX Inhibit |
| 13 | 1 | **Talk around** | *(measured)* |
| 13 | 2 | name present | |
| 13 | 3–4 | Signalling | OFF, DTMF, 2TONE, 5TONE |
| 13 | 5–7 | Squelch Mode | SQ, CT, Tone, CT/Tone, CTC&Tone |
| 14 | 0–3 | Tuning Step | 2.5 / 5 / 6.25 / 10 / 12.5 / 25 / 50 / 100 kHz |
| 14 | 4–5 | DTMF PTT-ID | OFF, BEGIN, END, BOTH |
| 14 | 6–7 | 5-tone PTT-ID | OFF, BEGIN, END, BOTH |

**The disputed bits.** CHIRP's `th_uv88.py` places `decodeDSCI` at bit 15 and
`encodeDSCI` at bit 14. This radio's own software does the opposite:
`ChgChStringPro` tests the decode combo into bit 6 of byte 11 (word bit 14) and
the encode combo into bit 7 (bit 15). One of the two is wrong. The tools here
follow the software. It only affects inverted DCS.

**Two of the four booleans are now named.** *(measured)* Single-change saves
from the manufacturer's VFO window put **Reverse** at byte 12 bit 1 and **Talk
around** at byte 13 bit 1. The remaining pair - byte 12 bit 0 and byte 13 bit 0
- are Compander and TX Inhibit in some order. The VFO window does not offer
either, so they cannot be diffed the same way.

**Three fields named here that `th_uv88` marks unknown:** the squelch mode, the
5-tone PTT-ID, and the true four-bit width of the step field. Those should
transfer back to that driver cleanly.

---

## 6. Global settings — 32 bytes at 0x2020

Every field below was **measured** — 59 observations, one setting changed at a
time. Bit positions and widths come from those bytes; option labels come from
the literal string tables in the CPS.

| Offset | Bits | Field | Encoding |
|---|---|---|---|
| +0 | 0–3 / 4–7 | P1 short / P2 short | index into the key list |
| +1 | 0–3 / 4–7 | P1 long / P2 long | |
| +2 | 0–1 | RX light | Always On, Code On, OFF |
| +3 | 0–4 | Volume level | **the number itself**, 0–31 |
| +4…+11 | — | **unmapped** | `00 00 00 00 00 00 03 00` on the test radio |
| +12 | 0–3 | Squelch level | OFF, 1–9 |
| +13 | 0 | TX channel | Main CH, Last CH |
| +13 | 3–4 | Intro screen | OFF, Voltage, Char String |
| +13 | 7 | Beep | OFF, ON |
| +14 | 0–3 | Time-out timer | OFF, 30…270 Second — **an index, not seconds** |
| +14 | 5–6 | Auto power off | OFF, 30 Minute, 1 Hour, 2 Hour |
| +15 | 6 | TX tone | OFF, END |
| +16 | 0–2 | LED mode | OFF, ON, 5S…30S |
| +16 | 4–5 | Display mode | Frequency, Channel, Name |
| +16 | 6–7 | Scan type | To, Co, Se |
| +17 | — | **unmapped** | |
| +18 | 6 | Eliminate squelch tail | full OEM label: *…When No CTC/DCS Signaling* |
| +18 | 7 | Boot-strap password enable | |
| +19 | — | **unmapped** | |
| +20 | 0–2 | Backlight | **the number minus one**: display 1–7 stores 0–6 |
| +20 | 4 | Dual watch | |
| +20 | 5 | Key lock | OFF, Auto |
| +20 | 6 | Radio monitor | |
| +21 | — | **unmapped** | |
| +22 | 0–1 | Key mode | ALL, PTT, KEY, KEY & Side Key |
| +23 | 0–3 / 4–7 | P3 short / P3 long | |
| +24 | 0–3 / 4–7 | P4 short / P4 long | |
| +25 | 0–3 / 4–7 | P5 short / P5 long | **P5 long is the power button and not assignable** |
| +26…+31 | — | Boot-strap password | six ASCII digits |

**The two numeric fields encode differently.** Volume stores the number you see;
backlight stores one less. Either one guessed from its option list would have
been wrong, silently. This is the single strongest argument for measuring rather
than inferring.

### Key function list — 14 options, index 0–13

```
0 None        4 KEY-10MHZ   8 KEY-A/B     12 Talk Around
1 KEY-Low     5 KEY-TONE    9 KEY-Band    13 Frequency Reverse
2 KEY-Shift   6 KEY-M/V    10 KEY-MONI
3 KEY-MHZ     7 KEY-Save   11 1750 TONE
```

Confirmed nine times over: every key slot on the test radio held a different
one of these and each decoded to the label the OEM software showed.

### The unmapped run at +4 to +11

Eight contiguous bytes nothing in the settings dialogue touches, identical
between a factory template and a real radio. The OEM's own
`GetSetDataStringPro` **explicitly copies them through** rather than rebuilding
them, along with +11, +18 and +19. Two candidates: a Bluetooth group hidden on
models without the module, or runtime state the firmware maintains. Not
distinguishable from static analysis. A read-twice-with-use-in-between
experiment would settle it. Either way they are preserved, never written.

---

## 7. FM broadcast block

32 presets of 4 bytes at `0x2500`, same 10 Hz little-endian encoding as the
channels — a factory radio holds 90.400 MHz in every slot, with the VFO at
`0x2584` holding 90.600. *(measured)*

The 4 bytes at `0x2580` look like one enable bit per preset. That is *derived*,
inferred from a factory image where every preset holds the same value, and is
the only part of this block not confirmed.

---

## 8. The `.icf` file format

```
COM1
#Comment=TYT INC.(C)  2013  #MapRev=1
38400
000020<64 hex digits>
002020<64 hex digits>
...
```

Line 1 is the last COM port used, line 2 a comment with a map revision, line 3
the baud rate. Then one 70-character record per line: 4 hex digits of address,
2 of length (always `0x20`), then 32 bytes as hex. Line endings mix CRLF and
bare CR — split on both, write CRLF. The OEM pads the end of the file with bare
CRs, and the count varies between saves.

**Files that look like this but are not for this radio.** The installer ships
`DefaulFile_136.icf`, `_400`, `_136_174_400_480` and `_136_174_400_520`. They
use the same 21-byte channel record but a different layout above the channel
array — one has a channel named `GMR50`, suggesting a GMRS sibling. **Nothing
in the header distinguishes them**: same comment, same `#MapRev=1`, same 392
records, same coverage.

Two checks separate them reliably: is `0x1F70` printable text, and do the band
slots hold sane frequency pairs. Yes for this radio, no for all of those.

---

## 9. Encodings worth stating once

| Thing | Rule |
|---|---|
| Frequencies | LE uint32, units of 10 Hz |
| CTCSS | hz × 10 |
| DCS | the octal code as a plain integer |
| No tone | `0x0FFF` **or** zero |
| No transmit | TX frequency `0xFFFFFFFF`; zero means not yet set |
| In-use bitmap | bit set = channel exists |
| Scan bitmap | bit set = **allow**, clear = skip |
| Volume | the number itself |
| Backlight | the number minus one |
| Time-out timer | option index |
| Channel name | 6 characters in the record, 10 more in the table, one 16-character name |

---

## 10. Verification status

**Confirmed against a physical radio:** the whole channel record, the bitmaps,
band limits, intro lines, FM presets and VFO, all 29 settings fields, the key
function list, the `.icf` format, the read path end to end, and the USB
identity.

A VFO stores a **transmit frequency**, not an offset. *(measured)* The
manufacturer's window presents direction and offset; setting −0.600 on a
145.500 VFO writes 144.900 into bytes 4-7.

**Not confirmed against hardware:** the write path. Every implementation here
agrees with the simulators and with each other, but no byte has been written to
a radio. Read first, save that file, and treat the first write as a test.

**Known disputes:** the two DCS inversion bits, against `th_uv88.py`.

**Known unknowns:** eleven bytes of the settings block, four channel booleans,
the FM enable bitmap, the tone-mode flag at byte 11 bit 12, and 34 space-filled
bytes at `0x1910`.

---

## 11. Method, if you extend this

The thing that worked was never trusting decompiled code over bytes. The
procedure:

1. Read the radio, save it as a baseline.
2. Change **one** setting in the manufacturer's software, save.
3. Compare — the bits that moved are the answer.
4. Take the field to the **top** of its range, not just one step. A field's
   width only shows in the bits that actually move: 0 → 3 in a 3-bit field moves
   two bits and tells you nothing about the third.
5. For anything numeric, two points. That is how the volume/backlight
   difference surfaced.

`web/th2000-compare.html` exists for exactly this and keeps the log for
you. See [MAPPING-GUIDE.md](MAPPING-GUIDE.md).

Three faults were found by *disagreement between implementations* rather than by
any single test: a name modelled as two fields instead of one, a tone value
silently dropped, and a summary that could not account for its own byte count.
Keeping two independent implementations cross-checked was worth more than
adding tests to either.
