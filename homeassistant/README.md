# NibePi → Home Assistant dashboard

A complete heat pump control and monitoring surface for Home Assistant, built on
NibePi's MQTT discovery. Four views, a purpose-built Lovelace card, live COP, and
energy meters the Energy dashboard accepts.

| File | What it is |
|---|---|
| `nibepi-card.js` | Custom Lovelace card: live hydraulic schematic, summary, heat demand meter and grouped detail rows |
| `packages/nibepi.yaml` | Derived sensors — heat output, electrical input, COP, alarm text, energy meters, alarm reset |
| `dashboard.yaml` | The dashboard itself: Übersicht · Verlauf · Warmwasser · Diagnose |
| `gen-alarms.js` | Regenerates the 265-code alarm tables in the two files above from `lib/alarms.json` |

---

## The centrepiece

`nibepi-flow-card` draws the installation the way the pump's own documentation
draws it — a single-line hydraulic schematic — rendered in Home Assistant's
visual language: flat surfaces, HA colour tokens, tabular numerals, restrained
motion. Four layers, top to bottom:

1. **Summary row** — heat output, electrical input, live COP, COP today.
2. **The schematic** — borehole below a hatched ground line, the machine outline
   containing the refrigerant circuit, the QN10 diverter, radiators and tank.
   Drawn twice: landscape for a wide card, portrait for a phone (see below).
3. **House heat demand** — the degree minute register, reframed (see below).
4. **Grouped detail rows** — eight groups covering the heating circuit, hot
   water, ground loop, compressor, immersion heater, electrical, energy and
   control signals.

It is a circuit diagram, not a flow chart:

- **NIBE's own designations.** Components are labelled `EB100 · EP14`, `GP1`,
  `GP2`, `QN10`; measuring points are annotated with the sensor tags from the
  wiring diagram — `BT2`, `BT3`, `BT6`, `BT7`, `BT10`, `BT11`, `BT50` — each with
  its live value beside it. The drawing and the manual use the same names. A tag
  with no entity behind it is removed from the drawing rather than left showing a
  dash, so a tank with BT6 but no BT7 gets a diagram of the tank it actually has.
- **The refrigerant circuit is drawn.** Inside the machine outline: evaporator,
  compressor, condenser, expansion valve, with the brine entering the evaporator
  and the heat medium leaving the condenser. That is what makes the drawing
  explain *how* heat gets from the ground to the radiators rather than just
  asserting that it does. It has its own colour and line weight so it never
  reads as one of the water circuits, and it circulates whenever the compressor
  turns.
- **Every loop is closed**, with flow and return as separate routed pipes and a
  direction arrow on each leg, so the circuit still reads when everything has
  stopped. The two returns share the bottom header, as they do on the real
  installation.
- **Standard symbols**: circulation pumps as circle-and-triangle, the compressor
  as a bar-and-wedge, plate heat exchangers as a box with a diagonal, the
  expansion valve as a bowtie, the tank exchanger as a serpentine coil.

What is live:

- **Pipe colour follows that pipe's own temperature** — a shared scale from
  −25 °C (deep blue) through 20 °C (green) to 65 °C (red). Because flow and
  return are separate lines with separate colours, ΔT is visible directly:
  the brine return runs colder than the brine flow, the heat medium return
  cooler than the supply.
- **Flow dots follow the circulation pumps** — speed from the brine and heat
  medium pump percentages; at 0 % the dots stop and vanish, the pipe falls back
  to a neutral line and the pump symbol goes grey. Nothing moves that isn't
  actually moving.
- **The compressor ring shows load** — register 43136 as a fraction of the
  20–120 Hz range. A static arc, not a spinning graphic.
- **QN10 points at the active branch** and the idle branch dims — `Prio` decides
  whether heating or hot water is being served.
- **Alarms surface at the top** with human-readable text for all 265 codes from
  NibePi's own alarm table, not just the number.

### Two geometries, no squashing

A circuit diagram cannot reflow into a column and stay a circuit, and shrinking it
to fit a phone puts its labels below legibility. So the schematic is drawn twice,
by hand:

- **Landscape** (1040 × 500) — ground on the left, house on the right.
- **Portrait** (340 × 1010) — same circuit, same tags, same live channels, but
  stacked the way the installation actually sits: ground and borehole at the
  bottom, machine above it, radiators and tank at the top, with the supply trunk
  up the right edge and the return trunk down the left.

