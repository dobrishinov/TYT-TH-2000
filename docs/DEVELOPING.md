# Developing

How the code is arranged, what the tests are for, and the two habits that found
most of the bugs.

---

## Shape of it

Four implementations of the same knowledge, deliberately kept independent:

```
th2000.py              Python library, no dependencies
web/th2000-core.js     JavaScript core: same model, own code
chirp/tyt_th2000.py    CHIRP driver, using CHIRP's bitwise DSL
web/index.html         the programmer UI, built on th2000-core.js
web/compare.html       the mapping notebook, same core
site/                  the built single-file versions, published by Pages
```

Duplication here is intentional. Three separate expressions of the same memory
map disagree loudly when one is wrong, which is how several real faults
surfaced. It costs more to maintain than a shared library would, and has been
worth it every time.

`web/` is the source; `site/` holds the built single-file versions, and is what
GitHub Pages publishes. Rebuild after any change under `web/`:

```bash
cd web
python3 - <<'EOF'
core = open('th2000-core.js').read()
tag = '<script src="th2000-core.js"></script>'
for src, dst in (('index.html', '../site/index.html'),
                 ('compare.html', '../site/compare.html')):
    open(dst, 'w').write(open(src).read().replace(tag, '<script>\n' + core + '\n</script>', 1))
EOF
```

The Pages workflow refuses to publish if `site/` is out of step with `web/`,
which is the guard I kept forgetting to run by hand.

Test both builds. A missing-file bug once made the two-file version work and the
single-file version silently not.

---

## Tests

```bash
cd web
node th2000-core.test.js       # 193 checks, no dependencies
node ui.test.js                # 475 checks, needs jsdom
node compare.test.js           #  43 checks, needs jsdom
cd .. && python3 noop_roundtrip.py
```

`ui.test.js` and `compare.test.js` evaluate the real page in jsdom with a fake
serial port, so they exercise the shipped HTML rather than a copy of its logic.
Run them against **both** builds:

```bash
WEB_DIR=. PAGE=index.html node ui.test.js
cp ../site/index.html th2000-standalone.html
WEB_DIR=. PAGE=th2000-standalone.html node ui.test.js
```

### The one that matters

`noop_roundtrip.py` reads a codeplug, parses every channel, writes each straight
back unchanged, and requires **zero** bytes to differ — across the Python
library, the JavaScript core and the CHIRP driver, in both directions.

It runs twice: once on a real radio image, once on an image with every
undocumented bit set to 1. The second pass is the useful one. Any bit a field
model fails to carry through shows up immediately.

This caught the JavaScript core blanking unused channel records (2605 bytes on a
no-op), a dropped bit in the transmit tone word, and a name modelled as two
fields instead of one.

---

## Two habits worth keeping

### Never trust decompiled code over bytes

Every settings field in this project was established the same way: change one
thing in the manufacturer's software, save, diff. 59 observations. An earlier
attempt to derive the same map by symbolically executing the CPS's assembler
produced something plausible that contradicted the radio's actual bytes, and was
thrown away.

Two fields encode differently despite looking identical in the interface —
volume stores the number, backlight stores one less. Either one guessed from its
option list would have been wrong, silently.

When mapping something new, see [`MAPPING-GUIDE.md`](MAPPING-GUIDE.md).

### One definition, not five

Three separate bugs came from the same shape of mistake: one piece of knowledge
written out in several places, where one copy drifts.

* The receive-only sentinel `0xFFFFFFFF` was tested by hand in five places. One
  missed it and printed `42949.67295 MHz`.
* Help text was built through `json.dumps`, escaping newlines into a literal
  `\n` that showed in tooltips.
* A summary counted channels added, changed and removed, but was structurally
  blind to bytes moving inside unused slots — so it could not account for its
  own byte total.

If a value is formatted in two places, it will diverge. Put it in the core and
import it. There is a test that walks every CSS rule targeting a form control
and fails if one draws itself without a themed background, for exactly this
reason.

---

## Adding a settings field

1. Map it empirically — see [`MAPPING-GUIDE.md`](MAPPING-GUIDE.md).
2. Add it to `SETTINGS_FIELDS` in `web/th2000-core.js` with `off`, `lo`, `hi`,
   and either a `list` or `kind: 'num'` with `min`, `max` and `bias`.
3. Add help text to `SETTINGS_HELP` in the same file. A test fails if any field
   lacks it.
4. Add the bits to `MEM_FORMAT` in `chirp/tyt_th2000.py`, splitting the relevant
   `unknown*` member so the remaining bits still pass through.
5. Add it to `get_settings` and `set_settings`.
6. Run `noop_roundtrip.py`. If it does not report zero bytes, the field model is
   wrong.

The UI needs no changes — it renders from `SETTINGS_FIELDS`.

---

## Things I would do differently

**Check that a change landed, not just that tests pass.** A de-duplication was
reported as done while the duplicate definition survived, because the
replacement silently did not match and the tests still passed. `grep` for what
you claimed to remove.

**Test structure, not just presence.** `getElementById` finds an element however
deeply it is buried. 156 tests passed while four of five panels were nested
inside the first and therefore invisible. There are now guards asserting each
panel is a direct child of its container and that switching tabs shows exactly
one.

**A change to one renderer is a prompt to check the others.** A channel is
formatted in four places - the table, the side panel, the CSV and the printed
sheet. The Scan column printed blank for an included channel long after the
same bug was fixed on screen, because fixing the instance is not fixing the
pattern.

**A green suite proves the assertions that ran passed.** Three assertions were
found referencing an element id that has never existed. They should have thrown
on every run. The count is not coverage.

**Success messages computed independently of the thing they report will lie.**
*Copy to next* said "Copied into channel 2" while the table still showed the row
empty, because the operation wrote to the codeplug and never redrew.
