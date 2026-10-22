import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import baseDxf from '../data/base.dxf?raw';
import buildingJson from '../data/building.json';
import fixturesJson from '../data/fixtures.json';
import viewsJson from '../data/views.json';
import './style.css';
import { parseDxf } from './dxf/parse';
import { buildBuilding, DEFAULT_BEAM, DEFAULT_OPENING_DEPTH, openingFootprint, type BuildingItemRef } from './scene/building';
import { buildDraftEquipment } from './scene/draft';
import { buildFixtures, CATEGORIES, CATEGORY_COLORS, setSelected, type FixtureEntry } from './scene/fixtures';
import { Rig, type Mode } from './controls/rig';
import { MeasureTool } from './ui/measure';
import { decodePose, encodePose } from './ui/hash';
import { trim } from './format';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { BuildingConfig, Category, Fixture, OpenItem, Pt, ViewDef } from './types';

const STORE = 'disco-layout-edits-v1';

type Sel = { kind: 'fixture'; id: string } | BuildingItemRef | null;

const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
const attr = (s: string) => escapeHtml(s);

/** Removes label elements and frees geometry before a group is dropped and rebuilt. */
function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
  });
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(err: unknown) {
  const el = $('error');
  el.hidden = false;
  el.textContent = `Could not build the layout.\n\n${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
}

try {
  start();
} catch (err) {
  showError(err);
}

function start() {
  const cfg = structuredClone(buildingJson) as unknown as BuildingConfig;
  let fixtures = structuredClone(fixturesJson) as unknown as Fixture[];
  cfg.walls ??= [];
  cfg.wallSections ??= [];
  cfg.customOpenings ??= [];
  cfg.beams ??= [];
  let edited = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (saved) {
      if (saved.building) {
        cfg.ceilingHeight = saved.building.ceilingHeight ?? null;
        cfg.openings = saved.building.openings ?? cfg.openings;
        cfg.soffits = saved.building.soffits ?? cfg.soffits;
        cfg.walls = saved.building.walls ?? cfg.walls;
        cfg.wallSections = saved.building.wallSections ?? cfg.wallSections;
        cfg.customOpenings = saved.building.customOpenings ?? cfg.customOpenings;
        cfg.beams = saved.building.beams ?? cfg.beams;
      }
      if (Array.isArray(saved.fixtures)) fixtures = saved.fixtures;
      edited = true;
    }
  } catch { /* corrupt or blocked storage: start from the files */ }
  const views = viewsJson as unknown as ViewDef[];

  // ---------- Data -> scene ----------
  const dxf = parseDxf(baseDxf, cfg);
  let building = buildBuilding(cfg, dxf);
  let fx = buildFixtures(fixtures, building.bounds);
  for (const w of building.warnings) console.warn(w);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f1ec);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b3a6, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(-300, 600, 400);
  scene.add(sun);
  const draft = buildDraftEquipment(dxf.equipment);
  scene.add(building.group, fx.group, draft);

  // ---------- Renderers ----------
  const canvas = $<HTMLCanvasElement>('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const labelRenderer = new CSS2DRenderer({ element: $('labels') });
  const camera = new THREE.PerspectiveCamera(50, 1, 4, 8000);

  const rig = new Rig(camera, canvas, building.bounds, building.collision);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    labelRenderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    rig.resize();
  };
  addEventListener('resize', resize);
  resize();

  // ---------- Toggles ----------
  const catOn = new Set<Category>(CATEGORIES);
  let futureOn = true;
  let labelsOn = true;
  const present = new Set<Category>();
  const applyVisibility = () => {
    for (const e of fx.entries) {
      const cat = e.group.userData.category as Category;
      const show = catOn.has(cat) && (futureOn || e.group.userData.phase !== 'future');
      e.group.visible = show;
      e.label.visible = show && labelsOn;
      if (!show && selected === e) select(null);
    }
  };
  const catBox = $('cats');
  function renderCats() {
    catBox.innerHTML = '';
    present.clear();
    for (const e of fx.entries) present.add(e.group.userData.category as Category);
  for (const cat of CATEGORIES) {
    if (!present.has(cat)) continue;
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<input type="checkbox" ${catOn.has(cat) ? 'checked' : ''}><span class="swatch" style="background:#${CATEGORY_COLORS[cat].toString(16).padStart(6, '0')}"></span>${cat}`;
    row.querySelector('input')!.addEventListener('change', (ev) => {
      if ((ev.target as HTMLInputElement).checked) catOn.add(cat);
      else catOn.delete(cat);
      applyVisibility();
    });
    catBox.append(row);
  }
  }
  $<HTMLInputElement>('t-future').addEventListener('change', (e) => { futureOn = (e.target as HTMLInputElement).checked; applyVisibility(); });
  $<HTMLInputElement>('t-labels').addEventListener('change', (e) => { labelsOn = (e.target as HTMLInputElement).checked; applyVisibility(); });
  $<HTMLInputElement>('t-draft').addEventListener('change', (e) => { draft.visible = (e.target as HTMLInputElement).checked; });
  $<HTMLInputElement>('t-ceiling').addEventListener('change', (e) => { building.ceiling.visible = (e.target as HTMLInputElement).checked; });
  const ceilingChk = $<HTMLInputElement>('t-ceiling');
  const beamsChk = $<HTMLInputElement>('t-beams');
  /** Beams hang over everything, so the top-down plan hides them. */
  const applyBeams = () => { building.beamGroup.visible = beamsChk.checked && rig.mode !== 'plan'; };
  beamsChk.addEventListener('change', applyBeams);

  // Selected beams get a yellow handle at each end. Dragging one resizes the beam; it snaps to a wall face.
  let handles: THREE.Mesh[] = [];
  const beamAxis = (angle: number) => ({ x: Math.cos((angle * Math.PI) / 180), y: Math.sin((angle * Math.PI) / 180) });
  function syncHandles() {
    for (const h of handles) { scene.remove(h); h.geometry.dispose(); (h.material as THREE.Material).dispose(); }
    handles = [];
    if (sel?.kind !== 'beam') return;
    const e = cfg.beams!.find((x) => x.id === sel!.id);
    const r = building.beams.find((x) => x.id === sel!.id);
    if (!e || !r || !building.beamGroup.visible) return;
    const u = beamAxis(e.angle);
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(8, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffc400, depthTest: false }));
      h.renderOrder = 12;
      h.position.set(r.center.x + (s * u.x * r.length) / 2, r.bottom + r.depth / 2, -(r.center.y + (s * u.y * r.length) / 2));
      h.userData.end = s;
      scene.add(h);
      handles.push(h);
    }
  }
  /** Distance from (x, y) along unit (dx, dy) to the nearest wall face, or null. */
  function distToWall(x: number, y: number, dx: number, dy: number): number | null {
    let best: number | null = null;
    for (const [x1, y1, x2, y2] of building.wallEdges) {
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((x1 - x) * ey - (y1 - y) * ex) / den;
      const k = ((x1 - x) * dy - (y1 - y) * dx) / den;
      if (t > 0.5 && k >= 0 && k <= 1 && (best === null || t < best)) best = t;
    }
    return best;
  }

  // ---------- Edits: persistence and rebuilds ----------
  const save = () => {
    edited = true;
    try {
      localStorage.setItem(STORE, JSON.stringify({ building: { ceilingHeight: cfg.ceilingHeight, openings: cfg.openings, soffits: cfg.soffits, walls: cfg.walls, wallSections: cfg.wallSections, customOpenings: cfg.customOpenings, beams: cfg.beams }, fixtures }));
    } catch { toast('Could not save in this browser. Use Export JSON to keep your edits.'); }
    $('edited').hidden = false;
  };
  $('edited').hidden = !edited;

  function rebuildBuilding() {
    scene.remove(building.group);
    disposeGroup(building.group);
    building = buildBuilding(cfg, dxf);
    building.ceiling.visible = ceilingChk.checked;
    applyBeams();
    scene.add(building.group);
    syncHandles();
    rig.setCollision(building.collision);
    building.highlight(sel && sel.kind !== 'fixture' ? sel : null);
  }
  function rebuildFixtures() {
    scene.remove(fx.group);
    disposeGroup(fx.group);
    fx = buildFixtures(fixtures, building.bounds);
    scene.add(fx.group);
    applyVisibility();
  }
  function refreshAll() {
    renderCats();
    renderItems();
    renderOpenItems();
    renderPanel();
  }

  // ---------- Selection ----------
  let sel: Sel = null;
  let selected: FixtureEntry | null = null;
  function select(next: Sel, keepForm = false) {
    if (selected) setSelected(selected, false);
    sel = next;
    selected = next?.kind === 'fixture' ? fx.entries.find((e) => e.data.id === next.id) ?? null : null;
    if (next?.kind === 'fixture' && !selected) sel = null;
    if (selected) setSelected(selected, true);
    building.highlight(next && next.kind !== 'fixture' ? next : null);
    syncHandles();
    if (keepForm) {
      if (selected) $('info-name').textContent = selected.data.name;
    } else renderPanel();
    renderItems();
  }

  const row = (label: string, control: string) => `<label>${label}</label>${control}`;
  const numIn = (f: string, v: number | null | undefined, ph = '') =>
    `<input type="number" step="any" data-f="${f}" value="${v == null ? '' : trim(v)}" placeholder="${ph || 'TBD'}">`;
  const textIn = (f: string, v: string) => `<input type="text" data-f="${f}" value="${attr(v)}">`;

  function renderPanel() {
    const panel = $('info');
    panel.hidden = !sel;
    if (!sel) return;
    const body = $('info-body');
    if (sel.kind === 'fixture') {
      const f = selected!.data;
      $('info-name').textContent = f.name;
      const opts = (list: string[], cur: string) => list.map((o) => `<option ${o === cur ? 'selected' : ''}>${o}</option>`).join('');
      body.innerHTML = [
        row('Label', textIn('name', f.name)),
        row('Category', `<select data-f="category">${opts(CATEGORIES, f.category)}</select>`),
        row('Phase', `<select data-f="phase">${opts(['opening', 'future'], f.phase ?? 'opening')}</select>`),
        row('Width in', numIn('width', f.width)),
        row('Depth in', numIn('depth', f.depth)),
        row('Height in', numIn('height', f.height)),
        row('Elevation', numIn('elevation', f.elevation === undefined ? 0 : f.elevation)),
        row('X (east)', numIn('x', f.x)),
        row('Y (north)', numIn('y', f.y)),
        row('Rotation °', numIn('rotation', f.rotation ?? 0, '0')),
        `<label class="full">Notes</label><textarea class="full" data-f="notes">${escapeHtml(f.notes ?? '')}</textarea>`,
        `<div class="note">Blank means TBD (shown with a stand-in size). Select, then drag the box on the floor to move it. Rotation is clockwise from north.</div>`,
        `<div class="actions"><button data-act="dup">Duplicate</button><button data-act="del" class="danger">Delete</button></div>`,
      ].join('');
      return;
    }
    if (sel.kind === 'ceiling') {
      $('info-name').textContent = 'Ceiling';
      body.innerHTML = [
        row('Height in', numIn('ceiling', cfg.ceilingHeight, `${building.ceilingHeight} (stand-in)`)),
        `<div class="note">Finished ceiling height. Walls without their own height rise to it and soffits hang from it.</div>`,
      ].join('');
      return;
    }
    if (sel.kind === 'wall') {
      const w = building.walls.find((x) => x.id === sel!.id);
      const e = cfg.walls!.find((x) => x.id === sel!.id);
      $('info-name').textContent = e?.label || w?.id.replace('wall-', 'Wall ') || 'Wall';
      body.innerHTML = [
        row('Label', textIn('label', e?.label ?? '')),
        row('Height in', numIn('wallHeight', e?.height, `${trim(building.ceilingHeight)} (ceiling)`)),
        `<div class="note">Blank follows the ceiling height. To change just part of a wall, use <b>Split wall</b> and click where the section starts and ends.</div>`,
      ].join('');
      return;
    }
    if (sel.kind === 'section') {
      const e = cfg.wallSections!.find((x) => x.id === sel!.id);
      if (!e) return;
      $('info-name').textContent = e.label || `Wall section ${e.id.replace('section-', '')}`;
      body.innerHTML = [
        row('Label', textIn('label', e.label ?? '')),
        row('Height in', numIn('sectionHeight', e.height)),
        row('Start X', numIn('ax', e.a.x)),
        row('Start Y', numIn('ay', e.a.y)),
        row('End X', numIn('bx', e.b.x)),
        row('End Y', numIn('by', e.b.y)),
        row('Cover in', numIn('sectionWidth', e.width)),
        `<div class="note">The section sets the height of any wall between its start and end points, as wide as "Cover" (centred on the line). Earlier sections win where they overlap.</div>`,
        `<div class="actions"><button data-act="del-section" class="danger">Delete section</button></div>`,
      ].join('');
      return;
    }
    if (sel.kind === 'opening') {
      const o = building.openings.find((x) => x.id === sel!.id);
      if (!o) {
        $('info-name').textContent = `Removed opening "${sel.id}"`;
        body.innerHTML = `<div class="note">This opening was removed. The wall is solid here.</div><div class="actions"><button data-act="restore">Restore</button></div>`;
        return;
      }
      const e = [...cfg.openings, ...cfg.customOpenings!].find((x) => x.id === sel!.id);
      $('info-name').textContent = o.label || `${o.kind === 'door' ? 'Door' : 'Window'} "${o.id}"`;
      const stand = (v: number) => `${trim(v)} (stand-in)`;
      body.innerHTML = [
        row('Label', textIn('label', o.label ?? '')),
        row('Type', o.custom
          ? `<select data-f="kind">${['door', 'window'].map((k) => `<option value="${k}" ${k === o.kind ? 'selected' : ''}>${k === 'door' ? 'door / doorway' : 'window'}</option>`).join('')}</select>`
          : `<input type="text" value="${o.kind === 'door' ? 'door / doorway' : 'window'}" disabled>`),
        row('Sill in', numIn('sill', e?.sill, stand(o.sill))),
        row('Head in', numIn('head', e?.head, stand(o.head))),
        row('Width in', numIn('width', o.width)),
        row('Cut depth', numIn('depth', o.depth)),
        row('Center X', numIn('cx', o.center.x)),
        row('Center Y', numIn('cy', o.center.y)),
        row('Angle °', numIn('angle', o.angle)),
        `<div class="note">Sill is the bottom of the opening, head the top, both from the floor. Width runs along Angle (0 = east-west, 90 = north-south). Cut depth is how far the opening cuts through the wall. Select it and drag to move; it snaps to the nearest wall.</div>`,
        `<div class="actions">${o.custom ? '<button data-act="dup-opening">Duplicate</button>' : ''}<button data-act="del-opening" class="danger">${o.custom ? 'Delete' : 'Remove'}</button></div>`,
      ].join('');
      return;
    }
    if (sel.kind === 'beam') {
      const e = cfg.beams!.find((x) => x.id === sel!.id);
      const r = building.beams.find((x) => x.id === sel!.id);
      if (!e || !r) return;
      $('info-name').textContent = e.label || `Beam "${e.id}"`;
      const stand = (v: number) => `${trim(v)} (stand-in)`;
      body.innerHTML = [
        row('Label', textIn('label', e.label ?? '')),
        row('Length in', numIn('blength', e.length, stand(r.length))),
        row('Width in', numIn('bwidth', e.width, stand(r.width))),
        row('Depth in', numIn('bdepth', e.depth, stand(r.depth))),
        row('Bottom in', numIn('bbottom', e.bottom, `${trim(r.bottom)} (flush to ceiling)`)),
        row('Center X', numIn('bx', e.x)),
        row('Center Y', numIn('by', e.y)),
        row('Angle °', numIn('bangle', e.angle)),
        `<label class="full">Notes</label><textarea class="full" data-f="bnotes">${escapeHtml(e.notes ?? '')}</textarea>`,
        `<div class="note">Length runs along Angle (0 = east-west, 90 = north-south). Width is across the beam, depth is how tall it is. Bottom is the underside above the floor; blank hangs the beam flush under the ceiling. Top is ${trim(r.top)} in. Select the beam, then drag it to move it, or drag a yellow end handle to resize it (ends snap to walls; hold <b>Alt</b> to ignore walls, <b>Shift</b> for 6 in steps).</div>`,
        `<div class="actions"><button data-act="beam-walls" title="Stretch both ends along the beam to the nearest wall faces">Extend to walls</button><button data-act="dup-beam">Duplicate</button><button data-act="del-beam" class="danger">Delete</button></div>`,
      ].join('');
      return;
    }
    const sf = building.soffits.find((x) => x.id === sel!.id);
    const se = cfg.soffits.find((x) => x.id === sel!.id);
    $('info-name').textContent = se?.label || `Soffit "${sel.id}"`;
    body.innerHTML = [
      row('Label', textIn('label', se?.label ?? '')),
      row('Bottom in', numIn('height', se?.height, sf ? `${trim(sf.height)} (stand-in)` : '')),
      `<div class="note">Height of the soffit's underside from the floor.</div>`,
    ].join('');
  }

  /** keepForm leaves the open form alone so a click into the next field is not lost to a re-render. */
  function commitFixtures(keepForm = false) {
    save();
    rebuildFixtures();
    select(sel, keepForm);
    renderCats();
    renderOpenItems();
    if (!keepForm) renderPanel();
  }
  function commitBuilding(keepForm = false) {
    save();
    rebuildBuilding();
    if (sel && sel.kind !== 'fixture') {
      const t = $('info-name');
      if (keepForm) t.textContent = itemName(sel);
    }
    renderItems();
    renderOpenItems();
    if (!keepForm) renderPanel();
  }

  $('info-body').addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const f = t.dataset.f;
    if (!f || !sel) return;
    const v = t.value;
    if (sel.kind === 'fixture') {
      const d = selected!.data;
      const n = num(v);
      switch (f) {
        case 'name': d.name = v.trim() || d.name; break;
        case 'category': d.category = v as Category; break;
        case 'phase': d.phase = v === 'future' ? 'future' : 'opening'; break;
        case 'width': case 'depth': case 'height': d[f] = n != null && n > 0 ? n : null; break;
        case 'elevation': case 'x': case 'y': d[f] = n; break;
        case 'rotation': d.rotation = n ?? 0; break;
        case 'notes': if (v.trim()) d.notes = v; else delete d.notes; break;
      }
      commitFixtures(true);
      return;
    }
    const n = num(v);
    const label = () => (v.trim() ? v.trim() : undefined);
    if (sel.kind === 'ceiling') {
      cfg.ceilingHeight = n != null && n >= 12 ? n : null;
    } else if (sel.kind === 'wall') {
      let e = cfg.walls!.find((x) => x.id === sel!.id);
      if (!e) cfg.walls!.push((e = { id: sel.id, height: null }));
      if (f === 'label') e.label = label();
      else e.height = n != null && n >= 0 ? n : null;
      if (e.label === undefined) delete e.label;
    } else if (sel.kind === 'section') {
      const e = cfg.wallSections!.find((x) => x.id === sel!.id);
      if (!e) return;
      if (f === 'label') { e.label = label(); if (e.label === undefined) delete e.label; }
      else if (n != null) {
        if (f === 'sectionHeight') e.height = Math.max(0, n);
        else if (f === 'sectionWidth') e.width = Math.max(1, n);
        else if (f === 'ax') e.a.x = n;
        else if (f === 'ay') e.a.y = n;
        else if (f === 'bx') e.b.x = n;
        else if (f === 'by') e.b.y = n;
      }
    } else if (sel.kind === 'beam') {
      const e = cfg.beams!.find((x) => x.id === sel!.id);
      if (!e) return;
      if (f === 'label') { e.label = label(); if (e.label === undefined) delete e.label; }
      else if (f === 'bnotes') { if (v.trim()) e.notes = v; else delete e.notes; }
      else if (f === 'blength' || f === 'bwidth' || f === 'bdepth') e[{ blength: 'length', bwidth: 'width', bdepth: 'depth' }[f] as 'length'] = n != null && n > 0 ? n : null;
      else if (f === 'bbottom') e.bottom = n != null && n >= 0 ? n : null;
      else if (n != null) {
        if (f === 'bx') e.x = n;
        else if (f === 'by') e.y = n;
        else if (f === 'bangle') e.angle = n;
      }
    } else if (sel.kind === 'opening') {
      const custom = cfg.customOpenings!.find((x) => x.id === sel!.id);
      const e = openingEntry(sel.id);
      if (f === 'label') { if (label()) e.label = label(); else delete e.label; }
      else if (f === 'kind' && custom) custom.kind = v === 'window' ? 'window' : 'door';
      else if (f === 'sill' || f === 'head') e[f] = custom ? n ?? e[f] : n;
      else if (n != null) {
        if (f === 'width' || f === 'depth') e[f] = Math.max(1, n);
        else if (f === 'cx') e.x = n;
        else if (f === 'cy') e.y = n;
        else if (f === 'angle') e.angle = n;
      }
    } else {
      let e = cfg.soffits.find((x) => x.id === sel!.id);
      if (!e) cfg.soffits.push((e = { id: sel.id, height: null }));
      if (f === 'label') { e.label = label(); if (e.label === undefined) delete e.label; }
      else if (f === 'height') e.height = n;
    }
    commitBuilding(true);
  });

  $('info-body').addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).dataset.act;
    if (act && sel && sel.kind !== 'fixture') {
      buildingAction(act, sel);
      return;
    }
    if (!act || !selected) return;
    const d = selected.data;
    if (act === 'del') {
      if (!confirm(`Delete "${d.name}"?`)) return;
      fixtures = fixtures.filter((x) => x !== d);
      sel = null;
      commitFixtures();
    } else if (act === 'dup') {
      let id = `${d.id}-copy`;
      for (let i = 2; fixtures.some((x) => x.id === id); i++) id = `${d.id}-copy${i}`;
      const copy: Fixture = { ...structuredClone(d), id, name: `${d.name} copy` };
      if (copy.x != null && copy.y != null) { copy.x += 12; copy.y -= 12; }
      fixtures.push(copy);
      sel = { kind: 'fixture', id };
      commitFixtures();
    }
  });
  function buildingAction(act: string, ref: BuildingItemRef) {
    if (act === 'del-section') {
      cfg.wallSections = cfg.wallSections!.filter((x) => x.id !== ref.id);
      sel = null;
    } else if (act === 'del-opening') {
      const custom = cfg.customOpenings!.some((x) => x.id === ref.id);
      if (custom) {
        if (!confirm('Delete this opening?')) return;
        cfg.customOpenings = cfg.customOpenings!.filter((x) => x.id !== ref.id);
        sel = null;
      } else {
        let e = cfg.openings.find((x) => x.id === ref.id);
        if (!e) cfg.openings.push((e = { id: ref.id, sill: null, head: null }));
        e.deleted = true;
        toast('Opening removed. Pick it in the Items list to restore it.');
        sel = { kind: 'opening', id: ref.id };
      }
    } else if (act === 'del-beam') {
      if (!confirm('Delete this beam?')) return;
      cfg.beams = cfg.beams!.filter((x) => x.id !== ref.id);
      sel = null;
    } else if (act === 'beam-walls') {
      const b = cfg.beams!.find((x) => x.id === ref.id);
      if (!b) return;
      const u = beamAxis(b.angle);
      const fwd = distToWall(b.x, b.y, u.x, u.y);
      const back = distToWall(b.x, b.y, -u.x, -u.y);
      if (fwd == null || back == null) { toast('No wall found at both ends along this beam.'); return; }
      b.length = Math.round(fwd + back);
      const mid = (fwd - back) / 2;
      b.x = Math.round((b.x + u.x * mid) * 10) / 10;
      b.y = Math.round((b.y + u.y * mid) * 10) / 10;
    } else if (act === 'dup-beam') {
      const b = cfg.beams!.find((x) => x.id === ref.id);
      if (!b) return;
      const id = nextId('beam', cfg.beams!);
      // Cross beams repeat across the room: step the copy sideways, 24 in on centre.
      const a = (b.angle * Math.PI) / 180;
      const copy = { ...structuredClone(b), id, x: Math.round(b.x - Math.sin(a) * 24), y: Math.round(b.y + Math.cos(a) * 24) };
      delete copy.label;
      cfg.beams!.push(copy);
      sel = { kind: 'beam', id };
    } else if (act === 'restore') {
      const e = cfg.openings.find((x) => x.id === ref.id);
      if (e) delete e.deleted;
    } else if (act === 'dup-opening') {
      const o = cfg.customOpenings!.find((x) => x.id === ref.id);
      if (!o) return;
      const id = nextId('opening', cfg.customOpenings!);
      cfg.customOpenings!.push({ ...o, id, x: o.x + 24, y: o.y - 24 });
      sel = { kind: 'opening', id };
    } else return;
    commitBuilding();
  }
  /** The settings object for an opening: the custom one, or the override for a DXF one (created on demand). */
  function openingEntry(id: string): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const custom = cfg.customOpenings!.find((x) => x.id === id);
    if (custom) return custom;
    let e = cfg.openings.find((x) => x.id === id);
    if (!e) cfg.openings.push((e = { id, sill: null, head: null }));
    return e;
  }
  const nextId = (prefix: string, list: { id: string }[]) => {
    let n = 1;
    while (list.some((x) => x.id === `${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  };
  $('info-close').addEventListener('click', () => select(null));

  addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      e.preventDefault();
      $('info-body').querySelector<HTMLButtonElement>('[data-act="del"]')?.click();
    }
  });

  // ---------- Add / export / reset ----------
  $('add-item').addEventListener('click', () => {
    const { x, y } = floorPointAtCentre();
    let n = 1;
    while (fixtures.some((f) => f.id === `item-${n}`)) n++;
    fixtures.push({ id: `item-${n}`, name: 'New item', category: 'other', width: 24, depth: 24, height: 36, elevation: 0, x: Math.round(x), y: Math.round(y), rotation: 0, phase: 'opening' });
    sel = { kind: 'fixture', id: `item-${n}` };
    commitFixtures();
    toast('Added. Rename it in the panel, then drag it into place.');
  });

  /** Nearest wall face within reach of (x, y): where to put an opening and which way it runs. */
  function snapToWall(x: number, y: number, reach = 30): { x: number; y: number; angle: number } | null {
    let best: { d: number; x: number; y: number; angle: number } | null = null;
    for (const [x1, y1, x2, y2] of building.wallEdges) {
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
      const px = x1 + t * dx, py = y1 + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (d <= reach && (!best || d < best.d)) best = { d, x: px, y: py, angle: ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180 };
    }
    return best && { x: Math.round(best.x), y: Math.round(best.y), angle: Math.round(best.angle * 10) / 10 };
  }
  const floorPointAtCentre = () => {
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const p = new THREE.Vector3();
    const b = building.bounds;
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    return { x: Math.max(b.minX, Math.min(b.maxX, p.x)), y: Math.max(b.minY, Math.min(b.maxY, -p.z)) };
  };
  $('add-opening').addEventListener('click', () => {
    const c = floorPointAtCentre();
    const snap = snapToWall(c.x, c.y, 120);
    const id = nextId('opening', cfg.customOpenings!);
    cfg.customOpenings!.push({
      id, kind: 'door', x: snap?.x ?? Math.round(c.x), y: snap?.y ?? Math.round(c.y), width: 36, depth: cfg.openingDepth ?? DEFAULT_OPENING_DEPTH,
      angle: snap?.angle ?? 0, sill: 0, head: cfg.defaultDoorHeight,
    });
    sel = { kind: 'opening', id };
    commitBuilding();
    toast(snap ? 'Opening added on the nearest wall. Drag it along the wall, or change its type to window.' : 'Opening added, but no wall was close. Drag it onto a wall.');
  });
  $('add-beam').addEventListener('click', () => {
    const c = floorPointAtCentre();
    const id = nextId('beam', cfg.beams!);
    cfg.beams!.push({ id, x: Math.round(c.x), y: Math.round(c.y), length: DEFAULT_BEAM.length, width: DEFAULT_BEAM.width, depth: DEFAULT_BEAM.depth, bottom: null, angle: 0 });
    sel = { kind: 'beam', id };
    commitBuilding();
    toast('Beam added under the ceiling. Set its size, position and angle in the panel.');
  });
  let splitStart: Pt | null | 'armed' = null;
  $('split-wall').addEventListener('click', () => {
    measure.setActive(false);
    splitStart = splitStart ? null : 'armed';
    $('split-wall').classList.toggle('on', !!splitStart);
    if (splitStart) toast('Click where the wall section starts, then where it ends.');
  });

  function download(name: string, data: unknown) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('export').addEventListener('click', () => {
    download('fixtures.json', fixtures);
    download('building.json', cfg);
    toast('Downloaded fixtures.json and building.json. Replace the files in data/.');
  });
  $('reset').addEventListener('click', () => {
    if (!confirm('Discard all local edits and go back to the files in data/?')) return;
    try { localStorage.removeItem(STORE); } catch { /* ignore */ }
    location.reload();
  });

  // ---------- Items list ----------
  function focusItem(ref: Sel) {
    if (!ref) return;
    if (ref.kind === 'fixture') {
      const entry = fx.entries.find((e) => e.data.id === ref.id);
      if (!entry) return;
      if (!entry.group.visible) toast('That item is hidden by the filters.');
      rig.focusPoint({ x: entry.group.position.x, y: -entry.group.position.z, z: entry.elevation + entry.size.h / 2 });
    } else if (ref.kind === 'opening') {
      const o = building.openings.find((x) => x.id === ref.id);
      if (o) rig.focusPoint({ x: o.center.x, y: o.center.y, z: (o.sill + o.head) / 2 });
    } else if (ref.kind === 'soffit') {
      const o = building.soffits.find((x) => x.id === ref.id);
      if (o) rig.focusPoint({ x: o.center.x, y: o.center.y, z: o.height });
    } else if (ref.kind === 'beam') {
      const o = building.beams.find((x) => x.id === ref.id);
      if (o) rig.focusPoint({ x: o.center.x, y: o.center.y, z: o.bottom });
    } else if (ref.kind === 'wall') {
      const o = building.walls.find((x) => x.id === ref.id);
      if (o) rig.focusPoint({ x: o.center.x, y: o.center.y, z: o.height / 2 });
    } else if (ref.kind === 'section') {
      const o = building.sections.find((x) => x.id === ref.id);
      if (o) rig.focusPoint({ x: o.center.x, y: o.center.y, z: o.height / 2 });
    }
  }
  function itemName(ref: NonNullable<Sel>): string {
    if (ref.kind === 'fixture') return fixtures.find((f) => f.id === ref.id)?.name ?? ref.id;
    if (ref.kind === 'ceiling') return 'Ceiling';
    if (ref.kind === 'wall') return cfg.walls!.find((e) => e.id === ref.id)?.label || ref.id.replace('wall-', 'Wall ');
    if (ref.kind === 'section') return cfg.wallSections!.find((e) => e.id === ref.id)?.label || `Wall section ${ref.id.replace('section-', '')}`;
    if (ref.kind === 'opening') return [...cfg.openings, ...cfg.customOpenings!].find((e) => e.id === ref.id)?.label || ref.id;
    if (ref.kind === 'beam') return cfg.beams!.find((e) => e.id === ref.id)?.label || ref.id;
    return cfg.soffits.find((e) => e.id === ref.id)?.label || ref.id;
  }
  function renderItems() {
    const ul = $('items');
    ul.innerHTML = '';
    const add = (ref: NonNullable<Sel>, kind: string, extra = '') => {
      const li = document.createElement('li');
      const on = sel && sel.kind === ref.kind && sel.id === ref.id;
      li.className = on ? 'sel' : '';
      li.innerHTML = `<span>${escapeHtml(itemName(ref) + extra)}</span><small>${kind}</small>`;
      li.addEventListener('click', () => { select(ref); focusItem(ref); });
      ul.append(li);
    };
    add({ kind: 'ceiling', id: 'ceiling' }, 'building');
    for (const w of building.walls) add({ kind: 'wall', id: w.id }, `wall · ${trim(w.height)} in`);
    for (const x of building.sections) add({ kind: 'section', id: x.id }, `section · ${trim(x.height)} in`);
    for (const f of [...fixtures].sort((a, b) => a.name.localeCompare(b.name))) add({ kind: 'fixture', id: f.id }, f.category);
    for (const o of building.openings) add({ kind: 'opening', id: o.id }, o.kind);
    for (const id of building.removedOpenings) add({ kind: 'opening', id }, 'removed', ' (removed)');
    for (const o of building.soffits) add({ kind: 'soffit', id: o.id }, 'soffit');
    for (const o of building.beams) add({ kind: 'beam', id: o.id }, `beam · ${trim(o.bottom)} in`);
  }

  // ---------- Open items ----------
  const list = $('open-items');
  function renderOpenItems() {
    const openItems: OpenItem[] = [...building.openItems, ...fx.openItems];
    $('open-count').textContent = String(openItems.length);
    $('open-count').hidden = openItems.length === 0;
    list.innerHTML = '';
    if (!openItems.length) list.innerHTML = '<li>Nothing left to measure.</li>';
    for (const it of openItems) {
      const li = document.createElement('li');
      li.innerHTML = `${escapeHtml(it.label)}<small>needs ${it.missing.join(', ')}</small>`;
      li.addEventListener('click', () => {
        const ref: Sel = it.kind === 'fixture' ? { kind: 'fixture', id: it.id } : it.kind === 'building' ? { kind: 'ceiling', id: 'ceiling' } : { kind: it.kind, id: it.id };
        select(ref);
        focusItem(ref);
      });
      list.append(li);
    }
  }

  // ---------- Measure ----------
  const measureBtn = $('measure');
  const clearBtn = $('clear-measure');
  const measure = new MeasureTool(scene, (active, marks) => {
    measureBtn.classList.toggle('on', active);
    clearBtn.hidden = !marks;
    canvas.style.cursor = active ? 'crosshair' : rig.mode === 'walk' ? 'grab' : '';
  });
  measureBtn.addEventListener('click', () => {
    splitStart = null;
    $('split-wall').classList.remove('on');
    measure.setActive(!measure.active);
    if (measure.active) toast('Click two points on the floor, walls or equipment.');
  });
  clearBtn.addEventListener('click', () => measure.clear());
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { measure.setActive(false); select(null); } });

  // ---------- Click to inspect / measure ----------
  const ray = new THREE.Raycaster();
  const isShown = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const hit = ray.intersectObjects([...building.pickables, ...building.itemPickables, ...fx.entries.map((e) => e.mesh)], false).find((h) => isShown(h.object) && (!h.object.userData.proxy || (!measure.active && !splitStart)));
    if (splitStart && hit) {
      const pt = { x: Math.round(hit.point.x), y: Math.round(-hit.point.z) };
      if (splitStart === 'armed') {
        splitStart = pt;
        toast('Now click where it ends.');
        return;
      }
      const a = splitStart;
      const b = { ...pt };
      if (Math.abs(b.y - a.y) < Math.abs(b.x - a.x) * 0.1) b.y = a.y;
      else if (Math.abs(b.x - a.x) < Math.abs(b.y - a.y) * 0.1) b.x = a.x;
      splitStart = null;
      $('split-wall').classList.remove('on');
      if (Math.hypot(b.x - a.x, b.y - a.y) < 2) { toast('Those points are the same. Try again.'); return; }
      const under = hit.object.userData.item as BuildingItemRef | undefined;
      const base = under?.kind === 'wall' ? building.walls.find((w) => w.id === under.id)?.height : under?.kind === 'section' ? building.sections.find((w) => w.id === under.id)?.height : undefined;
      const id = nextId('section', cfg.wallSections!);
      cfg.wallSections!.push({ id, a, b, width: 16, height: base ?? building.ceilingHeight });
      sel = { kind: 'section', id };
      commitBuilding();
      toast('Section added. Set its height in the panel.');
      return;
    }
    if (measure.active) {
      if (!hit) return;
      const text = measure.addPoint(hit.point);
      if (text) toast(`Distance: ${text}`);
      return;
    }
    const entry = hit ? fx.entries.find((f) => f.mesh === hit.object) : undefined;
    const item = hit?.object.userData.item as BuildingItemRef | undefined;
    select(entry ? { kind: 'fixture', id: entry.data.id } : item ?? null);
  });

  // ---------- Drag the selected fixture to move it ----------
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = (e: PointerEvent) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  let drag: { entry: FixtureEntry; dx: number; dz: number; sx: number; sy: number; moved: boolean } | null = null;
  let odrag: { id: string; sx: number; sy: number; moved: boolean; ghost: THREE.Mesh; at?: { x: number; y: number; angle: number } } | null = null;
  let bdrag: { id: string; mode: 'move' | number; mesh: THREE.Mesh; dx: number; dz: number; sx: number; sy: number; moved: boolean; at?: { x: number; y: number; length?: number } } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || measure.active || splitStart || rig.mode === 'walk') return;
    if (sel?.kind === 'beam') {
      const r = building.beams.find((x) => x.id === sel!.id);
      const mesh = building.pickables.find((m) => m.userData.item?.kind === 'beam' && m.userData.item.id === sel!.id) as THREE.Mesh | undefined;
      if (!r || !mesh || !building.beamGroup.visible) return;
      ray.setFromCamera(ndc(e), camera);
      const hh = ray.intersectObjects(handles, false)[0];
      const hit = hh ?? ray.intersectObject(mesh, false)[0];
      if (!hit) return;
      const p = new THREE.Vector3();
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(r.bottom + r.depth / 2)), p)) return;
      bdrag = { id: r.id, mode: hh ? (hh.object.userData.end as number) : 'move', mesh, dx: mesh.position.x - p.x, dz: mesh.position.z - p.z, sx: e.clientX, sy: e.clientY, moved: false };
      rig.orbit.enabled = false;
      return;
    }
    if (sel?.kind === 'opening') {
      const o = building.openings.find((x) => x.id === sel!.id);
      ray.setFromCamera(ndc(e), camera);
      const px = building.itemPickables.find((m) => m.userData.item?.id === sel!.id);
      if (!o || !px || !ray.intersectObject(px, false).length) return;
      const ghost = new THREE.Mesh(
        new THREE.BoxGeometry(o.width, o.head - o.sill, o.depth),
        new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.35, depthTest: false }),
      );
      ghost.renderOrder = 11;
      ghost.position.copy(px.position);
      ghost.rotation.copy(px.rotation);
      scene.add(ghost);
      odrag = { id: o.id, sx: e.clientX, sy: e.clientY, moved: false, ghost };
      rig.orbit.enabled = false;
      return;
    }
    if (!selected || !selected.group.visible) return;
    ray.setFromCamera(ndc(e), camera);
    if (!ray.intersectObject(selected.mesh, false).length) return;
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(floorPlane, p)) return;
    drag = { entry: selected, dx: selected.group.position.x - p.x, dz: selected.group.position.z - p.z, sx: e.clientX, sy: e.clientY, moved: false };
    rig.orbit.enabled = false;
  }, true);
  addEventListener('pointermove', (e) => {
    if (bdrag) {
      if (!bdrag.moved && Math.hypot(e.clientX - bdrag.sx, e.clientY - bdrag.sy) < 4) return;
      const r = building.beams.find((x) => x.id === bdrag!.id);
      const cb = cfg.beams!.find((x) => x.id === bdrag!.id);
      if (!r || !cb) return;
      ray.setFromCamera(ndc(e), camera);
      const p = new THREE.Vector3();
      if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(r.bottom + r.depth / 2)), p)) return;
      bdrag.moved = true;
      const step = e.shiftKey ? 6 : 1;
      if (bdrag.mode === 'move') {
        const x = Math.round((p.x + bdrag.dx) / step) * step;
        const y = Math.round(-(p.z + bdrag.dz) / step) * step;
        bdrag.at = { x, y };
        bdrag.mesh.position.x = x;
        bdrag.mesh.position.z = -y;
      } else {
        const s = bdrag.mode;
        const u = beamAxis(cb.angle);
        const fx = r.center.x - s * u.x * r.length / 2, fy = r.center.y - s * u.y * r.length / 2;
        let L = Math.max(6, s * ((p.x - fx) * u.x + (-p.z - fy) * u.y));
        const wall = e.altKey ? null : distToWall(fx, fy, s * u.x, s * u.y);
        L = wall != null && Math.abs(L - wall) < 12 ? wall : Math.round(L / step) * step;
        const x = fx + s * u.x * L / 2, y = fy + s * u.y * L / 2;
        bdrag.at = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, length: Math.round(L * 10) / 10 };
        bdrag.mesh.scale.x = L / r.length;
        bdrag.mesh.position.x = x;
        bdrag.mesh.position.z = -y;
        handles.forEach((h) => { const hs = h.userData.end as number; h.position.x = fx + (hs === s ? s * u.x * L : 0); h.position.z = -(fy + (hs === s ? s * u.y * L : 0)); });
      }
      if (bdrag.mode === 'move') {
        const u = beamAxis(cb.angle);
        handles.forEach((h) => { const hs = h.userData.end as number; h.position.x = bdrag!.at!.x + hs * u.x * r.length / 2; h.position.z = -(bdrag!.at!.y + hs * u.y * r.length / 2); });
      }
      return;
    }
    if (odrag) {
      if (!odrag.moved && Math.hypot(e.clientX - odrag.sx, e.clientY - odrag.sy) < 4) return;
      ray.setFromCamera(ndc(e), camera);
      const p = new THREE.Vector3();
      if (!ray.ray.intersectPlane(floorPlane, p)) return;
      odrag.moved = true;
      const snap = e.altKey ? null : snapToWall(p.x, -p.z, 36);
      odrag.at = snap ?? { x: Math.round(p.x), y: Math.round(-p.z), angle: building.openings.find((x) => x.id === odrag!.id)!.angle };
      odrag.ghost.position.x = odrag.at.x;
      odrag.ghost.position.z = -odrag.at.y;
      odrag.ghost.rotation.y = (odrag.at.angle * Math.PI) / 180;
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    ray.setFromCamera(ndc(e), camera);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(floorPlane, p)) return;
    drag.moved = true;
    const step = e.shiftKey ? 6 : 1;
    drag.entry.group.position.x = Math.round((p.x + drag.dx) / step) * step;
    drag.entry.group.position.z = Math.round((p.z + drag.dz) / step) * step;
  });
  addEventListener('pointerup', () => {
    if (bdrag) {
      const { id, moved, at } = bdrag;
      bdrag = null;
      rig.orbit.enabled = rig.mode !== 'walk';
      const cb = cfg.beams!.find((x) => x.id === id);
      if (!moved || !at || !cb) return;
      cb.x = at.x; cb.y = at.y;
      if (at.length != null) cb.length = at.length;
      commitBuilding();
      return;
    }
    if (odrag) {
      const { id, moved, ghost, at } = odrag;
      odrag = null;
      scene.remove(ghost);
      ghost.geometry.dispose();
      rig.orbit.enabled = rig.mode !== 'walk';
      if (!moved || !at) return;
      const e = openingEntry(id);
      e.x = at.x; e.y = at.y; e.angle = at.angle;
      commitBuilding();
      return;
    }
    if (!drag) return;
    const { entry, moved } = drag;
    drag = null;
    rig.orbit.enabled = rig.mode !== 'walk';
    if (!moved) return;
    entry.data.x = Math.round(entry.group.position.x);
    entry.data.y = Math.round(-entry.group.position.z);
    commitFixtures();
  });

  // ---------- Modes and views ----------
  const modeBtns = document.querySelectorAll<HTMLButtonElement>('#modes button');
  rig.onModeChange = (m: Mode) => {
    modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    canvas.style.cursor = measure.active ? 'crosshair' : m === 'walk' ? 'grab' : '';
    applyBeams();
    renderHint(m);
  };
  modeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.mode as Mode;
      if (m === 'walk') rig.enterWalk();
      else if (m === 'plan') rig.plan();
      else rig.overview();
    }),
  );
  for (const v of views) {
    const b = document.createElement('button');
    b.textContent = v.name;
    b.addEventListener('click', () => rig.goTo(v));
    $('views').append(b);
  }

  // ---------- Hint ----------
  const hint = $('hint');
  function renderHint(m: Mode) {
    const body: Record<Mode, string> = {
      orbit: '<b>Drag</b> rotate · <b>Right-drag</b> pan · <b>Scroll</b> zoom<ul><li>Click anything to inspect and edit it</li><li>Drag a selected fixture to move it (hold <b>Shift</b> for 6 in steps)</li><li>Drag a selected beam to move it, or its yellow end handles to resize it (ends snap to walls)</li><li>Drag a selected window or door along a wall (hold <b>Alt</b> to ignore walls)</li><li>Try <i>Walk</i> to stand inside</li></ul>',
      walk: '<b>W A S D</b> or <b>↑ ↓</b> move · <b>Drag</b> look around<ul><li><b>← →</b> turn · hold <b>Shift</b> to hurry</li><li>Pick <i>Orbit</i> to fly back out</li></ul>',
      plan: '<b>Drag</b> pan · <b>Scroll</b> zoom<ul><li>North is up</li><li>Click equipment for details</li></ul>',
    };
    $('hint-body').innerHTML = body[m];
  }
  renderHint('orbit');
  $('hint-close').addEventListener('click', () => (hint.hidden = true));
  $('help').addEventListener('click', () => (hint.hidden = !hint.hidden));
  $('toggle-side').addEventListener('click', () => $('side').classList.toggle('open'));

  // ---------- Share link ----------
  const initial = decodePose(location.hash);
  if (initial) rig.goTo(initial, false);
  let lastHash = '';
  setInterval(() => {
    const h = encodePose(rig.pose());
    if (h !== lastHash) {
      lastHash = h;
      history.replaceState(null, '', h);
    }
  }, 600);
  $('copy-link').addEventListener('click', async () => {
    const url = location.origin + location.pathname + encodePose(rig.pose());
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. It opens to this exact view.');
    } catch {
      prompt('Copy this link:', url);
    }
  });

  // ---------- Loop ----------
  refreshAll();
  applyVisibility();
  let toastTimer = 0;
  function toast(msg: string) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
  }
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    rig.update(Math.min((now - last) / 1000, 0.1));
    last = now;
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  });

  // Handy for debugging in the console and for the headless smoke test.
  (window as unknown as Record<string, unknown>).__viewer = { rig, get building() { return building; }, get fx() { return fx; }, cfg, camera, scene, dxf };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