A **ResizeObserver on the card's own box** picks one, so a narrow dashboard column
on a big monitor gets the portrait drawing too. Landscape takes over at
`wide_at` px of card content width — **900 by default**:

| Card content width | Layout | Drawing scale | Smallest type |
|---|---|---|---|
| 500 px | portrait | 1.38× | 14.5 px |
| 860 px | portrait | 1.41× | 14.8 px |
| 960 px | **landscape** | 0.89× | 9.4 px |
| 1500 px | **landscape** | 1.41× | 14.8 px |

Two knobs, both optional:

```yaml
layout: auto     # auto (default) | wide | tall — pin a geometry, ignore the measurement
wide_at: 900     # px of card content width at which auto switches to landscape
```

#### If it stays portrait on a desktop: `grid_options`

`column_span` widens the **section**, not the cards in it. A section's grid is
`12 × column_span` columns, and a card with no `grid_options` takes 12 of them —
so in the `column_span: 3` section the schematic sits in, an unsized card gets
**one third** of the width. About 500 px on a normal window, comfortably under
`wide_at`, and portrait every time.

Every card in a spanning section needs to be told to fill it:

```yaml
- type: grid
  column_span: 3
  cards:
    - type: custom:nibepi-flow-card
      grid_options:
        columns: 36        # 12 × column_span
```

`dashboard.yaml` sets this on all ten cards that live in spanning sections — 36
in the `column_span: 3` sections, 24 in the `column_span: 2` ones. Miss it and
the charts render at half width too; it is just less obvious on a chart than on
a drawing that changes shape.

`layout: wide` forces landscape regardless of width, but in a section that is
sized wrong it only buys you a shrunken drawing in a third of a card. Fix the
`grid_options` first and leave `layout` on `auto`.

Earlier versions used a CSS container query at 1040 px. A container query needs an
intact `container-type` on whatever host is rendering the card, and when it fails
to match there is no way to tell from the outside — the card just silently stays
portrait forever. The observer is measurable and overridable.

Measured in Chromium at real iPhone portrait widths, inside a container the width
HA gives a card (viewport − 16 px):

| Device | Card | Layout | Drawing | Scale | Smallest type | Hidden |
|---|---|---|---|---|---|---|
| 12/13 mini | 359 px | portrait | 327 px | 0.96× | 10.1 px | 0 |
| 12/13/14 | 374 px | portrait | 342 px | 1.01× | 10.6 px | 0 |
| 14 Pro/15/16 | 377 px | portrait | 345 px | 1.01× | 10.7 px | 0 |
| 16 Pro | 386 px | portrait | 354 px | 1.04× | 10.9 px | 0 |
| 12/13 Pro Max | 412 px | portrait | 380 px | 1.12× | 11.7 px | 0 |
| 14/15/16 Plus | 414 px | portrait | 382 px | 1.12× | 11.8 px | 0 |
| 16 Pro Max | 424 px | portrait | 392 px | 1.15× | 12.1 px | 0 |

Nothing is clipped, nothing scrolls sideways, and page-level horizontal scroll is
zero at every width. Card height on a phone is roughly 2900–3100 px, about three
screens of ordinary vertical scrolling.

Below about 330 px of card content width — a 320 pt viewport, so iPhone SE class
rather than anything in the table — the portrait sheet does start scaling down,
reaching ~8.4 px type at 272 px. Everything from the iPhone 12 up is comfortably
above that.

The card uses **no icon library** — the only artwork is the schematic itself, so
it renders identically inside and outside Home Assistant and vendors nothing.

Config is a flat entity map — see the `custom:nibepi-flow-card` block in
`dashboard.yaml`. Every key is optional: anything you leave out, or whose
register is not enabled, is left out of the drawing, and its summary chip, detail
row or whole group hides itself. `details: false` drops the grouped rows and
keeps the diagram, summary and demand meter.

Set `language: de` or `language: en`; the card ships with both label sets,
including `Prio`, compressor state and every detail row label.

### Degree minutes, as heat the house is short of

Degree minutes are the pump's own integral of how far the supply temperature sits
below its calculated target — the closest thing the F1155 has to a "how much heat
does the house want" signal, but published as a confusing negative number.

The card inverts the sign and presents it as **house heat demand**: a positive
number with a bar, a tick marking the compressor start threshold from register
47206 (`DM start heating`, −60 by default), and a plain-language state — *above*
or *below the start threshold*. At zero demand it says so outright rather than
drawing an empty bar. Enable 47206 to get the real threshold; without it the card
assumes 60.

