# CHIRP driver — TYT TH-2000

> **Licence:** this driver is **GPL-2.0-or-later**, not Apache 2.0 like the
> rest of the repository. It subclasses CHIRP, so it is a derivative work and
> must carry CHIRP's terms. See [../NOTICE](../NOTICE).

A CHIRP driver for the TYT TH-2000 / UV-99, exposing the 200 channels and all
71 radio settings through CHIRP's normal interface.

```
tyt_th2000.py             the driver — this is the only file CHIRP needs
icf2img.py                converts .icf ↔ .img (needs th2000.py beside it)
test_th2000_loopback.py   drives the driver against a simulated radio
th2000.py                 the standalone library, used by icf2img.py
```

---

## Installing

### Load Module — no installation

CHIRP has a loader for single-file drivers, which is what this is.

1. **Help → Developer Mode** — tick it. The loader is hidden until you do.
2. Restart CHIRP.
3. **File → Load Module…** and pick `tyt_th2000.py`.
4. The radio appears as **TYT → TH-2000**.

CHIRP will warn you bluntly about loading modules, turn its window red, and put
`**Module Loaded**` in the title bar. That is all deliberate.

**The warning is correct.** A CHIRP module is Python that runs with your full
user privileges. You have the source and the tests here, so you can judge this
one, but do not wave the warning away for modules from elsewhere.

### Command line

```bash
chirpw --module /path/to/tyt_th2000.py
```

### Into a source checkout

Permanent, no developer mode, no red window:

```bash
git clone https://github.com/kk7ds/chirp.git
cd chirp
cp /path/to/tyt_th2000.py chirp/drivers/
pip install -e .
python3 -m chirp.wxui
```

---

## What it exposes

**200 channels** through the normal memory editor. Frequency, name, tones,
duplex, power, bandwidth and skip are columns; busy lock, squelch mode,
signalling, scrambler, step and both PTT-IDs are in the *extra* panel.

**Radio settings and the VFOs** across eight groups:

| Group | Contains |
|---|---|
| Radio | squelch, volume, time-out timer, auto power off, scan type, dual watch, monitor, squelch tail |
| Display and sound | backlight, LED mode, RX light, display mode, beep, intro screen and both text lines |
| Transmit | TX channel, TX tone |
| Keys | key mode, key lock, and all ten P1–P5 short/long assignments |
| Security | boot-strap password and its enable bit |
| VFO | the two VFOs, one per band - frequency, power, bandwidth, reverse, talk around |
| FM broadcast | 32 presets and the VFO |
| Band limits | read-only |

Every settings field was confirmed by measurement — change one thing in the
manufacturer's software, save, diff the bytes — not inferred from decompiled
code. 59 observations in all. See
[`../docs/SPECIFICATION.md`](../docs/SPECIFICATION.md) section 6.

---

## Design notes

**The VFOs** live in ten more channel records between the channel array and the
name table, at `0x1068`-`0x1140` - a region nothing had mapped until a radio was
read with known VFO settings. Slots 204-209 are two VFOs with one slot per band;
the driver exposes the four this radio uses and leaves the two 220 MHz slots
alone.

**Unmapped bits are carried, not cleared.** Eleven of the 32 settings bytes have
no known meaning, along with four channel booleans and some scattered bits.
They are declared in `MEM_FORMAT` as `unknown*` members so bitwise passes them
through untouched. The manufacturer's own software preserves most of them too.

Writing every setting back at its current value moves **zero bytes**. There is a
test for that, and it is the property that makes the driver safe to use on a
radio whose codeplug is not fully understood.

**Two settings encode oddly**, and both are handled:

* Volume stores the number you see, 0–31.
* Backlight stores **one less** — display 1–7 is stored 0–6.

Guessing either from its option list would have been wrong, silently. This is
why the map was measured rather than inferred.

**P5 long** is shown read-only as *Power Button*. That key switches the radio on
and off and the manufacturer's software will not reassign it.

**Band limits are read-only** on purpose. There is no good reason to make
transmitting outside your licence a two-click operation.

