# Tile Spec — Pixel Office

version: 1.0
last-updated: 2026-11-09
source brief: [`office.md`](../../../../office.md)
generator: [`scripts/office-pixel.mjs`](../../../../scripts/office-pixel.mjs) (`node scripts/office-pixel.mjs`, no dependencies)

Tiles are generated, not hand-edited: change the generator and re-run it, never the PNGs.

```yaml
## Projection
projection:        2:1 dimetric   # commonly called isometric in games; it is dimetric
ground_angle_deg:  26.565         # arctan(1/2): lines step 2px across, 1px up

## Grid module
native_tile:       64x32          # drawn at this size...
pixel_scale:       2              # ...then exported at 2x with nearest-neighbour
tile_w_px:         128            # exported floor diamond
tile_h_px:         64             # = tile_w_px / 2
unit_elevation_px: 32             # exported px per z-step (16 native)
wall_height_px:    160            # 5 z-steps (80 native), plus 6px cap + ink line

## Canvas and anchor
canvas:            128x256 fixed  # every tile, floors included
diamond:           bottom 64 rows of the canvas
anchor:            bottom-center  # the diamond's bottom vertex = (64, 256)
pivot_normalized:  [0.5, 1.0]
pivot_origin:      top-left       # = [0.5, 0.0] with a bottom-left origin (Unity)

## Footprints
footprints:        [1x1]
walls:             thin walls on a tile's back edge (_ne or _nw). They share the
                   floor tile's anchor, so they sit off-centre in their canvas.
corner:            place an _ne and an _nw wall on the same tile
decorations:       transparent overlays on the wall face, same canvas and anchor as the
                   wall. Draw them on the same tile, after the wall.
multi_tile:        pieces wider than one tile (TV, "Everything is going to be..." sign)
                   are cut into one-tile parts, _part1 = the left-hand piece on screen
                   (ne wall: lower tile index; nw wall: the tile nearer the viewer)

## Margins & bleed
margin:            fixed-canvas
edge_bleed:        allowed        # floor diamonds and multi-tile parts touch the canvas edges by design
seamless:          floor and wall textures repeat every tile; no outline at tile seams

## Palette & light
max_colors:        32 per tile    # ordered (Bayer 4x4) dithering, no blended colours
anti_aliasing:     none
light_direction:   upper-left
plane_order:       floor > _ne walls (lit, x1.00) > _nw walls (shadow, x0.84)
emissive:          LED, neon, TV screen and elevator lights ignore face shading
ink:               "#1b1d22", 1px, on wall tops only

## Output
format:            PNG-32 (RGBA 8-bit, straight alpha, sRGB, no ICC)
tileset:           office_tileset.png, 1024x1024, 8 cols x 4 rows of 128x256 cells
atlas:             office_tileset.json (frame rects, anchor, pivot per tile)
decor_tileset:     office_decor_tileset.png + .json, same 1024x1024 layout

## Naming
name_grammar:      name_direction.png
directions:        flat (floors) | ne (wall on back-right edge) | nw (wall on back-left edge)
parts:             _part1, _part2 suffix for multi-tile decorations

## Scale grammar
human_height_px:   ~112 exported (3.5 z-steps). Walls are 5 z-steps, about 1.4 humans tall.
```

## Tileset layout

| Row | Contents |
| --- | --- |
| 0 | Floors: wood, gray carpet, black carpet, light gray cement, black tiles, small blue tiles |
| 1 | Walls `_ne`: brick, white, wood/white, light blue + skirting, white + LED, big black tiles, small black tiles/white |
| 2 | Walls `_nw`: same order as row 1 |
| 3 | Empty |

Decoration sheet (`office_decor_tileset.png`): rows 0–1 are `_ne`, rows 2–3 are `_nw`, 16 pieces each in this order:
TV (2 parts), neon "Everything is going to be fucking amazing" (2 parts), neon "Fuck Trump", "Trust your code", "100% Coffee made", "Deploy on Fridays", "May the force be with you", "Power up", bookshelf, light switch left, light switch right, elevator, sea picture, forest picture.

Neon text uses a 3x5 pixel font. Each tube has a dim shadow pixel under it, not a full glow, because a halo would close the 1px gaps between letters.

## Validation

```sh
uv run .claude/skills/isometric-ops/scripts/tile-validate.py --tile-w 128 --tile-h 64 \
  --max-colors 32 --skip-bleed STYLES/PIXEL/INDOORS/OFFICE/FLOORS/*.png
uv run .claude/skills/isometric-ops/scripts/tile-validate.py --tile-w 128 --tile-h 64 \
  --max-colors 32 --skip-bleed --skip-anchor STYLES/PIXEL/INDOORS/OFFICE/WALLS/*.png
uv run .claude/skills/isometric-ops/scripts/tile-validate.py --tile-w 128 --tile-h 64 \
  --max-colors 32 --skip-bleed --skip-anchor STYLES/PIXEL/INDOORS/OFFICE/DECOR/*.png
```