---

## Install

### 1. Enable the missing registers

The dashboard is designed against a larger register set than a default NibePi
install polls. Open the NibePi UI → **Registers** and switch these on. The four
marked **required** are the ones without which whole cards stay empty.

| Register | Title | Why |
|---|---|---|
| **40072** | BF1 EP14 Flow | **Required** — no flow, no heat output, no COP |
| **40017** | EB100-EP14-BT12 Condensor Out | **Required** — the only supply sensor upstream of QN10, so the only one that gives heat output during hot water production too |
| **43084** | Int. el.add. Power | **Required** — immersion heater share of input power |
| **43427** | Compressor State EP14 | **Required** — stopped / starting / running / stopping |
| **43086** | Prio | **Required** — drives the card's active-branch highlight |
| 40013 | BT7 HW Top | Tank top temperature — **only if the tank has a BT7**. Many F1155 installs have BT6 alone; leave it off and the card drops the BT7 pill from the drawing by itself |
| 47007 | Heat Curve S1 | Curve selection |
| 47011 | Heat Offset S1 | The real "make it warmer" knob |
| 47394 | Use room sensor S1 | Room sensor on/off |
| 43091 | Int. el.add. State | Active immersion heater steps |
| 43420 / 43424 | Compressor run hours, total / hot water | Runtime accounting |
| 43081 / 43239 | Additional heat run hours, total / hot water | Runtime accounting |
| 44306 / 44308 | Heat meters, compressor only | Compressor-only energy split |
| 40079 / 40081 / 40083 | BE1–BE3 current | Per-phase current — **only useful if the load monitor's current transformers are actually clamped on the incoming phases**. Without them these registers sit at 0.0 A forever; the shipped dashboard leaves them out |
| 43064 / 43065 | Heat medium ΔT set point / actual | Flow diagnostics |
| 44874 | State SG Ready | SG Ready state |
| 47206 | DM start heating | Real compressor start threshold on the heat demand meter |
| 40071 | BT25 Ext. Supply | Only if you have an external supply sensor |

Each extra register adds one entry to the RS485 poll cycle, so the refresh
interval per register grows a little. Going from 37 to ~60 registers is
comfortable on an F1155.

### 2. Install the helper package

```bash
# on the Home Assistant host
mkdir -p /config/packages
cp packages/nibepi.yaml /config/packages/nibepi.yaml
```

Make sure `configuration.yaml` contains:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

If NibePi is not reachable at `http://nibepi:1880`, edit the `rest_command`
URL in the package. If you enabled Basic Auth in the NibePi UI, uncomment the
`username` / `password` lines there too.

Restart Home Assistant, then confirm **Developer Tools → Template** renders:

```jinja
{{ states('sensor.nibe_heat_output') }} kW at COP {{ states('sensor.nibe_cop') }}
```

### 3. Install the card

```bash
cp nibepi-card.js /config/www/nibepi-card.js
```

Register it under **Settings → Dashboards → ⋮ → Resources → Add resource**:

- URL `/local/nibepi-card.js?v=3.2.2`
- Type **JavaScript module**

**Keep the `?v=` and bump it on every update.** Home Assistant serves `/local/`
with `Cache-Control: max-age=2678400` — thirty-one days — so a browser that has
loaded the card once will not go back for a new one, no matter what you copy over
the file on disk. Changing the query string is what actually invalidates it; a
normal reload will not.

The console should log `NIBEPI-FLOW-CARD v3.2.2` on load. If it reports an older
version, the browser is serving a cached copy and nothing else you change will
have any effect. Two ways to check what is really running:

```js
customElements.get('nibepi-flow-card').version     // -> "3.2.2"
```

and the card logs its own layout decision whenever it changes:

```
NIBEPI-FLOW-CARD v3.2.2: card 1532px -> landscape (layout: auto, wide_at: 900)
```

That line distinguishes the two reasons the schematic can come out portrait — a
genuinely narrow card, or a stale script — without any guessing.

### 4. Install apexcharts-card

HACS → Frontend → search **apexcharts-card** → install. It draws the temperature,
degree-minute and brine history charts. The 30-day energy bars use core Home
Assistant's `statistics-graph` card and need nothing installed.

### 5. Create the dashboard

**Settings → Dashboards → Add dashboard → New dashboard from scratch**, open it,
then pencil → ⋮ → **Raw configuration editor**, and paste `dashboard.yaml` over
the contents.

---

## Requirements

