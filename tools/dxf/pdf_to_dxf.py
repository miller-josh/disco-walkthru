"""Trace Josh's ArcSite PDF plan into a layered DXF in real inches."""
import sys, math, pymupdf, ezdxf

SRC, OUT = sys.argv[1], sys.argv[2]
S = 383.5 / (510.51 - 97.4)     # inches per PDF point, from the 31'11 1/2" dimension
X0, Y0 = 92.72, 748.01          # SW exterior corner (PDF points) becomes 0,0

def T(p): return ((p.x - X0) * S, (Y0 - p.y) * S)

def bez(a, b, c, d, n=10):
    out = []
    for i in range(n + 1):
        t = i / n; mt = 1 - t
        out.append(pymupdf.Point(
            mt**3*a.x + 3*mt*mt*t*b.x + 3*mt*t*t*c.x + t**3*d.x,
            mt**3*a.y + 3*mt*mt*t*b.y + 3*mt*t*t*c.y + t**3*d.y))
    return out

def subpaths(path):
    """Split a PyMuPDF path into point lists, breaking where segments don't connect."""
    subs, cur = [], []
    for it in path['items']:
        k = it[0]
        if k == 'l': seg = [it[1], it[2]]
        elif k == 'c': seg = bez(it[1], it[2], it[3], it[4])
        elif k == 're': r = it[1]; seg = [r.tl, r.tr, r.br, r.bl, r.tl]
        elif k == 'qu': q = it[1]; seg = [q.ul, q.ur, q.lr, q.ll, q.ul]
        else: continue
        if cur and abs(cur[-1].x - seg[0].x) < 0.01 and abs(cur[-1].y - seg[0].y) < 0.01 and k in 'lc':
            cur += seg[1:]
        else:
            if cur: subs.append(cur)
            cur = list(seg)
    if cur: subs.append(cur)
    return subs

def closed(pts): return len(pts) > 2 and abs(pts[0].x - pts[-1].x) < .05 and abs(pts[0].y - pts[-1].y) < .05

def style(x):
    col = tuple(round(v, 2) for v in (x.get('color') or ()))
    fill = tuple(round(v, 2) for v in (x.get('fill') or ()))
    return x['type'], col, fill, round(x.get('width') or 0, 2), ''.join(sorted(set(i[0] for i in x['items'])))

doc = ezdxf.new('R2013', setup=True)
doc.header['$INSUNITS'] = 1        # inches
doc.header['$MEASUREMENT'] = 0
layers = {
    'WALLS': 7, 'DOORS': 3, 'WINDOWS': 5, 'COUNTERS': 8, 'FIXTURES': 4,
    'DIMENSIONS': 9, 'NOTES': 1,
}
for n, c in layers.items(): doc.layers.add(n, color=c)
msp = doc.modelspace()

page = pymupdf.open(SRC)[0]
drawings = page.get_drawings()

# door swing arcs: endpoints used to tell door leaves from window glazing
arc_pts = []
for x in drawings:
    if style(x)[:4] == ('s', (0.0, 0.0, 0.0), (), 0.3) and 'c' in style(x)[4]:
        for sp in subpaths(x): arc_pts += [sp[0], sp[-1]]
def near_arc(p): return any(abs(p.x - q.x) < 3.0 and abs(p.y - q.y) < 3.0 for q in arc_pts)

counts = {}
seen = set()
def add(layer, pts, close):
    sig = (layer, tuple(sorted((round(p.x, 1), round(p.y, 1)) for p in pts)))
    if sig in seen: return
    seen.add(sig)
    msp.add_lwpolyline([T(p) for p in pts], close=close, dxfattribs={'layer': layer})
    counts[layer] = counts.get(layer, 0) + 1

for x in drawings:
    t, col, fill, w, kinds = style(x)
    r = x['rect']
    big = max(r.width, r.height)
    if t == 's' and big > 500: continue                       # background grids
    if t == 'f' and fill == (0.4, 0.4, 0.4):
        if kinds == 'l' or big > 400:                          # wall bodies and counters
            for sp in subpaths(x):
                xs = [p.x for p in sp]; ys = [p.y for p in sp]
                inner = min(xs) > 94 and max(xs) < 165 and (272 < min(ys) < 306 or 368 < min(ys) < 395)
                add('COUNTERS' if inner else 'WALLS', sp, True)
        else:                                                  # dimension lines, arrows, outlined text
            for sp in subpaths(x): add('DIMENSIONS', sp, closed(sp))
    elif t == 'f':                                             # blue and black notes
        for sp in subpaths(x): add('NOTES', sp, closed(sp))
    elif t == 's' and col == (0.4, 0.4, 0.4) and w in (0.25, 0.5, 0.12):
        for sp in subpaths(x): add('DIMENSIONS', sp, False)
    elif t == 's' and col == (0.0, 0.0, 0.0) and w == 0.3 and 'c' in kinds:
        for sp in subpaths(x): add('DOORS', sp, False)
    elif t == 's' and col == (0.0, 0.0, 0.0) and w == 0.3:
        for sp in subpaths(x):
            add('DOORS' if (near_arc(sp[0]) or near_arc(sp[-1])) else 'WINDOWS', sp, False)
    elif t == 's' and col == (0.0, 0.0, 0.0) and w == 0.45:
        for sp in subpaths(x):
            xs = [p.x for p in sp]; ys = [p.y for p in sp]
            if big > 400: add('WALLS', sp, True); continue     # wall outline duplicates fill; keep as outline
            inner = min(xs) > 94 and max(xs) < 165 and 270 < min(ys) < 395
            if inner: continue                                 # counter outlines duplicate the fills
            wd, ht = max(xs) - min(xs), max(ys) - min(ys)
            stub = closed(sp) and min(wd, ht) < 7 and max(wd, ht) > 20     # short wall stubs
            add('WALLS' if (r.width > 100 or stub) else 'FIXTURES', sp, closed(sp))
    elif col == (0.32, 0.88, 0.04):
        for sp in subpaths(x): add('COUNTERS', sp, False)
    else:
        for sp in subpaths(x): add('FIXTURES', sp, closed(sp))

doc.saveas(OUT)
print('scale in/pt', round(S, 5), counts)
