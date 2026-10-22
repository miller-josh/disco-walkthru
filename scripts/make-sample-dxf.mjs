// Writes data/base.dxf: a PLACEHOLDER layout so the viewer runs before the real
// export is dropped in. Units are inches, origin at the SW corner, +X east, +Y north.
// Replace data/base.dxf with the real export; this script is not needed after that.
import { writeFileSync } from 'node:fs';

const out = [];
const g = (code, value) => out.push(String(code), String(value));

const LAYERS = ['WALLS', 'DOORS', 'WINDOWS', 'SOFFITS', 'ANNOTATION'];
g(0, 'SECTION'); g(2, 'TABLES');
g(0, 'TABLE'); g(2, 'LAYER'); g(70, LAYERS.length);
LAYERS.forEach((name, i) => {
  g(0, 'LAYER'); g(2, name); g(70, 0); g(62, i + 1); g(6, 'CONTINUOUS');
});
g(0, 'ENDTAB'); g(0, 'ENDSEC');
g(0, 'SECTION'); g(2, 'ENTITIES');

const line = (layer, [x1, y1], [x2, y2]) => {
  g(0, 'LINE'); g(8, layer); g(10, x1); g(20, y1); g(30, 0); g(11, x2); g(21, y2); g(31, 0);
};
const rect = (layer, [x1, y1], [x2, y2]) => {
  g(0, 'LWPOLYLINE'); g(5, 'A' + out.length); g(100, 'AcDbEntity'); g(8, layer);
  g(100, 'AcDbPolyline'); g(90, 4); g(70, 1);
  for (const [x, y] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]) { g(10, x); g(20, y); }
};
const text = (at, [x, y], height = 6) => {
  g(0, 'TEXT'); g(8, 'ANNOTATION'); g(10, x); g(20, y); g(30, 0); g(40, height); g(1, at);
};

const W = 720, D = 432;
// Perimeter, drawn as single centerlines
line('WALLS', [0, 0], [W, 0]);
line('WALLS', [W, 0], [W, D]);
line('WALLS', [W, D], [0, D]);
line('WALLS', [0, D], [0, 0]);
// Dining / kitchen partition, with a gap for the pass-through door
line('WALLS', [400, 0], [400, 200]);
line('WALLS', [400, 236], [400, D]);
// Restroom corridor and mop sink room in the NW corner
line('WALLS', [0, 300], [160, 300]);
line('WALLS', [160, 300], [160, D]);

// Doors: single lines spanning the opening
line('DOORS', [262, 0], [298, 0]);   text("#front-door", [262, -14]);
line('DOORS', [W, 60], [W, 96]);     text("#back-door", [W + 8, 60]);
line('DOORS', [400, 200], [400, 236]); text("#kitchen-door", [370, 214]);
line('DOORS', [60, 300], [96, 300]); text("#mop-room-door", [60, 286]);

// Windows: a line and a rectangle, both supported
line('WINDOWS', [30, 0], [250, 0]);  text('storefront-1', [100, -14]);
rect('WINDOWS', [310, -2], [390, 2]); text('storefront-2', [320, -14]);
line('WINDOWS', [W, 250], [W, 298]); text('drive-thru', [W + 8, 262]);

// Soffit over the kitchen entry
rect('SOFFITS', [400, 120], [520, 316]); text('soffit-1', [430, 210]);

text('DINING ROOM (annotation, ignored by the viewer)', [120, 200], 10);
text('KITCHEN (annotation, ignored by the viewer)', [480, 360], 10);

g(0, 'ENDSEC'); g(0, 'EOF');
writeFileSync(new URL('../data/base.dxf', import.meta.url), out.join('\n') + '\n');
console.log('wrote data/base.dxf');
