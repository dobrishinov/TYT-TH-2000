# TH-2000 CPS — what's inside, and what you need to write your own

Static analysis only. Nothing was executed.

---

## 1. What the file actually is

`TH-2000_20260210(1).exe` is **not** the programming software. It's a self-extracting
installer stub:

| | |
|---|---|
| Format | PE32 GUI, MSVC 6 linker, 4 sections, 64 KB of code |
| Timestamp | 2002-11-18 (the stub, not the payload) |
| SFX family | `<AE_SEA>` footer magic, `[SETUP_INFO] Version=1.9.11` |
| Layout | PE stub · plaintext setup script · ZIP payload · `<AE_SEA>` |
| SHA-256 | `879e8cb35e52156d2ec31c0ecd858ea8fd45790000def5fcef6bbae4a17cae08` |

The payload is a plain ZIP of concatenated local file headers (no central
directory) whose members are named `1`…`14`. The setup script maps them to real
names. All 15 members inflate with CRC intact:

| Member | File | Notes |
|---|---|---|
| 14 | **TH-2000.exe** (1.44 MB) | the actual CPS — .NET 2.0 WinForms |
| 2 | ChineseConverter.dll | .NET, simplified/traditional conversion |
| 3–7 | `DefaulFile*.icf` | default codeplugs per band variant |
| 12–13 | `TestModDef*.icf` | factory alignment defaults |
| 1 | AllTestModDef.icf | one-record alignment stub |
| 8 | English_TH2000.s2g | installer *project file*, shipped by mistake |
| 11 | setting.ini | runtime config |
| 9, 10 | logo.ico, pictureBoxImag.jpg | branding |
| — | uninstall.exe | UPX-packed |

**The good news:** `TH-2000.exe` is a **.NET 2.0 assembly with no obfuscation
whatsoever** — real class names, real method names, string literals in the
clear. Assembly version `1.10.9583.16203`, internal namespace `_8890DTest`
(inherited from the TH-8890D CPS), built around 2023-11-13.

Interestingly, the hard-coded defaults in the binary say `RadioName = "UV-99"`;
`setting.ini` overrides it to `TH-2000`. One binary drives a family of radios,
and what actually identifies the model on the wire is a four-ASCII-byte model
ID (`"2000"`). The power-on name in the default codeplug still reads `UV8800`.

If you want a GUI decompile rather than my extracted facts, drop `TH-2000.exe`
into **ILSpy** or **dnSpy** and you'll get near-original C# — including the
WinForms designer code, which tells you what every combo box maps to.

---

## 2. Serial protocol

8N1, RTS and DTR both asserted, `Baudradio=57600` in `setting.ini`.

**The baud rate does not matter, because there is no UART on the link.** The
radio's accessory jack carries a genuine USB differential pair (`USBD+` /
`USBD-`), and the CPS looks for USB `VID 2E3C` / `PID 8800` — `2E3C` belongs to
ARTERY Technology, a maker of STM32-compatible AT32 microcontrollers with
native USB peripherals, and `8800` matches the `UV8800` power-on name stored in
the codeplug. So the radio's own MCU implements USB CDC-ACM in firmware; the
host binds `usbser.sys` (or `cdc_acm`) and presents a virtual COM port, which
is why the CPS opens a `System.IO.Ports.SerialPort` and finds it by querying
WMI for that VID/PID.

Baud, parity and RTS/DTR therefore travel as CDC `SET_LINE_CODING` and
`SET_CONTROL_LINE_STATE` requests that firmware normally discards. That is why
`setting.ini` and the `.icf` header disagree (57600 vs 38400) with no visible
consequence, and why the protocol carries an apparently pointless "set baud
rate" command — see the note under the opcode table. Set whatever you like;
57600 is what the OEM software uses.

Confirm on your own unit with `lsusb`: `2e3c:8800` on `/dev/ttyACM0` is native
USB. A `/dev/ttyUSB0` with `1a86:`, `10c4:` or `0403:` would mean a bridge chip
after all. On Windows, Hardware IDs of `USB\VID_2E3C&PID_8800` bound to
`usbser.sys` says the same thing; on macOS, `/dev/cu.usbmodem*` rather than
`/dev/cu.usbserial*`.

There is no RS-232 anywhere: the connector has no TX/RX pins, and RS-232 would
need ±12 V line drivers besides.

### Frame

```
FE FE <dst> <src> <op> [ stuffed( payload || checksum ) ] FD
```

* PC → radio: `dst=EE src=EF` → header `FE FE EE EF`
* radio → PC: `dst=EF src=EE` → header `FE FE EF EE`

