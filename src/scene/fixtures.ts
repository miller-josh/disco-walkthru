import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Category, Fixture, OpenItem } from '../types';
import type { Bounds } from './building';

export const CATEGORY_COLORS: Record<Category, number> = {
  equipment: 0xd9534f,
  refrigeration: 0x3b8fd9,
  sink: 0x2fb5a8,
  storage: 0x9a7b4f,
  seating: 0x8e6bbf,
  counter: 0xe8a33d,
  hood: 0x7f8c8d,
  other: 0x6c757d,
};

export const CATEGORIES = Object.keys(CATEGORY_COLORS) as Category[];

/** Stand-in sizes (W x D x H, inches) for fixtures whose dimensions are still null. */
const DEFAULT_SIZE: Record<Category, [number, number, number]> = {
  equipment: [36, 30, 36],
  refrigeration: [48, 30, 36],
  sink: [60, 30, 36],
  storage: [48, 24, 72],
  seating: [30, 30, 30],
  counter: [72, 30, 36],
  hood: [96, 48, 24],
  other: [24, 24, 24],
};
const DEFAULT_ELEVATION: Partial<Record<Category, number>> = { hood: 78 };

export interface FixtureEntry {
  data: Fixture;
  group: THREE.Group;
  mesh: THREE.Mesh;
  label: CSS2DObject;
  size: { w: number; d: number; h: number };
  elevation: number;
  /** Any of width/depth/height/elevation was null. */
  placeholder: boolean;
  /** x or y was null, so it sits in the staging row. */
  unplaced: boolean;
}

export interface FixtureSet {
  group: THREE.Group;
  entries: FixtureEntry[];
  openItems: OpenItem[];
}

const stripeCache = new Map<number, THREE.CanvasTexture>();
function stripes(color: number): THREE.CanvasTexture {
  let tex = stripeCache.get(color);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#' + new THREE.Color(color).getHexString();
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 12;
  for (let i = -64; i < 128; i += 32) {
    g.beginPath();
    g.moveTo(i, 64);
    g.lineTo(i + 64, 0);
    g.stroke();
  }
  tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  stripeCache.set(color, tex);
  return tex;
}

export function buildFixtures(fixtures: Fixture[], bounds: Bounds): FixtureSet {
  const group = new THREE.Group();
  const entries: FixtureEntry[] = [];
  const openItems: OpenItem[] = [];
  let stagingX = bounds.minX;
  const stagingY = bounds.minY - 96;
  const seen = new Set<string>();

  for (const f of fixtures) {
    if (seen.has(f.id)) console.warn(`Duplicate fixture id "${f.id}" in fixtures.json`);
    seen.add(f.id);
    const cat: Category = f.category in CATEGORY_COLORS ? f.category : 'other';
    if (cat !== f.category) console.warn(`Fixture "${f.id}" has unknown category "${f.category}", shown as "other".`);
    const [dw, dd, dh] = DEFAULT_SIZE[cat];
    const missing: string[] = [];
    const pick = (v: number | null | undefined, fallback: number, name: string) => {
      if (v == null) missing.push(name);
      return v ?? fallback;
    };
    const w = pick(f.width, dw, 'width');
    const d = pick(f.depth, dd, 'depth');
    const h = pick(f.height, dh, 'height');
    const hasDims = missing.length === 0;
    const elevation = f.elevation === undefined ? 0 : pick(f.elevation, DEFAULT_ELEVATION[cat] ?? 0, 'elevation');
    const placeholder = missing.length > 0;
    const unplaced = f.x == null || f.y == null;
    if (f.x == null) missing.push('x');
    if (f.y == null) missing.push('y');

    let x = f.x ?? 0;
    let y = f.y ?? 0;
    if (unplaced) {
      x = stagingX + w / 2;
      y = stagingY;
      stagingX += w + 24;
    }

    const color = CATEGORY_COLORS[cat];
    const future = f.phase === 'future';
    const mat = new THREE.MeshLambertMaterial({
      color: placeholder ? 0xffffff : color,
      map: placeholder ? stripes(color) : null,
      transparent: placeholder || future,
      opacity: placeholder ? 0.8 : future ? 0.55 : 1,
    });
    if (placeholder) mat.map!.repeat.set(Math.max(1, Math.round(w / 24)), Math.max(1, Math.round(h / 24)));
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2;
    mesh.userData.fixtureId = f.id;

    const edgeMat = placeholder || unplaced
      ? new THREE.LineDashedMaterial({ color: 0x222222, dashSize: 3, gapSize: 2 })
      : new THREE.LineBasicMaterial({ color: 0x1b1b1b });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    edges.position.y = h / 2;
    if (placeholder || unplaced) edges.computeLineDistances();

    const el = document.createElement('div');
    el.className = 'fx-label' + (placeholder || unplaced ? ' tbd' : '');
    el.textContent = f.name;
    const tags = [!hasDims ? 'dims TBD' : '', unplaced ? 'position TBD' : '', future ? 'future' : ''].filter(Boolean);
    if (tags.length) {
      const small = document.createElement('small');
      small.textContent = tags.join(' · ');
      el.append(small);
    }
    const label = new CSS2DObject(el);
    label.position.set(0, h + 6, 0);

    const g = new THREE.Group();
    g.position.set(x, elevation, -y);
    g.rotation.y = (-(f.rotation ?? 0) * Math.PI) / 180;
    g.add(mesh, edges, label);
    g.userData = { category: cat, phase: f.phase ?? 'opening', fixtureId: f.id };
    group.add(g);

    entries.push({ data: f, group: g, mesh, label, size: { w, d, h }, elevation, placeholder, unplaced });
    if (missing.length) openItems.push({ id: f.id, kind: 'fixture', label: f.name, missing });
  }
  return { group, entries, openItems };
}

export function setSelected(entry: FixtureEntry, on: boolean) {
  (entry.mesh.material as THREE.MeshLambertMaterial).emissive.setHex(on ? 0x444400 : 0x000000);
}
