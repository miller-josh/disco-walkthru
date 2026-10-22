import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { feetInches } from '../format';

/** Two-click distance tool. Points snap to whatever surface was clicked (floor, walls, fixtures). */
export class MeasureTool {
  active = false;
  private first: THREE.Vector3 | null = null;
  private readonly group = new THREE.Group();
  private preview: THREE.Group | null = null;

  constructor(scene: THREE.Scene, private onChange: (active: boolean, hasMarks: boolean) => void) {
    scene.add(this.group);
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) this.cancelPending();
    this.onChange(on, this.group.children.length > 0);
  }

  private cancelPending() {
    this.first = null;
    if (this.preview) {
      this.group.remove(this.preview);
      this.preview = null;
    }
  }

  clear() {
    this.cancelPending();
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
    }
    this.onChange(this.active, false);
  }

  private marker(p: THREE.Vector3, into: THREE.Object3D) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xd9534f, depthTest: false }),
    );
    m.position.copy(p);
    m.renderOrder = 10;
    into.add(m);
  }

  /** Feed a surface hit. Returns the text to show when a measurement completes. */
  addPoint(p: THREE.Vector3): string | null {
    if (!this.first) {
      this.first = p.clone();
      this.preview = new THREE.Group();
      this.marker(p, this.preview);
      this.group.add(this.preview);
      return null;
    }
    const a = this.first;
    this.cancelPending();
    const set = new THREE.Group();
    this.marker(a, set);
    this.marker(p, set);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, p]),
      new THREE.LineBasicMaterial({ color: 0xd9534f, depthTest: false }),
    );
    line.renderOrder = 9;
    set.add(line);
    const total = a.distanceTo(p);
    const el = document.createElement('div');
    el.className = 'measure-label';
    el.textContent = feetInches(total);
    const label = new CSS2DObject(el);
    label.position.copy(a).lerp(p, 0.5);
    set.add(label);
    this.group.add(set);
    this.onChange(this.active, true);
    const flat = Math.hypot(p.x - a.x, p.z - a.z);
    return Math.abs(flat - total) > 1 ? `${feetInches(total)} (floor distance ${feetInches(flat)})` : feetInches(total);
  }
}