The 5-byte header and the final `FD` go out verbatim. Everything between them
is transformed in two steps:

**Step 1 — checksum.** Append one byte: the 8-bit additive sum of the payload.
(`AddDataLRCPro`.)

**Step 2 — byte stuffing**, so no reserved byte can appear mid-frame
(`DataEncodPro`):

```
v = (b + 0x80) & 0xFF
if v <= 0xF9:  emit v
else:          emit 0xFF, then (v & 0x0F)
```

Decoding is the exact inverse. I verified this round-trips all 256 byte values
and never emits `FA`–`FE` in the body.

That `+0x80` is why a handshake looks like nonsense on a scope:
`FE FE EE EF E0` + `"2000"` becomes `FE FE EE EF E0 B2 B0 B0 B0 42 FD`
(`32 30 30 30` → `B2 B0 B0 B0`, checksum `0xC2` → `0x42`).

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
| `E6` | → | `"2000" 01` | set baud rate (see below) |
| `E5` | → | `"2000"` | end session |
| `E7` | → | — | program-code / password exchange |
| `EC` | → | — | write band limits |

The `E6` set-baud command is almost certainly vestigial here. It makes sense on
the UART-based siblings such as the TH-UV88, which connect through a cable with
a bridge chip in it, but this radio's link is USB from end to end. The driver
and the browser tool both leave it alone.

Addresses and lengths are **big-endian on the wire**; frequencies inside the
codeplug are **little-endian**. Don't mix them up — I did briefly.

### Session

```
handshake (E0/E1)
  → optional program-code exchange (E7) if the radio has a password set
enter read (E2, 0x00000000 .. 0x00002B80) → ack
repeat: request block (EB, addr, 512) → data (E4)   ; 22 blocks, last is 384 B
end (E5)
```

Write is the same with `E3` then `E4` per block, each acked with `E6`.
Block size is 512 bytes; the total is 11136 (`0x2B80`), so the final block is
short and you must ask for the remainder rather than a full 512.

### Things I'd leave alone

There's a second command family for factory alignment and test mode: `F0`
enter test, `F1` exit, `F2`/`F7` write test data, `F4`/`F5` PTT on/off, and an
`A0`-prefixed set for squelch, deviation, power and CTCSS/DCS trim
(`ConFreAdj_Com`, `ConDevAdj_Com`, `ConHigPAdj_Com` …). These write the
radio's calibration table. Getting them wrong de-tunes or bricks the radio, and
there's no reason to touch them for a channel editor — implement the `E*`
family only.

---

## 3. Codeplug layout (11136 bytes)

All addresses from `Class1..cctor`:

| Address | Size | Contents |
|---|---|---|
| `0x0000` | 200 × 21 | channel records |
| `0x1140` | 200 × 10 | channel names, ASCII, space-padded |
| `0x1F00` | 32 | channel-in-use **bitmap** |
| `0x1F20` | 32 | scan-skip **bitmap** |
| `0x1F40` | 6 × 8 | band limit slots (low, high) |
| `0x1F70` | 2 × 16 | power-on name, band label — ASCII |
| `0x1F90` | 144 | frequency-code region |
| `0x2020` | 32 | global settings |
| `0x2040` | 224 | DTMF channels, 13 bytes each |
| `0x2120` | 64 | DTMF settings |
| `0x2160` | 192 | 2-tone TX, 11 bytes each |
| `0x2220` | 64 | 2-tone RX |
| `0x2260` | 512 | 5-tone TX, 32 bytes each |
| `0x2460` | 32 | 5-tone settings |
| `0x2480` | 128 | 5-tone RX, 16 bytes each |
| `0x2500` | 128 | FM broadcast presets, 4 bytes each |
| `0x2580` | 4 | FM enable |
| `0x2584` | — | FM VFO |

### What a session actually covers

The radio exposes more than one memory region, and a normal read touches only
one of them.

| Region | Range | Blocks | How it is reached |
|---|---|---|---|
| **Codeplug** | `0x0000`–`0x2B80` | 512 B | plain `EB`/`E4`; this is what a read/write session transfers, in full |
| Voice prompts | `0x40000`–`0xD0000` | 512 B | same `EB`/`E4`, distinguished purely by the address — `SendWriteDatAddComPro` compares against `ConVoiceBegAdd` |
| GB2312 font | `0xD0000`–`0x120000` | 512 B | same, via `ConFontBegAdd` |
| **Alignment / calibration** | `0x0000`–`0x16BF` | 32 B | a *different bank*, entered with `F0`, then read a byte at a time with `SendReadAdjDatComPro`. `TestModDef.icf` is its default image, and `模拟参数总体调节` declares `ConMaxReadAdrr = 5823` |
| Batch debug parameters | `0x0000`–`0x0380` | 32 B | `批处理调试参数`, same mechanism |

