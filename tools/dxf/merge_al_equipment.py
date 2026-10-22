"""Merge AL's equipment layout (DWG, read via libredwg-web JSON) into the base DXF, in real inches.

usage: python3 merge_al_equipment.py al_layout.json base.dxf out.dxf
al_layout.json comes from dwg_to_json.mjs (LibreDwg WASM).
"""
import sys, math, json, ezdxf

S = 383.5 / (510.51 - 97.4)      # inches per drawing unit (same frame as Josh's PDF)
X0, Y0 = 92.72, -748.01          # SW exterior corner in AL's drawing coordinates


def T(x, y):
    return ((x - X0) * S, (y - Y0) * S)


ELECTRICAL_BLOCKS = {'Data_Port', 'Electrical_Panel', 'Data_Gathering_Panel'}
DOOR_BLOCKS = {'Single_Door', 'Fixed_Window', '_Open30'}

src = json.load(open(sys.argv[1]))
doc = ezdxf.readfile(sys.argv[2])
msp = doc.modelspace()
for name, color in [('AL_EQUIPMENT', 6), ('AL_LINEWORK', 30), ('AL_LABELS', 1),
                    ('AL_ELECTRICAL', 2), ('AL_AREAS', 9), ('AL_DOORS', 3)]:
    if name not in doc.layers:
        doc.layers.add(name, color=color)


def add_entity(space, e, tf, layer):
    """Add one LibreDWG-JSON entity to an ezdxf layout. tf maps (x, y) to output coords; k scales lengths."""
    a = {'layer': layer}
    t = e['type']
    k = tf.k
    if t == 'LINE':
        space.add_line(tf(e['startPoint']['x'], e['startPoint']['y']), tf(e['endPoint']['x'], e['endPoint']['y']), dxfattribs=a)
    elif t == 'LWPOLYLINE':
        pts = [tf(v['x'], v['y']) for v in e['vertices']]
        space.add_lwpolyline(pts, close=bool(e.get('flag', 0) & 1), dxfattribs=a)
    elif t == 'CIRCLE':
        space.add_circle(tf(e['center']['x'], e['center']['y']), e['radius'] * k, dxfattribs=a)
    elif t == 'ARC':
        space.add_arc(tf(e['center']['x'], e['center']['y']), e['radius'] * k,
                      math.degrees(e['startAngle']), math.degrees(e['endAngle']), dxfattribs=a)
    elif t == 'HATCH':                       # keep the outline; fills are cosmetic
        for p in e['boundaryPaths']:
            pts = [tf(ed['start']['x'], ed['start']['y']) for ed in p.get('edges', []) if ed['type'] == 1]
            if len(pts) > 2:
                space.add_lwpolyline(pts, close=True, dxfattribs=a)
    elif t == 'MTEXT':
        txt = e['text'].strip()
        if txt:
            m = space.add_mtext(txt, dxfattribs={**a, 'char_height': e['textHeight'] * k,
                                                 'attachment_point': e.get('attachmentPoint', 1)})
            m.set_location(tf(e['insertionPoint']['x'], e['insertionPoint']['y']))
    else:
        return False
    return True


class Identity:
    k = 1
    def __call__(self, x, y): return (x, y)


class ToInches:
    k = S
    def __call__(self, x, y): return T(x, y)


# Block definitions, kept in AL's original units; the INSERT scale carries the conversion
for b in src['tables']['BLOCK_RECORD']['entries']:
    name = b['name']
    if name.startswith('*') or not b.get('entities'):
        continue
    bname = 'AL_' + name
    if bname in doc.blocks:
        continue
    bp = b.get('basePoint') or {'x': 0, 'y': 0}
    blk = doc.blocks.new(bname, base_point=(bp['x'], bp['y']))
    for e in b['entities']:
        add_entity(blk, e, Identity(), '0')

counts = {}
def bump(k): counts[k] = counts.get(k, 0) + 1

for e in src['entities']:
    t = e['type']
    if t == 'INSERT':
        name = e['name']
        layer = ('AL_ELECTRICAL' if name in ELECTRICAL_BLOCKS
                 else 'AL_DOORS' if name in DOOR_BLOCKS else 'AL_EQUIPMENT')
        ip = e['insertionPoint']
        msp.add_blockref('AL_' + name, T(ip['x'], ip['y']), dxfattribs={
            'layer': layer,
            'xscale': e.get('xScale', 1) * S,
            'yscale': e.get('yScale', 1) * S,
            'rotation': math.degrees(e.get('rotation', 0)),
        })
        bump(layer)
    elif t == 'MTEXT':
        txt = e['text'].strip()
        layer = ('AL_AREAS' if 'sq ft' in txt
                 else 'AL_ELECTRICAL' if txt in ('GFI', 'Data Port') else 'AL_LABELS')
        if add_entity(msp, e, ToInches(), layer):
            bump(layer)
    elif t == 'DIMENSION':
        continue                              # 2 stray dimensions; walls carry the real dims
    else:
        if add_entity(msp, e, ToInches(), 'AL_LINEWORK'):
            bump('AL_LINEWORK')

doc.saveas(sys.argv[3])
print(counts)