**Two framings exist.** `LEGACY_FRAMING = False` on the class selects the
stuffed frames this radio uses. The sibling TH-UV88 uses the same opcodes with
plain frames and a two's-complement checksum; set the flag to `True` if a
handshake fails. Both paths are covered by the loopback test.

---

## Testing

```bash
CHIRP_PATH=/path/to/chirp python3 test_th2000_loopback.py
```

It finds a sample codeplug next to itself, in `../web`, or in
`../th2000/installer-contents`, so it runs from the bundle as it ships.

Stands up a fake radio speaking the recovered framing and drives the real
driver against it: handshake, mode entry, all 22 blocks, byte stuffing in both
directions, checksums, and a write-then-read verification. Passes in both
framing modes.

It also checks every `pipe.*` attribute the driver touches against
`serial.Serial`. That test exists because a call to `pipe.log()` once passed
every loopback run - the fake port had a `log()` method pyserial does not - and
then failed on a real radio. A test double more capable than the real thing
hides bugs rather than finding them.

Against CHIRP's own driver suite, with a real-hardware reference image:

```
35 passed, 7 skipped, 1 xfailed, 1 xpassed
```

The skips are bank tests — this radio has no banks. The `xfail` is
`test_bitwise_unnecessary_seek`, which carries `@pytest.mark.xfail(strict=False)`
for **every** driver in the codebase; the redundant `#seekto` lines are kept
deliberately, because each one the strict test flags as unnecessary confirms the
address arithmetic landed where intended. `test_bitwise_negative_seek` xpasses,
meaning the map never seeks backwards.

`flake8` is clean.

---

## Opening files

**A `.icf` from the manufacturer's software opens directly.** File → Open, pick
it, done. The driver recognises the format by its header and then checks the
contents, so the sibling products whose `.icf` files share the format - one has
a channel named `GMR50` - are correctly refused rather than loaded as garbage.

Saving with a `.icf` extension writes that format back, so files stay
interchangeable with the manufacturer's software.

A **raw** `.bin` is still not claimed, deliberately: an 11136-byte blob is not
distinctive enough to identify safely, and new drivers are expected to rely on
the metadata CHIRP appends to `.img` files. Download from the radio and save as
`.img`, or convert.

## Converting files

```bash
# manufacturer .icf → CHIRP .img
PYTHONPATH=/path/to/chirp python3 icf2img.py to-img backup.icf radio.img

# back again
PYTHONPATH=/path/to/chirp python3 icf2img.py to-icf radio.img check.icf
```

`to-img` needs CHIRP importable, because CHIRP identifies images by a metadata
sidecar appended to the file rather than by sniffing contents. `to-icf` works
without it.

`icf2img.py` predates the driver reading `.icf` directly and is now only useful
for scripting, or for converting in bulk without opening CHIRP.

---

## Known limits

**The write path has never run against hardware.** Reading has. Everything in
the write path follows from the same analysis and passes the loopback, but that
is not proof.

**One bit-pair is disputed.** CHIRP's `th_uv88.py` places `decodeDSCI` at bit 15
and `encodeDSCI` at bit 14 of the transmit tone word; this radio's own software
does the opposite. This driver follows the software. If your inverted-DCS
channels come out with polarity swapped, exchange those two lines in
`MEM_FORMAT` and please report it.

**Three fields are named here that `th_uv88` marks unknown** — squelch mode, the
5-tone PTT-ID, and the true four-bit width of the step field. They should
transfer to that driver cleanly if anyone wants to.

---

## Upstreaming

CHIRP takes patches at [chirpmyradio.com](https://chirpmyradio.com); GitHub is a
mirror. Before submitting you would want a real hardware test — including a
write — a `tests/images/TYT_TH-2000.img` taken from an actual radio rather than
a converted file, and your own name in the copyright header.

Maintainers reasonably expect a driver to be confirmed on the hardware it claims
to support. The honest framing for a patch today is that reading is confirmed
and writing is not.
