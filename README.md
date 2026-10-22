# Disco Pizza Co. 3D Layout Viewer

A browser-based 3D walkthrough of the space at 910 OH-28. Open the link, look around, click equipment, measure distances. No install, no login.

All layout data lives in `data/` as plain files, so every change is a reviewable git diff.

## What is in the box

- **Orbit** (default), **Walk** (66" eye height, collides with walls) and **Plan** (top-down, north up) views
- **Editing:** select a fixture and drag it on the floor to move it (Shift snaps to 6 in). The panel edits label, category, size, elevation, position, rotation and notes. **+ Add** creates a fixture, **Duplicate** and **Delete** manage them. Click a wall to set its own height (walls are numbered Wall 1, Wall 2, ... in the Items list; blank follows the ceiling height). **Split wall** (click a start and an end point) makes a section of wall with its own height. **+ Opening** adds a door or window on the nearest wall. Drag a selected opening along a wall, or edit its type, sill, head, width, cut depth, position and angle. DXF openings can be edited, removed and restored. Soffits and openings can be labelled. The ceiling height is the "Ceiling" entry in the Items list.
- Edits are saved in your browser. **Export JSON** downloads `fixtures.json` and `building.json` to replace the files in `data/`. **Reset** discards local edits.
- Saved viewpoints from `data/views.json`
- Click equipment for name, category, size, elevation, phase and notes
- **Measure** tool: click two points on the floor, walls or equipment, get feet-inches
- Toggles for each category, the `future` phase, labels and the ceiling
- Anything still `null` shows as a striped or orange placeholder and appears in the **Open items** list
- **Copy link** shares the exact camera position (the URL hash)

## Run it

```
npm install
npm run dev        # local preview
npm run build      # static site in dist/
```

## Updating the layout

1. Export the DWG master to `data/base.dxf`.
2. Edit `data/building.json` and `data/fixtures.json` by hand, or ask Claude Code ("move the three-comp sink 18 inches north", "add a 48-inch reach-in next to the prep table").
3. Commit and push. The host rebuilds and the same URL shows the new layout.

> `data/base.dxf` is the master DXF for 910 OH-28 (walls from Josh's plan plus AL's equipment on `AL_*` layers, real inches, origin at the southwest exterior corner). The viewer reads `WALLS`, `DOORS` and `WINDOWS` from it. Door swings (arc plus leaf) are collapsed to one opening each, and touching window pieces are merged. Windows have no text labels, so `building.json` names them with an `at` point (plan inches). `tools/dxf/` holds the scripts that rebuild the master from the ArcSite PDF and AL's DWG. `npm run sample-dxf` still regenerates the old placeholder box.
> AL's `AL_EQUIPMENT` inserts are drawn as translucent purple footprint boxes (toggle: "AL draft equipment"). Heights are guesses by block name, in `src/scene/draft.ts`. They are not clickable and not in `fixtures.json`. `FIXTURES` and `COUNTERS` are not read yet. `data/fixtures.json` positions are still `null` until AL's A1 to A21 schedule arrives. The saved views are rough starting points.

### Units and orientation

All dimensions are **inches**. Plan coordinates follow the DXF: +X is east, +Y is north, Z is up. If the DXF is drawn in feet or millimetres, set `"units"` in `building.json` to `in`, `ft`, `mm`, `cm` or `m` and everything is converted on import.

## DXF layer conventions

Layer names are set in `building.json` under `layers`. Case does not matter.

| Layer | Draw | Result |
|---|---|---|
| `WALLS` | Lines or open polylines along the **wall centerline** | Extruded to ceiling height, `defaultWallThickness` thick. Ends are extended half a thickness so corners close |
| `WALLS` | **Closed polylines** | Extruded as drawn (an outline). Set `"closedPolylines": "centerline"` in `building.json` if you draw rooms as closed centerline loops instead |
| `DOORS` | One line or one rectangle **across the opening** | Cut from the floor to the door height |
| `WINDOWS` | One line or one rectangle across the opening (storefront and drive-thru too) | Cut between sill and head, with a glass pane |
| `SOFFITS` | A **closed polyline** around the dropped area | A bulkhead hanging from the ceiling down to the soffit height |
| `ANNOTATION` | Text labels (see below) | Used for IDs. Everything else is ignored |

Tips:

- Draw each door or window as a single line or rectangle. Do not draw the door leaf or swing on the `DOORS` layer. Put swings on another layer.
- Arcs and splines are not read. Blocks (INSERTs) on the door, window and soffit layers are read by their overall footprint.
- The cutout is `openingDepth` inches deep (default 24) so it reliably goes through the wall, even when you draw only a thin line.

### How openings and soffits get their IDs

Put a text label (TEXT or MTEXT) **near** each door, window or soffit on the `ANNOTATION` layer, within `labelSearchRadius` inches (default 72). For a soffit, put the label inside the outline.

A label counts as an ID when either:

1. its text is already listed in `building.json` (for example `storefront-1`, `drive-thru`, `soffit-1`), or
2. it starts with `#` (for example `#front-door`). Use this for a new item you have not added to `building.json` yet.

All other text, like "DINING ROOM", is ignored, so room names do not get mistaken for IDs. IDs are lowercased and spaces become hyphens. Each label names one thing, and the closest one wins. A thing with no label gets an automatic ID (`door-1`, `window-2`) and a warning in the browser console.

## `data/building.json`

```json
{
  "units": "in",
  "ceilingHeight": null,
  "defaultWallThickness": 6,
  "defaultDoorHeight": 80,
  "layers": { "walls": "WALLS", "doors": "DOORS", "windows": "WINDOWS", "soffits": "SOFFITS", "annotation": "ANNOTATION" },
  "openings": [ { "id": "storefront-1", "sill": null, "head": null } ],
  "soffits": [ { "id": "soffit-1", "height": null } ]
}
```

`null` means "not measured yet". The viewer uses a stand-in and lists it under Open items:

| Value | Stand-in |
|---|---|
| `ceilingHeight` | 120 in |
| Window `sill` / `head` | 36 in / 84 in, orange glass |
| Soffit `height` | 12 in below the ceiling, orange |
| Door `head` | `defaultDoorHeight` (80 in). Doors are never flagged |

Optional extras: `closedPolylines`, `openingDepth`, `labelSearchRadius`.

Windows found in the DXF but not listed in `openings` are still drawn and show up in Open items with the note "add to building.json".

## `data/fixtures.json`

An array of objects:

| Field | Notes |
|---|---|
| `id` | Unique, kebab-case |
| `name` | Shown on click and in the label |
| `category` | `equipment`, `refrigeration`, `sink`, `storage`, `seating`, `counter`, `hood`, `other` |
| `width`, `depth`, `height` | Inches. `null` while unknown. Width runs along the fixture's own left-right, depth front-to-back |
| `elevation` | Bottom of the object above the floor, default 0. Use for hoods and wall-mounted items. `null` on a hood uses 78 in and is flagged |
| `x`, `y` | **Center** point in plan, inches. `null` parks the item in a staging row south of the building, labelled "position TBD" |
| `rotation` | Degrees clockwise from north, default 0 |
| `phase` | `opening` (default) or `future`. Future items are drawn translucent and can be toggled off |
| `notes` | Shown on click |

Stand-in sizes for `null` dimensions depend on the category (for example 36 x 30 x 36 for equipment).

## `data/views.json`

Saved viewpoint buttons. Coordinates are plan inches with `z` up:

```json
{ "id": "front-door", "name": "Front door", "mode": "walk",
  "eye": { "x": 280, "y": 24, "z": 66 }, "target": { "x": 280, "y": 200, "z": 60 } }
```

`mode` is `walk` or `orbit`.

## Deploy

The included workflow (`.github/workflows/deploy.yml`) publishes to **GitHub Pages** on every push to `main`. One-time setup: in the repo, Settings, Pages, set Source to **GitHub Actions**.

For Netlify or Cloudflare Pages, use build command `npm run build` and output directory `dist`. The build uses relative paths, so it works on a subpath.

## Controls

| Mode | Controls |
|---|---|
| Orbit / Plan | Drag to rotate (Orbit only), right-drag or two fingers to pan, scroll or pinch to zoom |
| Walk | W A S D or up/down arrows move, left/right arrows turn, drag to look, Shift to hurry |
| Anywhere | Click equipment to inspect, Esc to deselect, Measure button then two clicks |

Walk mode needs a keyboard, so it is meant for desktop. Orbit and Plan work on touch screens.

## Not in v1

Textures and real equipment models, in-browser editing, plumbing/electrical/HVAC, exterior and roof, multi-user comments.