- Home Assistant **2024.11+** — sections views, `heading` cards, tile
  `numeric-input` and `select-options` features, badge `visibility`
- HACS: **apexcharts-card** — history charts only; every energy card is core
- NibePi with MQTT discovery enabled and the device named `Nibe Heat Pump`

All other cards are core Home Assistant. Mushroom, button-card and card-mod are
deliberately *not* required.

---

## Entity naming

NibePi publishes discovery with `name: "Nibe <register title>"` on a device named
`Nibe Heat Pump`. Home Assistant prefixes the device name when generating the
entity id, so register 40004 becomes:

```
sensor.nibe_heat_pump_nibe_bt1_outdoor_temperature
```

That double `nibe_` is where every entity id in these files comes from. If you
have renamed entities in HA, adjust the ids — the flow card's entity map makes
this a one-place edit for the schematic.

---

## What the derived sensors actually measure

| Sensor | Formula | Caveat |
|---|---|---|
| `sensor.nibe_heat_output` | `flow[l/min] × ΔT[K] × 0.06977` | ΔT is **BT12 − BT3** where register 40017 is enabled, falling back to BT2 − BT3. Water on the heat medium side, so no glycol correction. Zero unless flow > 0.5 l/min and supply > return |
| `sensor.nibe_electrical_input` | `43141 / 1000 + 43084` | Compressor inverter power plus immersion heater. **Excludes** the circulation pumps and control board. Register 43141 counts in units of **10 W**, not W — NibePi ≥ 1.4.6 scales it; before that it read a tenth of the truth and COP came out ten times too good |
| `sensor.nibe_cop` | heat output ÷ electrical input | Therefore a *compressor* COP — roughly 3–6 % optimistic versus a meter on the supply line. Unavailable below 0.3 kW output, where the ratio is noise |
| `sensor.nibe_electric_energy` | Riemann sum of electrical input | Integration platform, `method: left` |
| `sensor.nibe_cop_today` / `_month` | (heat + hot water produced) ÷ electricity | Uses the pump's own heat meters, which are themselves estimates |

The heat meter registers (44298 / 44300) are the pump's internal calculation, not
a physical meter. Treat all of this as good relative data — excellent for
spotting a change in behaviour, not a substitute for a calibrated heat meter.

---

## Alarm reset

Register 45171 is edge-triggered: the pump acts on the 0 → 1 transition, so
writing `1` from Home Assistant does nothing once the register is latched at 1.
`script.nibe_reset_alarm` therefore calls NibePi's `POST /api/alarm/reset`
endpoint, which emits the edge correctly, and raises a persistent notification if
the call fails.

Do not use `number.nibe_heat_pump_nibe_alarm_reset` for this — it will appear to
work and silently do nothing.

---

## Regenerating the alarm tables

Both the card and the package embed the alarm code → text mapping, generated from
`lib/alarms.json`:

```bash
node homeassistant/gen-alarms.js
```

This rewrites the `ALARM_TABLE` constant in `nibepi-card.js` and the `names` dict
between the `GENERATED-ALARM-MAP` markers in `packages/nibepi.yaml`. Do not edit
either by hand.

---

## Known gaps

These are NibePi-side limitations that the Home Assistant layer works around
rather than fixes:

1. **Discovery configs are not re-published when Home Assistant restarts.**
   NibePi publishes each retained discovery config once per MQTT connection. If
   the retained message is lost (broker without persistence restarting, or the
   device being deleted from the MQTT integration), the entities do not come back
   until NibePi's MQTT connection drops and reconnects. The standard fix is to
   subscribe to `homeassistant/status` and re-publish discovery on the `online`
   birth message.
2. ~~**No `state_class` in discovery**~~ — fixed in NibePi 1.4.6. Numeric
   registers now discover with `measurement`, and kWh, run-hour and start
   counters with `total_increasing`, so they are charted as numbers and kept in
   long-term statistics. The mirror sensors in the package are retained anyway:
   the `utility_meter` entities have years of history attached to them, and
   repointing those at the raw registers would orphan it.
3. **`has_entity_name` is not set**, which is what produces the doubled
   `nibe_heat_pump_nibe_` prefix. Fixing it would give clean ids but rename every
   existing entity and orphan its history.
4. **The value topic sits under the discovery prefix** (`homeassistant/nibe/modbus/…`).
   Harmless, but it puts pump data inside the namespace Home Assistant scans for
   discovery messages.
5. **Alarm text is not published**, only the code — hence the generated lookup
   tables in this folder.