Walls and decorations skip the anchor check because it assumes a centred sprite, and edge walls are off-centre on purpose.

## Append-only output (rule from office.md)

The generator never overwrites an existing file. Tile PNGs, sheets and previews that already exist are kept as they are, even if the code that drew them changes.

- New designs are written as new PNGs and packed onto new sheets (`office_tileset_3.png`, `_4`, …). An existing sheet is never reopened, even if it has empty cells.
- `office_tileset.json` is the one config for the whole set. Entries are only ever added, never changed. Every frame has an `image` field naming its sheet, and `meta.sheets` lists all sheets.
- `office_decor_tileset.json` is the old atlas for the first decoration batch. It is kept, and its entries are also in `office_tileset.json`.
- To redraw a tile on purpose, delete its PNG and its config entry, then run the generator.

## Batch 2: doors, windows, TVs

| Sheet | Contents |
| --- | --- |
| `office_tileset_3.png` | `_ne` doors: glass, white, black, gray, red, dark wood, light wood, elevator, emergency (each `_closed` then `_open`), then the big sliding glass door (2 parts, closed then open) |
| `office_tileset_4.png` | `_nw` doors, same order |
| `office_tileset_5.png` | Windows (full, half, white grid, arch, circle; `_ne` then `_nw`, each `_day` then `_night`), then the TVs: dashboard dark, dashboard light, presentation (2 parts each, `_ne` then `_nw`) |

```yaml
doors:
  folder:          DOORS/
  naming:          door-<style>_<ne|nw>_<closed|open>.png
  opening:         20 x 59 native px (40 x 118 exported), casing 2px. A door is an overlay on its wall tile.
  hinge:           left on _ne doors, right on _nw doors
  open:            doorway shows a dark void; the leaf swings 90° into the room, shaded like the
                   other wall orientation. Elevator doors slide into the wall instead.
  sliding_glass:   2 tiles wide (_part1/_part2). Open = both panels hidden in the wall pocket.
  emergency:       steel door with a red panic bar and a green EXIT sign above
windows:
  folder:          WINDOWS/
  naming:          window-<kind>_<ne|nw>_<day|night>.png
  sky:             day "#87CEEB", night "#041A40" (from office.md), emissive with glass glare.
                   Day sky has clouds; night sky has stars.
  full:            floor-to-ceiling. Runs of full windows tile into a glass curtain wall.
tvs:
  folder:          DECOR/
  naming:          decor-tv-<dashboard-dark|dashboard-light|presentation>_<ne|nw>_part<1|2>.png
  size:            2 tiles wide, same frame as the first big TV
```

Previews: `preview_doors.png` (closed doors on the right wall, open doors on the left) and `preview_windows_screens.png` (day windows on the right, night windows on the left, plus all three TVs).

## Batch 3: office elements (furniture and props)

Props are drawn by a small voxel renderer in the generator, not pixel by pixel:

```yaml
furniture:
  folder:          FURNITURE/
  sheets:          office_tileset_6.png .. office_tileset_11.png (sizes vary; read frames from office_tileset.json)
  voxel_scale:     1 voxel = 1 floor texel; 32 voxels = 1 tile (about 1 m); 1 voxel tall = 1 native px
  desk_height:     24 voxels (48 exported px)
  rendering:       each pixel is traced into the model, so props keep the floor's exact 2:1 stepping
  shading:         top x1.12, +y face x1.0 (lit), +x face x0.8 (shadow); screens and lights are emissive
  glass:           checkerboard see-through (every other pixel shows what is behind)
  outline:         1px ink "#1b1d22" around the silhouette
  naming:          <item>_<sw|se|ne|nw|flat>.png. The direction is the way the item's front faces:
                   sw = towards the viewer's lower left, se = lower right, ne / nw = facing away.
                   flat = symmetric item, one sprite. Wall items (safe-door, cubicle-panel) use
                   ne / nw for the tile edge they sit on, like walls.
  canvas:          ((fx + fy) * 64) x ((fx + fy) * 32 + head room) exported px, for footprint fx x fy tiles
  anchor:          bottom vertex of the footprint. Put the prop on its FRONT tile (the one nearest the
                   viewer); it covers tiles i-fx+1..i, j-fy+1..j. Each frame has anchor, pivot and footprint.
  desk_items:      monitor-multi-arm, monitor-large, keyboard, keyboard-ergonomic and mouse-pad have
                   on_desk: true. They are drawn at desk height: give them the desk's (or that desk
                   tile's) anchor and draw them right after the desk. monitor-multi-arm spans a 2x1 desk.
  sorting:         multi-tile props should be depth-sorted by their footprint (AABB), not a single point
```

