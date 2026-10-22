import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import type { BuildingConfig, OpenItem, Pt } from '../types';
import type { ParsedDxf } from '../dxf/parse';

export const DEFAULT_CEILING = 120;
export const DEFAULT_WINDOW_SILL = 36;
export const DEFAULT_WINDOW_HEAD = 84;
export const DEFAULT_SOFFIT_DROP = 12;
export const DEFAULT_OPENING_DEPTH = 24;
export const DEFAULT_BEAM = { length: 120, width: 6, depth: 12 };

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BuildingModel {
  group: THREE.Group;
  ceiling: THREE.Object3D;
  bounds: Bounds;
  ceilingHeight: number;
  /** Wall edges at body height, as [x1, y1, x2, y2] in plan inches, for walk collision. */
  collision: number[][];
  /** Meshes the measure tool can hit. */
  pickables: THREE.Object3D[];
  /** Invisible click targets (openings) that selection can hit but measuring ignores. */
  itemPickables: THREE.Object3D[];
  openItems: OpenItem[];
  warnings: string[];
  /** Resolved openings and soffits, so the editor can show defaults and find them. */
  openings: OpeningInfo[];
  /** DXF openings the user has removed, so the editor can offer to restore them. */
  removedOpenings: string[];
  soffits: { id: string; height: number; center: Pt }[];
  walls: { id: string; label?: string; height: number; center: Pt }[];
  sections: { id: string; height: number; center: Pt }[];
  /** Resolved beams: stand-ins filled in, with the underside and top heights. */
  beams: { id: string; center: Pt; length: number; width: number; depth: number; bottom: number; top: number }[];
  /** Beams, so they can be shown or hidden together. */
  beamGroup: THREE.Group;
  /** Wall faces before openings are cut, as [x1, y1, x2, y2], for snapping new openings to a wall. */
  wallEdges: number[][];
  /** Outlines the item (opening) or tints its material (wall, section, soffit, ceiling). */
  highlight(ref: BuildingItemRef | null): void;
}

export interface OpeningInfo {
  id: string;
  kind: 'door' | 'window';
  custom: boolean;
  label?: string;
  sill: number;
  head: number;
  center: Pt;
  width: number;
  depth: number;
  angle: number;
}

/** What a clicked building mesh stands for. */
export interface BuildingItemRef {
  kind: 'wall' | 'section' | 'opening' | 'soffit' | 'beam' | 'ceiling';
  id: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const toRing = (pts: Pt[]): Ring => {
  const ring: Ring = pts.map((p) => [r2(p.x), r2(p.y)]);
  // Closed explicitly: extrude() drops the last point of each ring.
  ring.push([...ring[0]]);
  return ring;
};

function segmentRect(a: Pt, b: Pt, t: number): Polygon | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 0.01) return null;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const h = t / 2;
  // Extend both ends by half a thickness so perpendicular walls meet in square corners.
  const p0 = { x: a.x - ux * h, y: a.y - uy * h };
  const p1 = { x: b.x + ux * h, y: b.y + uy * h };
  const nx = -uy * h;
  const ny = ux * h;
  return [toRing([
    { x: p0.x + nx, y: p0.y + ny },
    { x: p1.x + nx, y: p1.y + ny },
    { x: p1.x - nx, y: p1.y - ny },
    { x: p0.x - nx, y: p0.y - ny },
  ])];
}

function extrude(mp: MultiPolygon, z0: number, z1: number, material: THREE.Material, edgeColor: number | null, into: THREE.Group, pick: THREE.Object3D[], item?: BuildingItemRef) {
  for (const poly of mp) {
    const ring = (r: Ring) => r.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y));
    const shape = new THREE.Shape(ring(poly[0]));
    for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(ring(hole)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
    // Shape is built in plan (x, y) and extruded along +z. Map (x, y, z) to world (x, z, -y).
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, z0, 0);
    const mesh = new THREE.Mesh(geo, material);
    if (item) mesh.userData.item = item;
    into.add(mesh);
    pick.push(mesh);
    if (edgeColor !== null) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: edgeColor }));
      into.add(edges);
    }
  }
}

