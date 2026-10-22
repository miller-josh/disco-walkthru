import * as THREE from 'three';
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';
import type { BuildingConfig, OpenItem, Pt } from '../types';
import type { ParsedDxf } from '../dxf/parse';

export const DEFAULT_CEILING = 120;
export const DEFAULT_WINDOW_SILL = 36;
export const DEFAULT_WINDOW_HEAD = 84;
export const DEFAULT_SOFFIT_DROP = 12;

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
  openItems: OpenItem[];
  warnings: string[];
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

function extrude(mp: MultiPolygon, z0: number, z1: number, material: THREE.Material, edgeColor: number | null, into: THREE.Group, pick: THREE.Object3D[]) {
  for (const poly of mp) {
    const ring = (r: Ring) => r.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y));
    const shape = new THREE.Shape(ring(poly[0]));
    for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(ring(hole)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
    // Shape is built in plan (x, y) and extruded along +z. Map (x, y, z) to world (x, z, -y).
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, z0, 0);
    const mesh = new THREE.Mesh(geo, material);
    into.add(mesh);
    pick.push(mesh);
    if (edgeColor !== null) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: edgeColor }));
      into.add(edges);
    }
  }
}

export function buildBuilding(cfg: BuildingConfig, dxf: ParsedDxf): BuildingModel {
  const group = new THREE.Group();
  const pickables: THREE.Object3D[] = [];
  const openItems: OpenItem[] = [];
  const warnings = [...dxf.warnings];

  const ceilingH = cfg.ceilingHeight ?? DEFAULT_CEILING;
  if (cfg.ceilingHeight == null) openItems.push({ id: 'building', kind: 'building', label: 'Building', missing: ['finished ceiling height'] });

  // ---- Walls as one merged 2D footprint ----
  const parts: Polygon[] = [];
  const centerlineClosed = cfg.closedPolylines === 'centerline';
  for (const w of dxf.walls) {
    if (w.closed && !centerlineClosed && w.pts.length >= 3) {
      parts.push([toRing(w.pts)]);
      continue;
    }
    const n = w.pts.length;
    const last = w.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const seg = segmentRect(w.pts[i], w.pts[(i + 1) % n], cfg.defaultWallThickness);
      if (seg) parts.push(seg);
    }
  }
  if (!parts.length) throw new Error(`No walls found on layer "${cfg.layers.walls}" in base.dxf`);
  const wallMP: MultiPolygon = polygonClipping.union(parts[0], ...parts.slice(1));

  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const poly of wallMP) for (const [x, y] of poly[0]) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }

  // ---- Resolve opening heights ----
  interface Resolved {
    id: string;
    kind: 'door' | 'window';
    sill: number;
    head: number;
    placeholder: boolean;
    footprint: Pt[];
    center: Pt;
  }
  const resolved: Resolved[] = dxf.openings.map((o) => {
    const entry = cfg.openings.find((e) => e.id === o.id);
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
    head = Math.min(head, ceilingH);
    sill = Math.max(0, Math.min(sill, head - 1));
    return { id: o.id, kind: o.kind, sill, head, placeholder, footprint: o.footprint, center: o.center };
  });
  for (const e of cfg.openings) if (!dxf.openings.some((o) => o.id === e.id)) warnings.push(`building.json lists opening "${e.id}" but no matching entity was found in the DXF.`);
  for (const e of cfg.soffits) if (!dxf.soffits.some((s) => s.id === e.id)) warnings.push(`building.json lists soffit "${e.id}" but no matching outline was found in the DXF.`);

  // ---- Walls: full-height body, plus short pieces above and below each opening ----
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xe9e6df });
  const wallEdge = 0x8a867c;
  const footprints = resolved.map((o) => [toRing(o.footprint)] as Polygon);
  const body: MultiPolygon = footprints.length ? polygonClipping.difference(wallMP, ...footprints) : wallMP;
  extrude(body, 0, ceilingH, wallMat, wallEdge, group, pickables);
  resolved.forEach((o, i) => {
    let zone: MultiPolygon = polygonClipping.intersection(wallMP, footprints[i]);
    if (i > 0 && zone.length) zone = polygonClipping.difference(zone, ...footprints.slice(0, i));
    if (!zone.length) return;
    if (o.sill > 0.01) extrude(zone, 0, o.sill, wallMat, wallEdge, group, pickables);
    if (o.head < ceilingH - 0.01) extrude(zone, o.head, ceilingH, wallMat, wallEdge, group, pickables);
  });

  // Walk collision: everything solid at floor level. Only openings that reach the floor (doors) are passable.
  const passable = footprints.filter((_, i) => resolved[i].sill <= 0.01);
  const floorLevel: MultiPolygon = passable.length ? polygonClipping.difference(wallMP, ...passable) : wallMP;
  const collision: number[][] = [];
  for (const poly of floorLevel) for (const ring of poly) for (let j = 0; j < ring.length - 1; j++) {
    collision.push([ring[j][0], ring[j][1], ring[j + 1][0], ring[j + 1][1]]);
  }

  // ---- Window glass ----
  for (const o of resolved) {
    if (o.kind !== 'window') continue;
    const [p0, p1] = o.footprint;
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const h = o.head - o.sill;
    const glassMat = new THREE.MeshBasicMaterial({
      color: o.placeholder ? 0xffa733 : 0x8fc7ff,
      transparent: true,
      opacity: o.placeholder ? 0.4 : 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(len, h), glassMat);
    glass.position.set(o.center.x, (o.sill + o.head) / 2, -o.center.y);
    glass.rotation.y = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    group.add(glass);
    glass.add(new THREE.LineSegments(new THREE.EdgesGeometry(glass.geometry), new THREE.LineBasicMaterial({ color: o.placeholder ? 0xd9822b : 0x5b8db8 })));
  }

  // ---- Soffits: bulkheads hanging from the ceiling ----
  for (const s of dxf.soffits) {
    const entry = cfg.soffits.find((e) => e.id === s.id);
    const h = entry?.height ?? ceilingH - DEFAULT_SOFFIT_DROP;
    const placeholder = entry?.height == null;
    if (placeholder) openItems.push({ id: s.id, kind: 'soffit', label: `Soffit "${s.id}"${entry ? '' : ' (add to building.json)'}`, missing: ['soffit height'] });
    if (h >= ceilingH) continue;
    const mat = new THREE.MeshLambertMaterial({ color: placeholder ? 0xf0b36a : 0xc9c4b8, transparent: placeholder, opacity: placeholder ? 0.6 : 1 });
    extrude([[toRing(s.outline)]], Math.max(0, h), ceilingH, mat, 0x6f6b61, group, pickables);
  }

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
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshLambertMaterial({ color: 0xf4f1ea, transparent: true, opacity: 0.85 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(bounds.minX + w / 2, ceilingH, -(bounds.minY + d / 2));
  ceiling.visible = false;
  group.add(ceiling);

  return { group, ceiling, bounds, ceilingHeight: ceilingH, collision, pickables, openItems, warnings };
}
