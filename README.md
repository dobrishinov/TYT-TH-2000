# TH-2000 CPS

Open programming software for the **TYT TH-2000** amateur radio, also sold as
the **UV-99**: a browser-based programmer that needs nothing installed, a CHIRP
driver, a Python library, and the documentation to rebuild any of it.

Built by reverse engineering the manufacturer's own software, then checking
every finding against a real radio.

> **Try it in your browser:**
> **https://YOUR-USERNAME.github.io/th2000-cps/**
>
> *(replace with your own address once Pages is switched on — see
> [Publishing the web version](#publishing-the-web-version))*

---

## Why

The stock software is Windows-only, undocumented, and easy to get wrong. This
replaces it with tools that run anywhere, explain what they are doing, and can
be checked. The `.icf` files are interchangeable with the manufacturer's
software, so you can move between them freely.

---

## Quick start

### 1. Make a cable

Three wires: D+, D− and ground. The radio is a USB device in its own right, so
there is no serial adapter and no chip involved — just wire.

![The radio's jack, and the cable wiring](docs/cable-jack-and-wiring.jpg)

**Leave pin 7 unconnected.** The radio supplies 5 V there, and it sits next to
the D+ data line. Step-by-step instructions, the measured voltages and how to
test the cable are in [docs/CABLE.md](docs/CABLE.md).

### 2. Program the radio

Open the hosted page above in Chrome or Edge — Web Serial is needed and Firefox
does not have it. Or run it yourself:

```bash
cd site && python3 -m http.server 8000
```

then visit **http://localhost:8000**. Serving matters: Web Serial needs a
secure context, and a `file://` page is not one.

Try it with no radio first — **Open .icf** and pick
`reference/DefaulFile.icf`.

### 3. Or use CHIRP

**Help → Developer Mode**, restart, then **File → Load Module…** and choose
`chirp/tyt_th2000.py`. The radio appears as **TYT → TH-2000**.

---

## What is here

| | |
|---|---|
| [`site/`](site/) | the built single-file tools — this is what gets published |
| [`web/`](web/) | their source, and the test suites |
| [`chirp/`](chirp/) | CHIRP driver, `.icf`↔`.img` converter, protocol loopback test |
| [`docs/`](docs/) | cable, specification, derivation, mapping guide, developer notes |
| [`channels/`](channels/) | a ready-made Bulgarian repeater list |
| [`reference/`](reference/) | the manufacturer's files, extracted |
| `th2000.py` | standalone Python library, no dependencies |
| `noop_roundtrip.py` | the cross-implementation invariant check |

Two tools ship as single self-contained HTML files:

* **`site/index.html`** — the programmer
* **`site/compare.html`** — a byte-level notebook for mapping what is still unknown

---

## Features

**Channels** — 200 of them, edited inline or in a side panel. Copy, cut, paste
and delete from the keyboard. Bulk operations across a range or on one channel.
CSV import and export, including CHIRP's own CSV.

**VFOs** — both of them, one per band, in the same A/B layout the radio uses.

**Radio settings** — 29 fields: squelch, time-out timer, auto power off,
backlight, LED mode, display mode, scan type, key mode and lock, beep, dual
watch, monitor, squelch tail, both intro screen lines, the boot-strap password,
and all ten programmable key assignments.

**FM broadcast** — 32 presets and the VFO.

**Safety** — reading saves a timestamped backup automatically. Before writing,
it reads the radio back and shows exactly what would change, in the terms you
edit in. After writing, it verifies byte for byte. Nothing outside a named
field is ever written.

---

## Publishing the web version

`site/` holds the two built files and nothing else, so it can be published as
it stands.

**With the included workflow** — [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
publishes `site/` on every push to `main`. Switch it on under
**Settings → Pages → Source → GitHub Actions**, push, and the address appears
there. Then replace the placeholder at the top of this file.

**Without Actions** — GitHub can serve a branch folder, but only the repository
root or `/docs`. Since `docs/` here is documentation, rename `site/` to `docs/`
and move the documentation elsewhere if you prefer that route.

Rebuild `site/` after changing anything under `web/`:

```bash
cd web && python3 - <<'EOF'
core = open('th2000-core.js').read()
tag = '<script src="th2000-core.js"></script>'
for src, dst in (('index.html', '../site/index.html'),
                 ('compare.html', '../site/compare.html')):
    open(dst, 'w').write(open(src).read().replace(tag, '<script>\n' + core + '\n</script>', 1))
EOF
```

---

## Before you write to a radio

### Use at your own risk

This project is provided **without any guarantee or warranty**. Any use of the programmer, CHIRP driver, library, or write functionality is performed entirely at your own risk and responsibility.

The user is responsible for making backups and for verifying their hardware and configuration before writing to a radio. If something goes wrong or the radio's configuration becomes corrupted, **there is no guarantee that it can be recovered**, and the project authors cannot be held responsible for any damage, loss of configuration, or other consequences resulting from its use.


**Read it first and save that file.**

The write path is the one part of this that has never run against hardware —
everything else has. The protocol was recovered by reading the manufacturer's
software rather than by capturing a session. It agrees with the simulators, and
three independent implementations agree with each other byte for byte, but that
is not the same as proven.

[docs/SPECIFICATION.md](docs/SPECIFICATION.md) §10 is an honest ledger of what
is confirmed and what is not.

A codeplug write cannot reach the radio's firmware or its calibration — no
command in the protocol can. The worst realistic outcome is a scrambled
configuration you fix by writing your backup back.

---

## Tests

```bash
cd web && node th2000-core.test.js        # 193 checks, no dependencies
python3 noop_roundtrip.py                 # every implementation agrees
```

With `jsdom` installed, `node ui.test.js` (475) and `node compare.test.js` (43)
drive the real pages in a headless DOM. The CHIRP driver passes CHIRP's own
driver suite: 35 passed, 7 skipped.

`noop_roundtrip.py` is the one that matters. It reads a codeplug, parses every
channel, writes each straight back unchanged, and requires **zero** bytes to
differ across the Python library, the JavaScript core and the CHIRP driver. Any
bit a field model fails to carry shows up there.

---

## Licence

**Apache License 2.0** — see [LICENSE](LICENSE). Two exceptions, both in
[NOTICE](NOTICE):

**`chirp/tyt_th2000.py` is GPL-2.0-or-later.** It imports from and subclasses
CHIRP, which is GPL, so the driver is a derivative work and has to carry the
same terms. It cannot be Apache-licensed. This is normal for a CHIRP driver and
causes no difficulty in practice: it is a standalone module CHIRP loads, kept
apart from the rest of this repository.

*(Apache 2.0 and GPLv2 are incompatible. Because the driver is "v2 **or
later**", anyone combining it with the Apache-licensed parts can do so under
GPLv3, which Apache 2.0 is compatible with.)*

**`reference/` is the manufacturer's material**, extracted from their
installer. It belongs to TYT and is here for interoperability work. It is not
covered by the Apache licence and must not be shipped with any release you
make.

---

## Credits

The channel record layout was cross-checked against
[`chirp/drivers/th_uv88.py`](https://github.com/kk7ds/chirp), which supports a
sibling radio and independently confirms most of it. Three fields that driver
marks unknown are named here; one bit-pair remains disputed between them. Both
are documented in the specification.