The first three share one flat address space, so the address alone selects
them — there is no mode flag, which is what an earlier draft of this report got
wrong. Calibration is the one that genuinely lives behind a mode switch, and it
overlaps the codeplug's addresses, which is precisely why it must.

**A codeplug backup therefore does not include calibration, voice or font.**
That cuts both ways: no codeplug write can damage your alignment, but no `.icf`
will restore it either. The tools here never send `F0` and never address above
`0x2B80`, so they cannot reach the calibration bank at all.

Note also that about 1.4 KB of the codeplug, `0x2600`–`0x2B80`, is real
structured data I have not identified — 16 to 22 distinct byte values per
512-byte chunk, so not padding. Read and write the whole 11136 bytes rather
than just the channel area; a partial write would stake the result on my
incomplete map.

### Channel record — 21 bytes

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | RX frequency, LE uint32, **units of 10 Hz** |
| 4 | 4 | TX frequency, same |
| 8 | 2 | RX tone/code, LE uint16 |
| 10 | 2 | TX tone/code, LE uint16 |
| 12 | 3 | flags (power / bandwidth / signalling / busy-lock) |
| 15 | 6 | ASCII, space-filled |

`145.025 MHz` → `14502500` → `64 4A DD 00`.

**The tone slots are 12-bit, not 16.** The top nibble of each carries unrelated
flags — `ChinfDetail_2.ChgChStringPro` assembles the record nibble by nibble,
which is what gives it away. `0x0FFF` in the low 12 bits means "no tone".

* **CTCSS** = `round(hz × 10)` → 625…2541. `88.5` → `885` → `0x375` → `75 03`.
* **DCS** = the octal code as a plain integer → 19…492. `023` → `0x13` → `13 00`.
* The two ranges don't overlap, so **the value alone tells you which it is** —
  no mode bit needed. Below `0x200` it's DCS.

DCS inversion is *not* in the tone word (my first read of it was wrong) — it
lives in bits 6 and 7 of byte 11.

The two bitmaps use `byte = base + i // 8`, `mask = 1 << (i % 8)` — I confirmed
this against `Class2.StringChUsefulPro`, which does exactly that switch on
`i % 8`. Getting this wrong is the single easiest way to produce a codeplug the
radio accepts but displays as garbage.

### Bit fields, bytes 8–14

Recovered from `ChinfDetail_2.ChgChStringPro`. The combo boxes were named by
cross-referencing `load_GroBox1_comboBoxPro` (which enum table fills which
control) against `Class1.lableArrName_Ch_En` (the UI labels), so these are
names, not guesses.

| Byte | Bits | Field | Values |
|---|---|---|---|
| 8–9 | 0–11 | RX tone ("Decode") | see above |
| 9 | 12–15 | Scrambler | OFF, 1–8 |
| 10–11 | 0–11 | TX tone ("Encode") | see above |
| 11 | 12 | tone-mode flag | *unconfirmed* |
| 11 | 14 | RX DCS inverted | |
| 11 | 15 | TX DCS inverted | |
| 12 | 0 | boolean A | |
| 12 | 1 | boolean B | |
| 12 | 2–3 | Busy Lock | OFF, Sub, Carrier |
| 12 | 4–5 | Bandwidth | Wide, Mid, Narrow |
| 12 | 6–7 | TX Power | High, Mid, Low |
| 13 | 0 | boolean C | |
| 13 | 1 | boolean D | |
| 13 | 2 | name-present (tail ≠ all spaces) | |
| 13 | 3–4 | Signalling | OFF, DTMF, 2TONE, 5TONE |
| 13 | 5–7 | Squelch Mode | SQ, CT, Tone, CT/Tone, CTC&Tone |
| 14 | 0–3 | Tuning Step | 2.5 / 5 / 6.25 / 10 / 12.5 / 25 / 50 / 100 kHz |
| 14 | 4–5 | DTMF PTT-ID | OFF, BEGIN, END, BOTH |
| 14 | 6–7 | 5-tone PTT-ID | OFF, BEGIN, END, BOTH |

Four booleans remain unpaired. The label table says the remaining channel
fields are **Compander, TX Inhibit, Reverse and Talk Around**, and they map to
`checkBox2`–`checkBox5`, but which is which needs the designer code (ILSpy will
show it) or one diff per checkbox. That's the only real gap left in the channel
record.

