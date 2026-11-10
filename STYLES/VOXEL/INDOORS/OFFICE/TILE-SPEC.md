# Tile Spec — Voxel Office

version: 1.0
last-updated: 2026-11-11
source brief: [`office.md`](office.md)
generator: [`scripts/office-voxel.mjs`](../../../../scripts/office-voxel.mjs) + renderer [`scripts/voxel-engine.mjs`](../../../../scripts/voxel-engine.mjs) (`node scripts/office-voxel.mjs`, no dependencies; about 1 minute on 9 threads)

Tiles are generated, not hand-edited: change the generator and re-run it, never the PNGs.

```yaml
## Projection
projection:        2:1 dimetric   # same grid as the pixel office set, at twice the size
ground_angle_deg:  26.565
tile_w_px:         256
tile_h_px:         128
unit_elevation_px: 128            # 1 tile of height
wall_height_px:    320            # 2.5 tiles
wall_thickness_px: 16             # 0.125 tile, inside the tile, on its back edge

## Look (from office.md)
shapes:            rounded solids, no cubes; no outlines
light:             upper-left; top x1.1, faces towards the lower-left lit, faces towards the lower-right in shade
shadows:           soft, projected to the right; props carry their own floor shadow as translucent black pixels
anti_aliasing:     2x2 supersampling, straight alpha
emissive:          screens, neon, LEDs, lamps and window skies ignore shading
sky:               day "#87CEEB", night "#041A40"

## Canvas and anchor
floors:            256x128, anchor (128, 128) = the diamond's bottom vertex
wall_pieces:       walls, decorations, doors, windows: fixed 256x512, anchor (128, 512)
props:             fitted canvas, never smaller than the footprint diamond; anchor = bottom vertex of the footprint
config:            office_tileset.json. Per frame: frame (trimmed rect on its sheet), anchor (relative to the frame),
                   pivot, sourceSize / spriteSourceSize (the PNG file's canvas and where the frame sits in it),
                   file_anchor (anchor inside the PNG file), file, label, image (sheet), footprint, on_desk
sheets:            office_tileset.png, office_tileset_2.png, ... 2500x2500, frames trimmed, 2px apart

## Naming (same names as the pixel set where the item exists there)
floors:            floor-<name>_flat
walls:             wall-<style>_<ne|nw|corner>
decor:             decor-<name>_<ne|nw>[_part1|_part2]
doors:             door-<style>_<ne|nw>_<closed|open>[_part1|_part2]
windows:           window-<kind>_<ne|nw>_<day|night>[_part1|_part2]
props:             <item>_<sw|se|ne|nw|flat>   # the way the front faces; flat = one sprite
```

## Placing tiles

- Draw floors first, then everything else back to front by tile (`i + j`), a wall before the pieces hung on it.
- `_ne` walls sit on a tile's back-right edge, `_nw` on its back-left edge. On the corner tile use `_corner` (both walls in one sprite). Drawing `_ne` and `_nw` on the same tile leaves a 16px strip wrong.
- Walls and full-width pieces overlap the tile behind them by 2px, so runs have no seams as long as they are drawn back to front.
- Floor shadows and glows of walls are cut to the tile's exact diamond; neighbours never double up.
- Decorations, doors and windows are overlays for a wall tile. Doors and windows paint their own opening (casing, depth, sky or dark doorway), so they work on any wall style.
- Two-tile pieces are cut in `_part1` / `_part2`. `_part1` is the left piece on screen: the lower tile index on an `_ne` wall, the tile nearer the viewer on an `_nw` wall.
- Doors: hinge left on `_ne`, right on `_nw`; open leaves swing 90° into the room. Elevator, sliding glass and iris doors open into the wall.
- Props go on their front tile (nearest the viewer) and cover `i-fx+1..i`, `j-fy+1..j`. Sort multi-tile props by footprint.
- `on_desk` items (monitors, keyboards, mouse pad, laptop, desk lamp) are drawn at desk height (0.75 tile = 96px) with their shadow on the desk top. Give them the desk tile's anchor and draw them after the desk. `monitor-multi-arm` spans a 2x1 desk.
- Hanging lamps (`lamp-ceiling`, `lamp-pendant-green`) hang from wall height and add a light pool on the floor. Draw them after everything on the floor.
- Edge pieces (`cubicle-panel`, `safe-door`, `stair-half-into-wall`) use `ne` / `nw` for the tile edge they stand on. `safe-door` and the stair stand in front of a wall tile.

