# Mapping guide

How to work out what an unmapped byte does, using the tool built for it. This is
the procedure that produced the settings map — 59 observations, all of them
measured rather than inferred.

---

## What is still unknown

| Where | Size | Notes |
|---|---|---|
| Settings `+4`…`+11` | 8 bytes | contiguous, untouched by anything in the settings dialogue, identical between a factory template and a real radio |
| Settings `+17`, `+19`, `+21` | 3 bytes | scattered singles |
| Channel byte 12 bits 0–1 | 2 bits | two of: Compander, TX Inhibit, Reverse, Talk Around |
| Channel byte 13 bits 0–1 | 2 bits | the other two |
| Channel byte 11 bit 12 | 1 bit | a tone-mode flag of some sort |
| `0x1910` | 34 bytes | space-filled, purpose unknown |
| FM enable bitmap `0x2580` | 4 bytes | inferred, never confirmed |
| DCS inversion bits | 2 bits | disputed against `th_uv88.py` — needs a hardware test, not a diff |

---

## The procedure

**1.** Open `web/th2000-compare.html`. It needs nothing installed.

**2.** Read your radio and save the file. This is the baseline. Drop it on the
**left** — that side is never written to.

**3.** In the manufacturer's software change **one** setting. Save.

**4.** Drop that file on the **right**. The table underneath shows every byte
that differs: address, region, value before and after in hex *and* binary, and
which bits moved.

**5.** Type what you changed — "Squelch level 0 to 9" — and press **Record**.
That pairs your words with the bytes.

**6.** Press **Right → baseline** and change the next setting. No reloading.

**7.** **Export log** when you are done. It writes a text file with every
observation plus a machine-readable block at the end.

About a minute per field.

---

## Two traps

### Take the field to the top of its range

The tool reports the bits that *actually moved*, which can be narrower than the
field. Changing a value from 0 to 3 in a three-bit field moves two bits and
tells you nothing about the third.

So do not step a setting by one. Take it from its **lowest** option to its
**highest**. That one diff gives you the byte, the width, and usually the
encoding.

### Two points for anything numeric

A single observation cannot distinguish "stores the index" from "stores the
value" from "stores the value minus one".

This is not hypothetical. In this radio:

* **Volume** stores the number you see, 0–31.
* **Backlight** stores **one less** — display 1–7 is stored 0–6.

Two visually identical spinners, two different encodings. Either one guessed
from its option list would have been wrong, and nothing in the interface would
have revealed it.

For time values, add a third point in the middle. `OFF / 30s / 60s` storing
0, 1, 2 is an index; storing 0, 30, 60 is seconds. The time-out timer turned out
to be an index.

---

## Rules that keep the diffs clean

**One setting per save.** The only rule that really matters. Two changes in one
save and you cannot tell which bits belong to which field.

**Use Right → baseline between fields**, so every diff shows only the newest
change.

**If several bytes move from one change, tick only the relevant rows** before
recording. Sometimes the manufacturer's software touches something incidental.

**Channel bytes are hidden by default** in the byte table, because editing one
channel moves about twenty bytes and importing a CSV moves thousands, which
would bury everything else. Every byte still waiting to be mapped lives outside
the channel area, so the default view is the one you want.

---

## If nothing changes

That is a real result and worth recording separately, because the tool cannot
log an empty diff.

It means either the setting lives outside the 11136 bytes a codeplug transfer
covers, or the software did not write it. Both are useful to know.

Similarly, a setting landing somewhere unexpected is interesting — the region
column will tell you.

---

## The eight-byte run at +4

Worth a word, since it is the largest unknown.

Nothing in the settings dialogue touches it. It is identical between a factory
template and a real radio — `00 00 00 00 00 00 03 00`. And the manufacturer's
own settings routine **explicitly copies those bytes through** rather than
rebuilding them, along with `+11`, `+18` and `+19`.

Two candidates:

* A **Bluetooth** group hidden on models without the module. The software has
  Bluetooth option lists and a `set_Visible` call in the settings window, so
  such a group exists and is conditionally hidden.
* **Runtime state** the firmware maintains — last channel, current volume, VFO
  position — which the programming software would sensibly leave alone.

Static analysis cannot separate those. One experiment can: **read the radio
twice with normal use in between.** Change channel, adjust the volume knob,
transmit briefly. Compare the two reads. If those bytes move, they are runtime
state. If they never move, they belong to a feature the radio does not have.

Either answer is useful, and neither changes what the tools do — those bytes are
preserved byte for byte regardless, exactly as the manufacturer's software does.

---

## Sending results back

The exported log is designed to be pasted directly into an issue or a message.
It contains, per observation: your description, both filenames, a timestamp, the
byte table, and a JSON block for machines.

The one thing worth adding by hand is anything the tool could not see — settings
that produced no diff, or behaviour you noticed on the radio itself.