The trailing 6 bytes at offset 15 also want a note: `ChgChStringPro` fills them
from the channel-name text box through a GBK converter, while the separate
10-byte table at `0x1140` holds a name too. So the radio appears to store a
short GBK-capable name in the record *and* a longer one in the table. Which one
the display uses is worth one experiment.

---

## 4. The `.icf` file format

Plain text, and pleasantly simple:

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
2 of length (always `0x20`), then 32 bytes as hex. Line endings in the shipped
files are an inconsistent mix of CRLF and bare CR — split on both when reading,
write CRLF.

`DefaulFile.icf` covers `0x0000`–`0x30FF` in 392 records with no gaps. Note it
runs to `0x3100`, past the `0x2B80` the radio actually accepts — the tail is
slack.

`English_TH2000.s2g` turns out not to be a string table at all — it's the
installer builder's project file, left in the payload. It names the build
machine's output path (`F:\xiao_TYT\TH-2000\TH-2000Case\...`) and the intended
filename `TH-2000_202602100.exe`. Harmless, but it confirms the file list and
that no password was set on the archive.

One caveat: `DefaulFile_136.icf` and `DefaulFile_400.icf` do **not** match the
address map above. Their channel data runs continuously through `0x1F00` where
the flag bitmaps should be, so they're built for a different (probably legacy)
layout. Use `DefaulFile.icf` as your reference and treat the others as
untrusted.

---

## 5. Reference implementation

`th2000.py` implements everything above with no dependency on the original:
ICF read/write, a `Codeplug` class with typed accessors, `Channel` pack/unpack,
tone encode/decode, the frame codec, and a `Radio` session class (pyserial,
imported lazily so the file half works without it).

```
$ python3 th2000.py DefaulFile.icf
{'com': 'COM1', 'comment': '#Comment=TYT INC.(C)  2013  #MapRev=1', 'baud': '38400'}
power-on name : 'UV8800'   label '400-480'
band slot 0   : 108.0000 - 174.0000 MHz
band slot 4   : 400.0000 - 480.0000 MHz
  0            rx  435.30000  tx  435.30000  enc off/off
```

Verified: stuffing round-trips all 256 byte values; a synthetic 518-byte reply
frame parses with correct checksum; `DefaulFile.icf` → `Codeplug` → file is
byte-identical; editing a channel sets the right bitmap bit (`01` → `03`) and
every bit field survives a pack/unpack round trip. Setting channel 5 to
145.5 MHz, encode 88.5, decode D023 inverted, narrow, 12.5 kHz, scrambler 3,
squelch mode CT produces:

```
f0 03 de 00 f0 03 de 00 13 30 75 43 20 20 04 20 20 20 20 20 20
                        ^^^^^ ^^^^^ ^^ ^^ ^^
                        D023  88.5  |  |  step 4 = 12.5K
                        +scr3 +inv  |  squelch mode 1 = CT
                                    bandwidth 2 = Narrow
```

The serial half is **unverified against hardware** — I had no radio. Everything
in it follows directly from the IL, but treat the first live run as a test.

### How I'd sequence the build

1. **File-only editor first.** ICF in, ICF out, verify by loading your file in
   the original CPS. If it opens and looks right, your layout understanding is
   correct. No radio risk at all.
2. **Read from radio.** Read-only can't damage anything. Compare your dump
   against a codeplug the original CPS read from the same radio — they should
   be byte-identical.
3. **Write last**, and only after you can reliably read. Save a known-good
   original dump first so you always have a way back.

For step 1's field mapping, the diff-based approach is worth repeating: change
one setting in the original CPS, save, diff the hex. Twenty minutes of that
beats hours of reading `SaveCurrenChData`.

### Worth knowing

* **CHIRP** turned out to be more than a model to copy — `chirp/drivers/
  th_uv88.py` is the same product family, uses the *identical* opcodes, and its
  channel struct matches what I derived here almost field for field. A working
  driver is included alongside this report (`tyt_th2000.py`); see
  `CHIRP-driver-README.md`.
* A browser version over Web Serial is included in `web/` - no install, same
  files on every platform. See `web/README.md`.
* Given your ESP32 background: 11 KB of codeplug and a 512-byte block protocol
  fit comfortably on an ESP32 with USB host or a UART tap, if a standalone
  field programmer ever appeals.

---

## 6. Cross-validation against CHIRP