/** Plain rectangle from a to b, `w` wide, with square ends. */
function rectPoly(a: Pt, b: Pt, w: number): Polygon | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 0.01 || w < 0.01) return null;
  const nx = (-(b.y - a.y) / len) * (w / 2);
  const ny = ((b.x - a.x) / len) * (w / 2);
  return [toRing([
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ])];
}

/** Four corners of an opening's footprint. p0 to p1 runs along its width. */
export function openingFootprint(c: Pt, width: number, depth: number, angleDeg: number): Pt[] {
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a) * width / 2, uy = Math.sin(a) * width / 2;
  const vx = -Math.sin(a) * depth / 2, vy = Math.cos(a) * depth / 2;
  return [
    { x: c.x - ux - vx, y: c.y - uy - vy },
    { x: c.x + ux - vx, y: c.y + uy - vy },
    { x: c.x + ux + vx, y: c.y + uy + vy },
    { x: c.x - ux + vx, y: c.y - uy + vy },
  ];
}

const normAngle = (deg: number) => ((deg % 180) + 180) % 180;

export function buildBuilding(cfg: BuildingConfig, dxf: ParsedDxf): BuildingModel {
  const group = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const itemPickables: THREE.Object3D[] = [];
  const openItems: OpenItem[] = [];
  const warnings = [...dxf.warnings];

  const addLabel = (text: string | undefined, c: Pt, y: number, parent: THREE.Object3D = group) => {
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'fx-label';
    el.textContent = text;
    const l = new CSS2DObject(el);
    l.position.set(c.x, y, -c.y);
    parent.add(l);
  };

  const ceilingH = cfg.ceilingHeight ?? DEFAULT_CEILING;
  if (cfg.ceilingHeight == null) openItems.push({ id: 'building', kind: 'building', label: 'Building', missing: ['finished ceiling height'] });

  // One material per editable item so a selection can tint just that item.
  const mats = new Map<string, THREE.MeshLambertMaterial>();
  const matFor = (ref: BuildingItemRef, color = 0xe9e6df, placeholder = false) => {
    const key = `${ref.kind}:${ref.id}`;
    let m = mats.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, transparent: placeholder, opacity: placeholder ? 0.6 : 1 });
      m.userData.base = color;
      mats.set(key, m);
    }
    return m;
  };
  const wallEdge = 0x8a867c;

  // ---- Each wall as its own footprint ----
  const wallParts: Polygon[][] = [];
  const centerlineClosed = cfg.closedPolylines === 'centerline';
  for (const w of dxf.walls) {
    const parts: Polygon[] = [];
    if (w.closed && !centerlineClosed && w.pts.length >= 3) {
      parts.push([toRing(w.pts)]);
    } else {
      const n = w.pts.length;
      const last = w.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const seg = segmentRect(w.pts[i], w.pts[(i + 1) % n], cfg.defaultWallThickness);
        if (seg) parts.push(seg);
      }
    }
    wallParts.push(parts);
  }
  if (!wallParts.some((p) => p.length)) throw new Error(`No walls found on layer "${cfg.layers.walls}" in base.dxf`);
  const wallMPs: MultiPolygon[] = wallParts.map((p) => (p.length ? polygonClipping.union(p[0], ...p.slice(1)) : []));
  const wallMP: MultiPolygon = polygonClipping.union(wallMPs.find((m) => m.length)!, ...wallMPs.filter((m) => m.length).slice(1));

  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const poly of wallMP) for (const [x, y] of poly[0]) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }
  const wallEdges: number[][] = [];
  for (const poly of wallMP) for (const ring of poly) for (let j = 0; j < ring.length - 1; j++) wallEdges.push([ring[j][0], ring[j][1], ring[j + 1][0], ring[j + 1][1]]);

  // ---- Resolve openings: DXF ones (with overrides) plus ones added in the viewer ----
  interface Resolved extends OpeningInfo {
    placeholder: boolean;
    footprint: Pt[];
  }
  const resolved: Resolved[] = [];
  const removedOpenings: string[] = [];
  const finish = (r: Omit<Resolved, 'footprint' | 'center'> & { center: Pt }) => {
    const head = Math.min(r.head, ceilingH);
    const sill = Math.max(0, Math.min(r.sill, head - 1));
    resolved.push({ ...r, head, sill, footprint: openingFootprint(r.center, r.width, r.depth, r.angle) });
  };
  for (const o of dxf.openings) {
    const entry = cfg.openings.find((e) => e.id === o.id);
    if (entry?.deleted) { removedOpenings.push(o.id); continue; }
    let sill: number;
    let head: number;
    let placeholder = false;
    if (o.kind === 'door') {
      sill = entry?.sill ?? 0;
      head = entry?.head ?? cfg.defaultDoorHeight;
    } else {
      sill = entry?.sill ?? DEFAULT_WINDOW_SILL;
      head = entry?.head ?? DEFAULT_WINDOW_HEAD;
      placeholder = entry?.sill == null || entry?.head == null;
      if (placeholder) {
        const missing = [entry?.sill == null ? 'sill height' : '', entry?.head == null ? 'head height' : ''].filter(Boolean);
        openItems.push({ id: o.id, kind: 'opening', label: `Window "${o.id}"${entry ? '' : ' (add to building.json)'}`, missing });
      }
    }
    const [p0, p1, p2] = o.footprint;
    finish({
      id: o.id, kind: o.kind, custom: false, label: entry?.label, sill, head, placeholder,
      center: { x: entry?.x ?? o.center.x, y: entry?.y ?? o.center.y },
      width: entry?.width ?? Math.hypot(p1.x - p0.x, p1.y - p0.y),
      depth: entry?.depth ?? Math.hypot(p2.x - p1.x, p2.y - p1.y),
      angle: normAngle(entry?.angle ?? (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI),
    });
  }
  for (const c of cfg.customOpenings ?? []) {
    finish({ id: c.id, kind: c.kind, custom: true, label: c.label, sill: c.sill, head: c.head, placeholder: false, center: { x: c.x, y: c.y }, width: c.width, depth: c.depth, angle: normAngle(c.angle) });
  }
  for (const e of cfg.openings) if (!dxf.openings.some((o) => o.id === e.id)) warnings.push(`building.json lists opening "${e.id}" but no matching entity was found in the DXF.`);
  for (const e of cfg.soffits) if (!dxf.soffits.some((s) => s.id === e.id)) warnings.push(`building.json lists soffit "${e.id}" but no matching outline was found in the DXF.`);

  // ---- Walls: split into pieces by section, each cut around the openings ----
  interface Piece { mp: MultiPolygon; height: number; ref: BuildingItemRef }
  const pieces: Piece[] = [];
  const wallInfo: BuildingModel['walls'] = [];
  const sections = cfg.wallSections ?? [];
  const sectionRects = sections.map((s) => rectPoly(s.a, s.b, s.width));
  let seen: MultiPolygon = [];
  wallMPs.forEach((mp, i) => {
    const id = `wall-${i + 1}`;
    const entry = cfg.walls?.find((e) => e.id === id);
    const height = entry?.height ?? ceilingH;
    const ref: BuildingItemRef = { kind: 'wall', id };
    // Walls that overlap an earlier one only keep the part that is new, so faces never fight.
    let rest: MultiPolygon = seen.length && mp.length ? polygonClipping.difference(mp, seen) : mp;
    seen = mp.length ? (seen.length ? polygonClipping.union(seen, mp) : mp) : seen;
    // Longest outer edge: a point that really is on this wall, for labels and "go to".
    let best = { len: 0, x: 0, y: 0 };
    for (const poly of mp) for (let j = 0; j < poly[0].length - 1; j++) {
      const [x1, y1] = poly[0][j];
      const [x2, y2] = poly[0][j + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len > best.len) best = { len, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
    wallInfo.push({ id, label: entry?.label, height, center: { x: best.x, y: best.y } });
    addLabel(entry?.label, best, height + 6);
    sectionRects.forEach((rect, k) => {
      if (!rect || !rest.length) return;
      const part = polygonClipping.intersection(rest, rect);
      if (!part.length) return;
      pieces.push({ mp: part, height: sections[k].height, ref: { kind: 'section', id: sections[k].id } });
      rest = polygonClipping.difference(rest, rect);
    });
    if (rest.length) pieces.push({ mp: rest, height, ref });
  });

  const footprints = resolved.map((o) => [toRing(o.footprint)] as Polygon);
  for (const piece of pieces) {
    const H = piece.height;
    if (H < 0.5) continue;
    const mat = matFor(piece.ref);
    const body: MultiPolygon = footprints.length ? polygonClipping.difference(piece.mp, ...footprints) : piece.mp;
    extrude(body, 0, H, mat, wallEdge, group, pickables, piece.ref);
    resolved.forEach((o, i) => {
      let zone: MultiPolygon = polygonClipping.intersection(piece.mp, footprints[i]);
      if (i > 0 && zone.length) zone = polygonClipping.difference(zone, ...footprints.slice(0, i));
      if (!zone.length) return;
      const ref: BuildingItemRef = { kind: 'opening', id: o.id };
      const sill = Math.min(o.sill, H);
      const head = Math.min(o.head, H);
      if (sill > 0.01) extrude(zone, 0, sill, mat, wallEdge, group, pickables, ref);
      if (head < H - 0.01) extrude(zone, head, H, mat, wallEdge, group, pickables, ref);
    });
  }
  for (const [k, s] of sections.entries()) if (!sectionRects[k]) warnings.push(`Wall section "${s.id}" has no length or width.`);

  // Walk collision: everything solid at floor level and body height. Only openings that reach the floor are passable.
  const solid = pieces.filter((p) => p.height >= 36).map((p) => p.mp).filter((m) => m.length);
  const solidMP: MultiPolygon = solid.length ? polygonClipping.union(solid[0], ...solid.slice(1)) : [];
  const passable = footprints.filter((_, i) => resolved[i].sill <= 0.01);
  const floorLevel: MultiPolygon = solidMP.length && passable.length ? polygonClipping.difference(solidMP, ...passable) : solidMP;
  const collision: number[][] = [];
  for (const poly of floorLevel) for (const ring of poly) for (let j = 0; j < ring.length - 1; j++) {
    collision.push([ring[j][0], ring[j][1], ring[j + 1][0], ring[j + 1][1]]);
  }

  // ---- Window glass, plus an invisible click target and outline for every opening ----
  const outlines = new Map<string, THREE.Object3D>();
  for (const o of resolved) {
    const [p0, p1] = o.footprint;
    const rotY = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const h = o.head - o.sill;
    const ref: BuildingItemRef = { kind: 'opening', id: o.id };
    addLabel(o.label, o.center, o.head + 6);
    if (o.kind === 'window') {
      const glassMat = new THREE.MeshBasicMaterial({
        color: o.placeholder ? 0xffa733 : 0x8fc7ff,
        transparent: true,
        opacity: o.placeholder ? 0.4 : 0.25,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(o.width, h), glassMat);
      glass.position.set(o.center.x, (o.sill + o.head) / 2, -o.center.y);
      glass.rotation.y = rotY;
      glass.userData.item = ref;
      group.add(glass);
      pickables.push(glass);
      glass.add(new THREE.LineSegments(new THREE.EdgesGeometry(glass.geometry), new THREE.LineBasicMaterial({ color: o.placeholder ? 0xd9822b : 0x5b8db8 })));
    }
    const boxGeo = new THREE.BoxGeometry(o.width, h, o.depth);
    const proxy = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.set(o.center.x, (o.sill + o.head) / 2, -o.center.y);
    proxy.rotation.y = rotY;
    proxy.userData.item = ref;
    proxy.userData.proxy = true;
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0xffc400, depthTest: false }));
    outline.renderOrder = 10;
    outline.visible = false;
    proxy.add(outline);
    group.add(proxy);
    itemPickables.push(proxy);
    outlines.set(o.id, outline);
  }

  // ---- Soffits: bulkheads hanging from the ceiling ----
  const soffitInfo: BuildingModel['soffits'] = [];
  for (const s of dxf.soffits) {
    const entry = cfg.soffits.find((e) => e.id === s.id);
    const h = entry?.height ?? ceilingH - DEFAULT_SOFFIT_DROP;
    const placeholder = entry?.height == null;
    if (placeholder) openItems.push({ id: s.id, kind: 'soffit', label: `Soffit "${s.id}"${entry ? '' : ' (add to building.json)'}`, missing: ['soffit height'] });
    const sx = s.outline.map((p) => p.x);
    const sy = s.outline.map((p) => p.y);
    const sc = { x: (Math.min(...sx) + Math.max(...sx)) / 2, y: (Math.min(...sy) + Math.max(...sy)) / 2 };
    soffitInfo.push({ id: s.id, height: h, center: sc });
    addLabel(entry?.label, sc, Math.min(h, ceilingH) - 6);
    if (h >= ceilingH) continue;
    const ref: BuildingItemRef = { kind: 'soffit', id: s.id };
    extrude([[toRing(s.outline)]], Math.max(0, h), ceilingH, matFor(ref, placeholder ? 0xf0b36a : 0xc9c4b8, placeholder), 0x6f6b61, group, pickables, ref);
  }

  // ---- Beams: boxes under the ceiling. Missing sizes get stand-ins and an open item. ----
  const beamGroup = new THREE.Group();
  const beamInfo: BuildingModel['beams'] = [];
  for (const b of cfg.beams ?? []) {
    const length = b.length ?? DEFAULT_BEAM.length;
    const width = b.width ?? DEFAULT_BEAM.width;
    const depth = b.depth ?? DEFAULT_BEAM.depth;
    const bottom = b.bottom ?? ceilingH - depth;
    const top = bottom + depth;
    const missing = [b.length == null && 'length', b.width == null && 'width', b.depth == null && 'depth'].filter(Boolean) as string[];
    const placeholder = missing.length > 0;
    const ref: BuildingItemRef = { kind: 'beam', id: b.id };
    if (placeholder) openItems.push({ id: b.id, kind: 'beam', label: `Beam "${b.label || b.id}"`, missing });
    const c = { x: b.x, y: b.y };
    beamInfo.push({ id: b.id, center: c, length, width, depth, bottom, top });
    const geo = new THREE.BoxGeometry(length, depth, width);
    const mesh = new THREE.Mesh(geo, matFor(ref, placeholder ? 0xf0b36a : 0xb59a76, placeholder));
    mesh.position.set(c.x, bottom + depth / 2, -c.y);
    mesh.rotation.y = (b.angle * Math.PI) / 180;
    mesh.userData.item = ref;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x6f5a3c })));
    beamGroup.add(mesh);
    pickables.push(mesh);
    addLabel(b.label, c, bottom - 6, beamGroup);
  }
  group.add(beamGroup);

  // ---- Floor with a 1 ft grid ----
  const w = bounds.maxX - bounds.minX;
  const d = bounds.maxY - bounds.minY;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshLambertMaterial({ color: 0xd8d3c8 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(bounds.minX + w / 2, 0, -(bounds.minY + d / 2));
  floor.userData.kind = 'floor';
  group.add(floor);
  pickables.push(floor);
  const grid: number[] = [];
  for (let x = Math.ceil(bounds.minX / 12) * 12; x <= bounds.maxX; x += 12) grid.push(x, 0.05, -bounds.minY, x, 0.05, -bounds.maxY);
  for (let y = Math.ceil(bounds.minY / 12) * 12; y <= bounds.maxY; y += 12) grid.push(bounds.minX, 0.05, -y, bounds.maxX, 0.05, -y);
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  group.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0xbdb7aa, transparent: true, opacity: 0.55 })));

  // ---- Ceiling (hidden by default). Faces down, so it never blocks the view from above. ----
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0xf4f1ea, transparent: true, opacity: 0.85 });
  ceilMat.userData.base = 0xf4f1ea;
  mats.set('ceiling:ceiling', ceilMat);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(bounds.minX + w / 2, ceilingH, -(bounds.minY + d / 2));
  ceiling.visible = false;
  group.add(ceiling);

  const highlight = (ref: BuildingItemRef | null) => {
    for (const m of mats.values()) m.emissive.setHex(0x000000);
    for (const o of outlines.values()) o.visible = false;
    if (!ref) return;
    if (ref.kind === 'opening') {
      const o = outlines.get(ref.id);
      if (o) o.visible = true;
    } else {
      mats.get(`${ref.kind}:${ref.id}`)?.emissive.setHex(0x554400);
    }
  };

  return {
    group, ceiling, bounds, ceilingHeight: ceilingH, collision, pickables, itemPickables, openItems, warnings,
    openings: resolved.map(({ placeholder: _p, footprint: _f, ...info }) => info),
    removedOpenings,
    soffits: soffitInfo,
    beams: beamInfo,
    beamGroup,
    walls: wallInfo,
    sections: sections.map((s) => ({ id: s.id, height: s.height, center: { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 } })),
    wallEdges,
    highlight,
  };
}
