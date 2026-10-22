import DxfParser from 'dxf-parser';
import type { BuildingConfig, Pt, Units } from '../types';

export interface WallShape {
  pts: Pt[];
  closed: boolean;
}

export interface DxfOpening {
  id: string;
  /** True when the id came from a label in the drawing, false when auto-numbered. */
  labelled: boolean;
  kind: 'door' | 'window';
  /** Oriented rectangle (4 corners) that gets cut out of the walls. */
  footprint: Pt[];
  center: Pt;
}

export interface DxfSoffit {
  id: string;
  labelled: boolean;
  outline: Pt[];
}

export interface ParsedDxf {
  walls: WallShape[];
  openings: DxfOpening[];
  soffits: DxfSoffit[];
  warnings: string[];
}

const UNIT_TO_INCHES: Record<Units, number> = { in: 1, ft: 12, mm: 1 / 25.4, cm: 1 / 2.54, m: 1 / 0.0254 };

interface RawEntity {
  kind: 'door' | 'window' | 'soffit';
  layer: string;
  pts: Pt[];
  closed: boolean;
  /** Axis angle for INSERTs, radians. */
  axis?: number;
  hintId?: string;
}
interface Label {
  text: string;
  at: Pt;
  used: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ent = any;

const same = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

export function slug(text: string): string {
  return text.trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Strip MTEXT formatting codes ({\fArial;text}, \P line breaks). */
function cleanText(raw: string): string {
  return raw
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function entityPoints(e: Ent, blocks: Record<string, Ent>, depth = 0): Pt[] {
  switch (e.type) {
    case 'LINE':
      return (e.vertices ?? []).map((v: Pt) => ({ x: v.x, y: v.y }));
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return (e.vertices ?? []).map((v: Pt) => ({ x: v.x, y: v.y }));
    case 'INSERT': {
      const block = blocks[e.name];
      const base = block?.position ?? { x: 0, y: 0 };
      const sx = e.xScale ?? 1;
      const sy = e.yScale ?? 1;
      const rot = ((e.rotation ?? 0) * Math.PI) / 180;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const local: Pt[] = depth < 4 && block?.entities ? block.entities.flatMap((b: Ent) => entityPoints(b, blocks, depth + 1)) : [];
      const pts = local.length ? local : [{ x: base.x, y: base.y }];
      return pts.map((p) => {
        const lx = (p.x - base.x) * sx;
        const ly = (p.y - base.y) * sy;
        return { x: e.position.x + lx * c - ly * s, y: e.position.y + lx * s + ly * c };
      });
    }
    default:
      return [];
  }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Turn whatever was drawn for an opening into an oriented rectangle: its length runs
 * along the wall, and its width is at least `depth` so it reliably cuts through the wall.
 */
function footprintOf(e: RawEntity, depth: number): { rect: Pt[]; center: Pt } | null {
  const pts = e.pts;
  if (!pts.length) return null;
  let angle: number;
  if (e.axis !== undefined) {
    angle = e.axis;
  } else if (e.closed && pts.length >= 3) {
    let best = 0;
    angle = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const l = dist(a, b);
      if (l > best) {
        best = l;
        angle = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
  } else {
    const a = pts[0];
    const b = pts[pts.length - 1];
    angle = dist(a, b) > 1e-6 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  }
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of pts) {
    const u = p.x * ux + p.y * uy;
    const v = -p.x * uy + p.y * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const vc = (v0 + v1) / 2;
  const half = Math.max(v1 - v0, depth) / 2;
  v0 = vc - half;
  v1 = vc + half;
  if (u1 - u0 < 1) return null;
  const at = (u: number, v: number): Pt => ({ x: u * ux - v * uy, y: u * uy + v * ux });
  const rect = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  return { rect, center: at((u0 + u1) / 2, vc) };
}

export function parseDxf(text: string, cfg: BuildingConfig): ParsedDxf {
  const warnings: string[] = [];
  const dxf = new DxfParser().parseSync(text);
  if (!dxf) throw new Error('Could not read data/base.dxf');
  const k = UNIT_TO_INCHES[cfg.units] ?? 1;
  const blocks = (dxf.blocks ?? {}) as Record<string, Ent>;
  const L = cfg.layers;
  const depth = cfg.openingDepth ?? 24;
  const radius = cfg.labelSearchRadius ?? 72;
  const openingIds = new Set(cfg.openings.map((o) => o.id));
  const soffitIds = new Set(cfg.soffits.map((s) => s.id));
  const knownIds = new Set([...openingIds, ...soffitIds]);

  const walls: WallShape[] = [];
  const raw: RawEntity[] = [];
  const labels: Label[] = [];
  const skipped = new Map<string, number>();

  for (const e of dxf.entities as Ent[]) {
    const layer: string = e.layer ?? '';
    if (e.type === 'TEXT' || e.type === 'MTEXT') {
      const at = e.type === 'TEXT' ? e.startPoint : e.position;
      const t = cleanText(e.text ?? '');
      if (at && t) labels.push({ text: t, at: { x: at.x * k, y: at.y * k }, used: false });
      continue;
    }
    let kind: 'wall' | RawEntity['kind'] | null = null;
    if (same(layer, L.walls)) kind = 'wall';
    else if (same(layer, L.doors)) kind = 'door';
    else if (same(layer, L.windows)) kind = 'window';
    else if (same(layer, L.soffits)) kind = 'soffit';
    if (!kind) continue;

    const pts = entityPoints(e, blocks).map((p) => ({ x: p.x * k, y: p.y * k }));
    if (!pts.length) {
      skipped.set(`${e.type} on ${layer}`, (skipped.get(`${e.type} on ${layer}`) ?? 0) + 1);
      continue;
    }
    const closed = (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && !!e.shape;
    if (kind === 'wall') {
      walls.push({ pts, closed });
    } else {
      raw.push({
        kind,
        layer,
        pts,
        closed,
        axis: e.type === 'INSERT' ? ((e.rotation ?? 0) * Math.PI) / 180 : undefined,
        hintId: e.type === 'INSERT' ? slug(String(e.name)) : undefined,
      });
    }
  }
  for (const [what, n] of skipped) warnings.push(`Ignored ${n} unsupported entit${n > 1 ? 'ies' : 'y'} (${what}). Use lines or polylines.`);

  // Only labels that name something count as IDs. Room names etc. are ignored.
  const idLabels = labels.filter((l) => l.text.startsWith('#') || knownIds.has(slug(l.text)));

  // Greedy global assignment: closest (entity, label) pairs first, each used once.
  const geom = raw.map((e) => (e.kind === 'soffit' ? null : footprintOf(e, depth)));
  const pairs: { i: number; l: number; d: number }[] = [];
  raw.forEach((e, i) => {
    const centroid =
      e.kind === 'soffit'
        ? { x: e.pts.reduce((s, p) => s + p.x, 0) / e.pts.length, y: e.pts.reduce((s, p) => s + p.y, 0) / e.pts.length }
        : geom[i]?.center;
    if (!centroid) return;
    idLabels.forEach((lab, l) => {
      // An ID that building.json lists as an opening can't name a soffit, and vice versa.
      const key = slug(lab.text);
      if (e.kind === 'soffit' ? openingIds.has(key) : soffitIds.has(key)) return;
      const inside = e.kind === 'soffit' && e.closed && pointInPoly(lab.at, e.pts);
      const d = inside ? 0 : dist(centroid, lab.at);
      if (d <= radius) pairs.push({ i, l, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d);
  const idOf = new Map<number, string>();
  for (const p of pairs) {
    if (idOf.has(p.i) || idLabels[p.l].used) continue;
    idOf.set(p.i, slug(idLabels[p.l].text));
    idLabels[p.l].used = true;
  }

  const counters: Record<string, number> = {};
  const taken = new Set<string>();
  const openings: DxfOpening[] = [];
  const soffits: DxfSoffit[] = [];
  raw.forEach((e, i) => {
    let id = idOf.get(i) ?? (e.hintId && knownIds.has(e.hintId) ? e.hintId : undefined);
    const labelled = id !== undefined;
    if (!id) {
      do id = `${e.kind}-${(counters[e.kind] = (counters[e.kind] ?? 0) + 1)}`;
      while (taken.has(id) || knownIds.has(id));
      warnings.push(`A ${e.kind} on layer ${e.layer} has no ID label nearby, so it is called "${id}". Add a text label next to it.`);
    }
    if (taken.has(id)) {
      warnings.push(`Duplicate ID "${id}" in the drawing. Each opening and soffit needs its own ID.`);
      id = `${id}-dup${i}`;
    }
    taken.add(id);
    if (e.kind === 'soffit') {
      if (e.pts.length >= 3) soffits.push({ id, labelled, outline: e.pts });
      else warnings.push(`Soffit "${id}" is not a closed outline, so it was skipped.`);
    } else {
      const g = geom[i];
      if (g) openings.push({ id, labelled, kind: e.kind, footprint: g.rect, center: g.center });
    }
  });

  return { walls, openings, soffits, warnings };
}
