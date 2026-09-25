# Channel lists

Ready to import with **Tools -> Import channels (CSV)** in the web tool, or
into CHIRP.

Built for an operator in **Plovdiv**. If you are elsewhere in Bulgaria the
order still works - it is geographic - but you will want to move your own
region to the middle.

`bg-repeaters-plovdiv.csv` — Bulgarian repeaters plus simplex, PMR446 and the
ISS, ordered west to east with Plovdiv in the middle.

## The list

Repeaters are ordered by **longitude**, so the channel number is a position on
the map: scroll down and you travel east, scroll up and you go west.

| Channels | Count | Region |
|---|---|---|
| 1-17 | 17 | West: Sofia, Kyustendil, Vratsa |
| 21-24 | 4 | South-west: Pirin and Rila |
| 28-29 | 2 | Sredna gora |
| **33-42** | 10 | **PLOVDIV and the Rhodopes** |
| 46-58 | 13 | Centre-east: Stara Zagora, Kardzhali, Gabrovo |
| 62-66 | 5 | East: Sliven, Ruse, Razgrad |
| 70-80 | 11 | Far east: Varna, Burgas, Dobrich |
| 84-112 | 29 | VHF simplex |
| 116-123 | 8 | UHF simplex |
| 127-142 | 16 | PMR446 |
| 146-147 | 2 | ISS, receive only |

117 in use, 83 free. Three empty channels between regions leave room to add
without renumbering.

Names are at most 8 characters. Where a site has both bands they end `-U` or
`-V`; single-band sites keep a plain name.

## Things to check before you rely on it

* **Channel 108 is 144.800**, which is APRS. Transmitting FM voice there
  interferes with data across a wide area. Worth deleting, or setting transmit
  to `off`.
* **145.575** is now inside the repeater-output segment, not simplex.
* **CHEPINCI** had its shift reversed in the original list - receive on an
  input, transmit on an output. Corrected here to 145.750 / 145.150.
* **438.100 and 438.600** were labelled the other way round. They are now
  `SOFIA-TU` and `KOPITOTO`, taken from RepeaterBook site names.
* Several entries disagree with RepeaterBook on tone or are marked off-air
  there. RepeaterBook lags; your Bulgarian sources win where they differ.
