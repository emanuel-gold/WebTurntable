# Enclosure

All dimensions are in mm, measured from the STLs in `STL/` with `tools/stl_inspect.py`.

Coordinates: the origin is the top-center of the body deck, with +Z up. Angles run counter-clockwise from +X, looking down from above.

## Current parts (v1, from MakerWorld)

| File | Part | Size | Notes |
|---|---|---|---|
| `STL/top plate.stl` | Disk | Ø100 × 9.5 (z 0 to 9.5) | Hub with a D-bore (Ø5.25, 3.2 across the flat) for the motor shaft. Direct drive. |
| `STL/body.stl` | Body | Ø100 × 21.5 (z −21.5 to 0) | 2 mm wall (bore Ø96) and 2 mm deck (z −2 to 0), giving 19.5 internal height. |
| `STL/bottom plate.stl` | Bottom plate | Ø100 × 2.5 (z −23.5 to −21) | 2 mm plate plus a 0.5 mm locating lip that follows the body bore. Engraved artwork underneath. |

### Body features

| Feature | Position | Size |
|---|---|---|
| Shaft hole | Center | Ø10 |
| Motor mount (28BYJ-48, M3 bolt + nut) | (±17.5, −8) | Ø4 |
| ULN2003 board mount (M2 bolt + nut); board rotated about 45° | (0.1, 20.9), (20.5, −0.8), (40.3, 17.9), (19.9, 39.6) | Ø3; hole pattern about 29.8 × 27.2 |
| Three through-deck holes | r = 24 at 30°, 150°, 270° | Ø5; purpose not identified, leave as is |
| Bottom-plate screw bosses (M3 heat-set inserts) | r ≈ 45.2 at 90°, 210°, 330°: (0, 45.2), (±39.2, −22.6) | Ø4 |
| D1 mini cradle | Hangs from the deck toward 150°, down to z ≈ −8.7 | Fits a 34 × 26 board |
| USB-C slot in the wall | 150°, z −6.5 to −13 | About 13 wide × 6.5 tall |
| LED hole in the wall | 150°, z ≈ −17.5 | About Ø3 |

The 28BYJ-48 hangs from the deck and fills almost the whole internal height (its bottom is at z ≈ −21). That is why the DevKit (about 52 × 28) doesn't fit in the current body alongside the motor and driver.

## v2 design: riser ring

Keep the body, disk and bottom plate as they are, or lightly modified, and add one new part between the body and the bottom plate: a **riser ring**. Below the motor it adds a free layer across the full diameter, where the DevKit sits.

```
┌──────────── disk ────────────┐  unchanged
├──────────── body ────────────┤  motor + ULN2003 under the deck (unchanged)
├─────────── riser ────────────┤  NEW: DevKit layer, micro-USB opening
└──────── bottom plate ────────┘  + DevKit cradle
```

### Riser ring

- **Outer shape:** Ø100, with the wall profile copied from the body's lower section (bore Ø96 plus the three boss lobes). It lines up with the body, and the original bottom plate seats in it unchanged.
- **Top lip:** a 0.5 mm locating lip copied from the bottom plate, so the riser seats in the body exactly as the plate does.
- **Bolt holes:** Ø3.4 through-holes at the three screw positions. The bottom-plate M3 bolts pass through the riser into the body's inserts, so each bolt gets longer by the riser height.
- **USB opening:** a micro-USB opening at the DevKit's USB end, for power and programming (decided 2026-10-14). Most micro-USB plug housings need about 11 × 8 of clearance around the socket. A USB-C connector is a [backlog](ROADMAP.md#backlog-deferred) item and isn't designed in.
- **Height H:** set by the DevKit stack with Dupont housings on its header pins (Dupont chosen 2026-10-14; see [HARDWARE.md](HARDWARE.md#dupont-harness)).

| Layer | Height | Source |
|---|---|---|
| Top of the WROOM shield to the underside of the header spacer | ≈ 7 | 13 measured to the pin tips, minus ≈ 6 of exposed pin |
| Dupont housing, from the spacer | ≈ 14 | Typical crimp housing; measure one |
| Wire bend at the housing exit | ≈ 5 | |
| **Stack** | **≈ 26** | Riser H ≈ 27 with clearance |

- **Orientation** (decide when designing the cradle):
  - **Pins down on standoffs:** module and USB socket on top. The wires leave the housings downward and have to bend along the plate.
  - **Flipped:** module down on short standoffs. The wires leave upward, toward the ULN2003 in the body. If the board sits under free space below the deck, the bend can use that space and the riser can be lower.
- **Mounting holes:** four, one at each corner. Their centers are 23.37 apart across the width, about 2.5 in from each long edge (from the board's dimension drawing).
- **Still needed:** the hole diameter, the lengthwise hole spacing (about 47 scaled from the drawing, but not dimensioned there), and one housing measurement: with a housing pushed onto a header pin, measure from the top of the WROOM shield to the end of the housing. See [roadmap open questions](ROADMAP.md#open-questions).

### Bottom plate v2

- The original plate plus a DevKit cradle. This board has mounting holes, so the cradle is screw posts or standoffs sized to them (measurements pending).
- Lay the DevKit along a chord with its USB end at the wall. At 51.45 × 28.33 it fits anywhere inside Ø96.
- Keep the antenna end (opposite the USB end) away from the motor and the wiring.

### Body v2 (optional tweaks)

- Close the old USB-C slot with a patch (optional). A USB-C socket there is a [backlog](ROADMAP.md#backlog-deferred) item.
- Reuse the LED hole for the status LED.
- Add a zero index mark on the rim, matching a notch on the disk, for a manual Set zero.
- Leave the D1 mini cradle in place; it doesn't get in the way.

## Workflow

- v2 parts will be generated by Python scripts in `enclosure/` (not created yet). They use `manifold3d` mesh booleans on the original STLs plus simple primitives, so they build on either PC with or without CAD software. All three original STLs load as valid watertight meshes.
- Scripts write their output to `STL/v2/`. Commit the generated STLs together with the scripts.
- Check results in Blender or a slicer before printing. Blender can also render previews headless: `blender --background --python …`.
- On a PC without CAD, `python tools/stl_inspect.py slice …` and `loops …` render and measure cross-sections.
- Install `manifold3d` in a virtual environment (`python -m venv .venv`, then `.venv/Scripts/pip install manifold3d numpy`), not globally.
