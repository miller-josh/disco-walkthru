import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import baseDxf from '../data/base.dxf?raw';
import buildingJson from '../data/building.json';
import fixturesJson from '../data/fixtures.json';
import viewsJson from '../data/views.json';
import './style.css';
import { parseDxf } from './dxf/parse';
import { buildBuilding } from './scene/building';
import { buildDraftEquipment } from './scene/draft';
import { buildFixtures, CATEGORIES, CATEGORY_COLORS, setSelected, type FixtureEntry } from './scene/fixtures';
import { Rig, type Mode } from './controls/rig';
import { MeasureTool } from './ui/measure';
import { decodePose, encodePose } from './ui/hash';
import { dims, trim } from './format';
import type { BuildingConfig, Category, Fixture, OpenItem, ViewDef } from './types';

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
  const cfg = buildingJson as unknown as BuildingConfig;
  const fixtures = fixturesJson as unknown as Fixture[];
  const views = viewsJson as unknown as ViewDef[];

  // ---------- Data -> scene ----------
  const dxf = parseDxf(baseDxf, cfg);
  const building = buildBuilding(cfg, dxf);
  const fx = buildFixtures(fixtures, building.bounds);
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
  const present = new Set(fx.entries.map((e) => e.group.userData.category as Category));
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
  for (const cat of CATEGORIES) {
    if (!present.has(cat)) continue;
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<input type="checkbox" checked><span class="swatch" style="background:#${CATEGORY_COLORS[cat].toString(16).padStart(6, '0')}"></span>${cat}`;
    row.querySelector('input')!.addEventListener('change', (ev) => {
      if ((ev.target as HTMLInputElement).checked) catOn.add(cat);
      else catOn.delete(cat);
      applyVisibility();
    });
    catBox.append(row);
  }
  $<HTMLInputElement>('t-future').addEventListener('change', (e) => { futureOn = (e.target as HTMLInputElement).checked; applyVisibility(); });
  $<HTMLInputElement>('t-labels').addEventListener('change', (e) => { labelsOn = (e.target as HTMLInputElement).checked; applyVisibility(); });
  $<HTMLInputElement>('t-draft').addEventListener('change', (e) => { draft.visible = (e.target as HTMLInputElement).checked; });
  $<HTMLInputElement>('t-ceiling').addEventListener('change', (e) => { building.ceiling.visible = (e.target as HTMLInputElement).checked; });

  // ---------- Selection panel ----------
  let selected: FixtureEntry | null = null;
  function select(entry: FixtureEntry | null) {
    if (selected) setSelected(selected, false);
    selected = entry;
    const panel = $('info');
    panel.hidden = !entry;
    if (!entry) return;
    setSelected(entry, true);
    const f = entry.data;
    const tbd = (v: number | null | undefined, unit = ' in') => (v == null ? `<span class="tbd">TBD</span>` : trim(v) + unit);
    $('info-name').textContent = f.name;
    const rows: [string, string][] = [
      ['Category', f.category],
      ['Phase', f.phase ?? 'opening'],
      ['W × D × H', f.width == null || f.depth == null || f.height == null ? `${dims(f.width, f.depth, f.height)} <span class="tbd">(showing a stand-in size)</span>` : dims(f.width, f.depth, f.height)],
      ['Elevation', tbd(f.elevation === undefined ? 0 : f.elevation)],
      ['Position', f.x == null || f.y == null ? `<span class="tbd">TBD</span>` : `${trim(f.x)}, ${trim(f.y)} in`],
      ['Rotation', `${f.rotation ?? 0}° clockwise from north`],
    ];
    if (f.notes) rows.push(['Notes', escapeHtml(f.notes)]);
    $('info-body').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
  $('info-close').addEventListener('click', () => select(null));

  // ---------- Open items ----------
  const openItems: OpenItem[] = [...building.openItems, ...fx.openItems];
  $('open-count').textContent = String(openItems.length);
  $('open-count').hidden = openItems.length === 0;
  const list = $('open-items');
  if (!openItems.length) list.innerHTML = '<li>Nothing left to measure.</li>';
  for (const it of openItems) {
    const li = document.createElement('li');
    li.innerHTML = `${escapeHtml(it.label)}<small>needs ${it.missing.join(', ')}</small>`;
    li.addEventListener('click', () => {
      const entry = fx.entries.find((e) => e.data.id === it.id);
      if (it.kind === 'fixture' && entry) {
        if (!entry.group.visible) toast('That item is hidden by the filters.');
        select(entry);
        rig.focusPoint({ x: entry.group.position.x, y: -entry.group.position.z, z: entry.elevation + entry.size.h / 2 });
      }
    });
    list.append(li);
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
  const fixtureMeshes = fx.entries.map((e) => e.mesh);
  const isShown = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const hit = ray.intersectObjects([...building.pickables, ...fixtureMeshes], false).find((h) => isShown(h.object));
    if (measure.active) {
      if (!hit) return;
      const text = measure.addPoint(hit.point);
      if (text) toast(`Distance: ${text}`);
      return;
    }
    const entry = hit ? fx.entries.find((f) => f.mesh === hit.object) : undefined;
    select(entry ?? null);
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
      orbit: '<b>Drag</b> rotate · <b>Right-drag</b> pan · <b>Scroll</b> zoom<ul><li>Click equipment for details</li><li>Try <i>Walk</i> to stand inside</li></ul>',
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
  (window as unknown as Record<string, unknown>).__viewer = { rig, building, fx, camera, scene, dxf };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
