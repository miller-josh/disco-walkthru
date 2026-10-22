import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import baseDxf from '../data/base.dxf?raw';
import buildingJson from '../data/building.json';
import fixturesJson from '../data/fixtures.json';
import viewsJson from '../data/views.json';
import './style.css';
import { parseDxf } from './dxf/parse';
import { buildBuilding, type BuildingItemRef } from './scene/building';
import { buildDraftEquipment } from './scene/draft';
import { buildFixtures, CATEGORIES, CATEGORY_COLORS, setSelected, type FixtureEntry } from './scene/fixtures';
import { Rig, type Mode } from './controls/rig';
import { MeasureTool } from './ui/measure';
import { decodePose, encodePose } from './ui/hash';
import { trim } from './format';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { BuildingConfig, Category, Fixture, OpenItem, ViewDef } from './types';

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
  let edited = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (saved) {
      if (saved.building) {
        cfg.ceilingHeight = saved.building.ceilingHeight ?? null;
        cfg.openings = saved.building.openings ?? cfg.openings;
        cfg.soffits = saved.building.soffits ?? cfg.soffits;
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

  // ---------- Edits: persistence and rebuilds ----------
  const save = () => {
    edited = true;
    try {
      localStorage.setItem(STORE, JSON.stringify({ building: { ceilingHeight: cfg.ceilingHeight, openings: cfg.openings, soffits: cfg.soffits }, fixtures }));
    } catch { toast('Could not save in this browser. Use Export JSON to keep your edits.'); }
    $('edited').hidden = false;
  };
  $('edited').hidden = !edited;

  function rebuildBuilding() {
    scene.remove(building.group);
    disposeGroup(building.group);
    building = buildBuilding(cfg, dxf);
    building.ceiling.visible = ceilingChk.checked;
    scene.add(building.group);
    rig.setCollision(building.collision);
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
    if (sel.kind === 'wall') {
      $('info-name').textContent = 'Walls and ceiling';
      body.innerHTML = [
        row('Height in', numIn('ceiling', cfg.ceilingHeight, `${building.ceilingHeight} (stand-in)`)),
        `<div class="note">Finished ceiling height. Walls rise to it and soffits hang from it.</div>`,
      ].join('');
      return;
    }
    if (sel.kind === 'opening') {
      const o = building.openings.find((x) => x.id === sel!.id);
      const e = cfg.openings.find((x) => x.id === sel!.id);
      $('info-name').textContent = e?.label || `${o?.kind === 'door' ? 'Door' : 'Window'} "${sel.id}"`;
      body.innerHTML = [
        row('Label', textIn('label', e?.label ?? '')),
        row('Sill in', numIn('sill', e?.sill, o ? `${trim(o.sill)} (stand-in)` : '')),
        row('Head in', numIn('head', e?.head, o ? `${trim(o.head)} (stand-in)` : '')),
        `<div class="note">Sill is the bottom of the opening, head is the top, both from the floor.</div>`,
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
    if (sel.kind === 'wall') {
      const n = num(v);
      cfg.ceilingHeight = n != null && n >= 12 ? n : null;
    } else if (sel.kind === 'opening') {
      let e = cfg.openings.find((x) => x.id === sel!.id);
      if (!e) cfg.openings.push((e = { id: sel.id, sill: null, head: null }));
      if (f === 'label') { if (v.trim()) e.label = v.trim(); else delete e.label; }
      else if (f === 'sill' || f === 'head') e[f] = num(v);
    } else {
      let e = cfg.soffits.find((x) => x.id === sel!.id);
      if (!e) cfg.soffits.push((e = { id: sel.id, height: null }));
      if (f === 'label') { if (v.trim()) e.label = v.trim(); else delete e.label; }
      else if (f === 'height') e.height = num(v);
    }
    commitBuilding(true);
  });

  $('info-body').addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).dataset.act;
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
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const p = new THREE.Vector3();
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p);
    const b = building.bounds;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const x = hit ? clamp(p.x, b.minX, b.maxX) : (b.minX + b.maxX) / 2;
    const y = hit ? clamp(-p.z, b.minY, b.maxY) : (b.minY + b.maxY) / 2;
    let n = 1;
    while (fixtures.some((f) => f.id === `item-${n}`)) n++;
    fixtures.push({ id: `item-${n}`, name: 'New item', category: 'other', width: 24, depth: 24, height: 36, elevation: 0, x: Math.round(x), y: Math.round(y), rotation: 0, phase: 'opening' });
    sel = { kind: 'fixture', id: `item-${n}` };
    commitFixtures();
    toast('Added. Rename it in the panel, then drag it into place.');
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
    }
  }
  function renderItems() {
    const ul = $('items');
    ul.innerHTML = '';
    const add = (ref: NonNullable<Sel>, text: string, kind: string) => {
      const li = document.createElement('li');
      const on = sel && sel.kind === ref.kind && sel.id === ref.id;
      li.className = on ? 'sel' : '';
      li.innerHTML = `<span>${escapeHtml(text)}</span><small>${kind}</small>`;
      li.addEventListener('click', () => { select(ref); focusItem(ref); });
      ul.append(li);
    };
    add({ kind: 'wall', id: 'walls' }, 'Walls and ceiling', 'building');
    for (const f of [...fixtures].sort((a, b) => a.name.localeCompare(b.name))) add({ kind: 'fixture', id: f.id }, f.name, f.category);
    for (const o of building.openings) add({ kind: 'opening', id: o.id }, cfg.openings.find((e) => e.id === o.id)?.label || o.id, o.kind);
    for (const o of building.soffits) add({ kind: 'soffit', id: o.id }, cfg.soffits.find((e) => e.id === o.id)?.label || o.id, 'soffit');
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
        const ref: Sel = it.kind === 'fixture' ? { kind: 'fixture', id: it.id } : it.kind === 'building' ? { kind: 'wall', id: 'walls' } : { kind: it.kind, id: it.id };
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
    const hit = ray.intersectObjects([...building.pickables, ...fx.entries.map((e) => e.mesh)], false).find((h) => isShown(h.object));
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
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || measure.active || rig.mode === 'walk' || !selected || !selected.group.visible) return;
    ray.setFromCamera(ndc(e), camera);
    if (!ray.intersectObject(selected.mesh, false).length) return;
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(floorPlane, p)) return;
    drag = { entry: selected, dx: selected.group.position.x - p.x, dz: selected.group.position.z - p.z, sx: e.clientX, sy: e.clientY, moved: false };
    rig.orbit.enabled = false;
  }, true);
  addEventListener('pointermove', (e) => {
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
      orbit: '<b>Drag</b> rotate · <b>Right-drag</b> pan · <b>Scroll</b> zoom<ul><li>Click anything to inspect and edit it</li><li>Drag a selected fixture to move it (hold <b>Shift</b> for 6 in steps)</li><li>Try <i>Walk</i> to stand inside</li></ul>',
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