## Contents (376 sprites)

| Group | Items |
| --- | --- |
| Floors (9) | wood, gray / black / white fluffy / light yellow carpet, ceramic tiles, light cement, black tiles, small blue tiles |
| Walls (9 x ne, nw, corner) | brick, white, gray, red, wood-white, blue-skirting, white-led, tiles-black-big, tiles-black-small-white |
| Decor | tv (2 parts), 7 neon signs ("amazing" is 2 parts), bookshelf, switch-left / right, elevator, picture-sea / forest, tv-dashboard-dark / light and tv-presentation (2 parts), lamp-modern / classic / old |
| Doors (closed + open) | glass, white, black, gray, red, wood-dark, wood-light, emergency, elevator, glass-sliding (2 parts), bunker, iris |
| Windows (day + night) | full, half, grid, arch, circle, circle-big (2 parts) |
| Furniture | lamps (floor, desk, ceiling), desks (gamer, wood, boss), cabin-soundproof, cubicle-panel, monitors, keyboards, mouse-pad, plants, water-fountain, coffee-machine, juice-bar, drinks-bar, coffee-table-controller, game-console, arcade-machine, boxing-machine, ping-pong-table, container-office, safe-door, meeting-table, chairs (ergonomic black / white, libernovo, meeting, bar, chill, egg), pouf-beanbag, ottoman, fatboy-puff, sofa-leather, dog-corgi, cat-black, penguin-big, pool-table, coat-rack, lockers, laptop-silver, aquarium, table-books, printer-3d, laser-cutter, pencil-big-yellow, stair-half-into-wall, stair-spiral-black, slide-tube |
| Kitchen | kitchen-island, cabinet-high / low, fridge-50s / modern / aluminium, table-white / wood / round-wood, kitchen-chair, lamp-pendant-green, picnic-table |

Notes: the brief's "Powe up" sign reads "POWER UP", as in the pixel set. The slide is the tube slide from the ceiling, as in the pixel set.

Previews: `preview_room.png`, `preview_room_night.png`, `preview_day_night.gif` (made with ffmpeg when it is installed), `preview_walls_floors.png`, `preview_decor.png`, `preview_doors.png`, `preview_windows.png`, `preview_furniture.png`, `preview_kitchen.png`.

## Append-only output (rule from office.md)

The generator never overwrites a file. A sprite whose name is already in `office_tileset.json` is not rendered again. New designs become new PNGs on new sheets, and entries are only added to the config. To redraw a tile on purpose, delete its PNG and its config entry, then run the generator; it lands on a new sheet.

Dry run: `OFFICE_OUT=<scratch dir> node scripts/office-voxel.mjs`. `OFFICE_ONLY=<regex>` renders only matching job ids (no previews).

## Validation

```sh
V=.claude/skills/isometric-ops/scripts/tile-validate.py; O=STYLES/VOXEL/INDOORS/OFFICE
uv run $V --tile-w 256 --tile-h 128 --skip-bleed $O/FLOORS/*.png
uv run $V --tile-w 256 --tile-h 128 --skip-bleed --skip-anchor --skip-halo $O/WALLS/*.png $O/DOORS/*.png $O/WINDOWS/*.png $O/DECOR/*.png
uv run $V --skip-bleed --skip-anchor --skip-dimension --skip-halo $O/FURNITURE/*.png $O/KITCHEN/*.png
```

The halo check is skipped because soft shadows, glows and glass are translucent on purpose.