After writing the above I found `chirp/drivers/th_uv88.py`, which supports a
sibling radio. It independently confirms most of this work and corrects two
points:

**Confirmed:** 200 channels, 21-byte records, LE frequencies in 10 Hz units,
scrambler in the top nibble of the RX tone word, 12-bit tone values with the
511/2600 discrimination boundaries, power/bandwidth/busy-lock packing in byte
12, signalling and display-name bits in byte 13, the 6-byte in-record name plus
a separate 10-byte table (they call it `extra_name`, and the two concatenate
into one 16-character name — which answers the question I left open above), and
the `EB`/`E4` opcodes with big-endian addressing.

**Corrected two of my readings:**

1. **The skip bitmap is inverted.** A set bit means *allow in scan*, not skip.
   `Class1.SavOneChgSkipSttPro` confirms it: combo index 1 ("Skip") writes a
   **0**. Fixed in `th2000.py`.
2. My DCS-inversion guess of bit 14 of the tone word was wrong in a different
   way than I thought — inversion is real but lives in bits 14/15 of the *TX*
   word, as separate encode/decode flags.

**Still disputed, one bit-pair.** `th_uv88` has `decodeDSCI` at bit 15 and
`encodeDSCI` at bit 14; the TH-2000 CPS clearly does the reverse. I implemented
what the CPS says and flagged it in both the driver and its README. It only
affects inverted DCS.

**And it goes the other way too** — three fields `th_uv88` marks unknown are
named here, from the CPS's own label table: byte 13 bits 5–7 are the **squelch
mode** (SQ / CT / Tone / CT+Tone / CTC&Tone), byte 14 bits 6–7 are the **5-tone
PTT-ID**, and the step field is **four** bits wide, not three.

The framing does differ: `th_uv88` sends plain frames with a two's-complement
checksum, where the TH-2000 CPS stuffs and uses an additive sum. Since the CPS
carries a method named `GetChkSum_AddrPro_Leg` ("legacy"), both schemes plausibly
exist across the family, so the driver supports either via one class flag.

---

## 7. A browser implementation, and what it caught

`web/` holds a self-contained programmer built on Web Serial: `index.html` plus
`th2000-core.js` (framing and codeplug codec, no DOM, so it is testable under
node). It reads, edits and writes the radio, imports and exports `.icf`, and
verifies a write by reading the codeplug back and comparing byte for byte.

Reimplementing the same knowledge in a second language turned out to be the
most effective bug-finding exercise of the whole project. Three faults surfaced,
all now fixed in every deliverable:

**1. A zero tone slot rendered as `D000`.** There is no DCS code 000, so the
label could not be parsed back - any channel holding a zeroed tone word would
round-trip into garbage. This was present in the JS, in `th2000.py`, *and* in
the CHIRP driver. Zero now means no tone, the same as the `0x0FFF` sentinel.
There is a regression test that walks all 4096 representable tone values through
label to parse and back.

**2. The CHIRP driver over-claimed DCS support.** It declared
`chirp_common.ALL_DTCS_CODES`, which is the raw range 0-511, so CHIRP's
brute-force test dutifully tried code 0 and failed. Checking the radio's own
`DcsTone` table settled it: exactly 104 codes, 023 to 754, which is precisely
`chirp_common.DTCS_CODES`. The over-claim was the error, not the test.

**3. `th2000.py` modelled the channel name wrongly.** It exposed the 6-byte
in-record field and the 10-byte table as two separate things when they are one
16-character name. Found by running the same edit through both implementations
and getting a one-byte difference in the flags byte - the name-present bit. The
CHIRP driver had this right; the standalone library did not.

That third one is the argument for building the second implementation at all.
Neither test suite on its own would have caught it; only the disagreement did.

### Test totals

| Suite | Result |
|---|---|
| `web/th2000-core.test.js` | 64 checks |
| `web/ui.test.js` (jsdom, simulated radio) | 62 checks |
| CHIRP driver suite | 35 passed, 7 skipped, 1 xfailed |
| `chirp/test_th2000_loopback.py` | all checks, both framing modes |

None of it involves a physical radio. The simulators prove the implementations
agree with my reading of the OEM software; they cannot prove that reading
matches your hardware.

---

### One legal note

Reverse engineering for interoperability is broadly protected, and re-deriving
a data format to write your own editor is the textbook case. Two things to keep
clean: don't redistribute TYT's files (the `.icf` defaults, the string table,
the DLL) with your software, and don't extend the writable frequency range past
what your licence covers — the band-limit words at `0x1F40` and the `EC`
command make that trivially easy to do by accident.