| Item | Footprint | Directions |
| --- | --- | --- |
| desk-wood, desk-gamer, juice-bar, drinks-bar, monitor-multi-arm | 2x1 | sw se ne nw |
| desk-boss | 3x2 | sw se ne nw |
| container-office | 3x3 | sw se ne nw |
| ping-pong-table | 3x2 | sw se |
| meeting-table | 4x2 | sw se |
| cabin-soundproof, monitor-large, keyboard, keyboard-ergonomic, mouse-pad, water-fountain, coffee-machine, coffee-table-controller, game-console, arcade-machine, boxing-machine, chair-ergonomic, chair-meeting | 1x1 | sw se ne nw |
| plant-cactus, plant, plant-tree, chair-bar, pouf-beanbag, ottoman | 1x1 | flat |
| safe-door, cubicle-panel | 1x1, on a tile edge | ne nw |

Preview: `preview_furniture.png`. Validate with `--skip-dimension --skip-anchor --skip-bleed --max-colors 32`. Prop canvases aren't multiples of the tile module, and cubicle panels span the whole tile edge, like walls.

Dry run: `OFFICE_OUT=<scratch copy of this folder> node scripts/office-pixel.mjs` writes into the copy, so new designs can be checked before they land here for good.

## Batch 4: stairs, slide, big circle window

Sheet `office_tileset_12.png` (packed by size; frames are in `office_tileset.json`). Preview: `preview_stairs.png`.

| Item | File(s) | Footprint | Notes |
| --- | --- | --- | --- |
| Half stair into the wall | `FURNITURE/stair-half-into-wall_nw.png`, `FURNITURE/stair-half-into-wall-ne_ne.png` | 2x1 / 1x2 | 6 steps (8 px rise) up to a landing at 48 px, then a doorway in the wall. Place it against the wall named by the suffix: `_nw` enters the left (NW) wall, `_ne` the right (NE) wall. Not rotated, because the doorway must sit on a visible wall. |
| Round black stairs | `FURNITURE/stair-spiral-black_flat.png` | 2x2 | One full turn, 16 steps of 5 px, centre pole, balusters, helical rail, top landing at 88 px |
| Slide | `FURNITURE/slide_<sw\|se\|ne\|nw>.png` | 3x1 | Ladder, platform at 46 px, yellow chute down to 4 px |
| Big circle window | `WINDOWS/window-circle-big_<ne\|nw>_<day\|night>_part<1\|2>.png` | 2 wall tiles | Diameter 54 native px with a cross bar; part1 = left piece on screen |

## Batch 5: lounge, pets, kitchen

Sheets `office_tileset_13.png` .. `office_tileset_16.png` (packed by size). Preview: `preview_lounge_kitchen.png`. Same voxel rules as batch 3.

| Item | File prefix | Footprint | Directions |
| --- | --- | --- | --- |
| Ergonomic black chair | `FURNITURE/chair-ergonomic_` (from batch 3) | 1x1 | sw se ne nw |
| Ergonomic white chair | `FURNITURE/chair-ergonomic-white_` | 1x1 | sw se ne nw |
| Big leather sofa | `FURNITURE/sofa-leather_` | 3x1 | sw se ne nw |
| Big chilling chair (hanging egg chair) | `FURNITURE/chair-chill_` | 1x1 | sw se ne nw |
| Corgi dog, black cat, big penguin | `FURNITURE/dog-corgi_`, `cat-black_`, `penguin-big_` | 1x1 | sw se ne nw |
| Pool table | `FURNITURE/pool-table_` | 3x2 | sw se |
| Jacket and hat holder | `FURNITURE/coat-rack_` | 1x1 | sw se ne nw |
| Lockers | `FURNITURE/lockers_` | 2x1 | sw se ne nw |
| Silver laptop (on a desk, `on_desk: true`) | `FURNITURE/laptop-silver_` | 1x1 | sw se ne nw |
| Kitchen island | `KITCHEN/kitchen-island_` | 2x1 | sw se ne nw |
| Kitchen high / low cabinet | `KITCHEN/kitchen-cabinet-high_`, `kitchen-cabinet-low_` | 1x1 | sw se ne nw |
| 50's, modern, aluminium fridge | `KITCHEN/fridge-50s_`, `fridge-modern_`, `fridge-aluminium_` | 1x1 | sw se ne nw |
| Kitchen white / wood table | `KITCHEN/kitchen-table-white_`, `kitchen-table-wood_` | 2x1 | sw se |
| Kitchen round wood table | `KITCHEN/kitchen-table-round-wood_flat` | 1x1 | flat |
| Kitchen chair | `KITCHEN/kitchen-chair_` | 1x1 | sw se ne nw |
| Low-hanging green pendant lamp | `KITCHEN/lamp-pendant-green_flat` | 1x1 | flat. Hangs from the ceiling (cord to the canvas top); place it on the tile below it and draw it after everything on the floor. |
| Garden picnic table | `KITCHEN/picnic-table_` | 2x2 | sw se |

Coverage check (2026-11-09): all 101 items in `office.md` (95 bullets; the neon bullet is 7 signs) have sprites, and all 311 entries in `office_tileset.json` point to existing files.
