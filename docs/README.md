# Documentation

| | |
|---|---|
| [CABLE.md](CABLE.md) | how to make the programming cable, with a wiring diagram — **read this first** |
| [SPECIFICATION.md](SPECIFICATION.md) | the radio, completely: transport, protocol, memory map, encodings |
| [MAPPING-GUIDE.md](MAPPING-GUIDE.md) | how to work out what the remaining unmapped bytes do |
| [REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md) | how all of this was derived |
| [DEVELOPING.md](DEVELOPING.md) | the codebase, its tests, and the habits that found the bugs |
| `settings-map.json` | the radio settings field map, as data |
| `rj45-jack.jpg` | the radio's accessory jack, pins labelled |
| `cable-wiring.svg` | the wiring diagram on its own, as vector |
| `cable-jack-and-wiring.jpg` | both together, for the README |

Two markers run through the specification. **measured** means established by
diffing real saves or reading a radio; **derived** means read out of the
manufacturer\'s software and not yet confirmed against hardware. Where the two
disagree, measured wins, and the disagreement is recorded rather than quietly
resolved.

Section 10 of the specification is the verification ledger: what is confirmed,
what is not, and what is still unknown.
