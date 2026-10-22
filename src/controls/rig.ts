import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Bounds } from '../scene/building';
import type { Vec3 } from '../types';

export type Mode = 'orbit' | 'walk' | 'plan';

export const EYE_HEIGHT = 66;
const BODY_RADIUS = 10;
const WALK_SPEED = 66; // inches per second
const TURN_SPEED = 1.6; // radians per second with the arrow keys

export interface Pose {
  mode: 'orbit' | 'walk';
  eye: Vec3;
  target: Vec3;
}

/** Plan coordinates (x east, y north, z up) <-> three.js world (x east, y up, -z north). */
const toWorld = (p: Vec3) => new THREE.Vector3(p.x, p.z, -p.y);
const toPlan = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: -v.z, z: v.y });

function distToSegment(px: number, py: number, s: number[]): { d: number; nx: number; ny: number } {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ox = px - cx;
  const oy = py - cy;
  return { d: Math.hypot(ox, oy), nx: ox, ny: oy };
}

export class Rig {
  mode: Mode = 'orbit';
  readonly orbit: OrbitControls;
  private tween: { t: number; fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3 } | null = null;

  // Walk state. yaw is clockwise from north, in radians.
  private pos = { x: 0, y: 0 };
  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private dragging: { x: number; y: number } | null = null;
  private center: THREE.Vector3;
  private fitDist: number;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private bounds: Bounds,
    private collision: number[][],
  ) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.02;
    const w = bounds.maxX - bounds.minX;
    const d = bounds.maxY - bounds.minY;
    this.center = new THREE.Vector3(bounds.minX + w / 2, 0, -(bounds.minY + d / 2));
    const fovR = (camera.fov * Math.PI) / 180;
    this.fitDist = Math.max(w / camera.aspect, d, 1) / (2 * Math.tan(fovR / 2));
    this.orbit.minDistance = 24;
    this.orbit.maxDistance = this.fitDist * 4;

    dom.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (this.mode === 'walk' && ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    this.overview(false);
  }

  resize() {
    const fovR = (this.camera.fov * Math.PI) / 180;
    const w = this.bounds.maxX - this.bounds.minX;
    const d = this.bounds.maxY - this.bounds.minY;
    this.fitDist = Math.max(w / this.camera.aspect, d, 1) / (2 * Math.tan(fovR / 2));
  }

  // ---------- Orbit / plan ----------

  private flyOrbit(pos: THREE.Vector3, target: THREE.Vector3, animate: boolean) {
    this.setMode(this.mode === 'plan' ? 'plan' : 'orbit', false);
    if (!animate) {
      this.camera.position.copy(pos);
      this.orbit.target.copy(target);
      this.orbit.update();
      return;
    }
    this.tween = { t: 0, fromP: this.camera.position.clone(), toP: pos, fromT: this.orbit.target.clone(), toT: target };
  }

  overview(animate = true) {
    this.enterOrbit();
    const dir = new THREE.Vector3(0.35, 0.8, 0.55).normalize();
    this.flyOrbit(this.center.clone().addScaledVector(dir, this.fitDist * 1.05), this.center.clone(), animate);
  }

  plan(animate = true) {
    this.setMode('plan', true);
    const pos = this.center.clone().add(new THREE.Vector3(0, this.fitDist * 1.3, this.fitDist * 0.003));
    this.flyOrbit(pos, this.center.clone(), animate);
  }

  private enterOrbit() {
    if (this.mode === 'walk') this.setMode('orbit', true);
    else if (this.mode === 'plan') this.setMode('orbit', true);
  }

  private setMode(m: Mode, notify: boolean) {
    const prev = this.mode;
    this.mode = m;
    this.orbit.enabled = m !== 'walk';
    this.orbit.enableRotate = m !== 'plan';
    this.orbit.maxPolarAngle = m === 'plan' ? Math.PI / 2 : Math.PI / 2 - 0.02;
    this.dom.style.cursor = m === 'walk' ? 'grab' : '';
    if (notify && prev !== m) this.onModeChange?.(m);
  }
  onModeChange?: (m: Mode) => void;

  // ---------- Walk ----------

  enterWalk(eye?: Vec3, target?: Vec3) {
    this.tween = null;
    if (!eye) {
      // Start where the orbit camera was looking if that is inside the building, else the middle.
      const t = this.orbit.target;
      const inside = t.x > this.bounds.minX && t.x < this.bounds.maxX && -t.z > this.bounds.minY && -t.z < this.bounds.maxY;
      eye = inside ? { x: t.x, y: -t.z, z: EYE_HEIGHT } : { x: this.center.x, y: -this.center.z, z: EYE_HEIGHT };
      const south = { x: eye.x, y: eye.y + 100, z: EYE_HEIGHT - 6 };
      target = south;
    }
    this.pos = { x: eye.x, y: eye.y };
    const t = target ?? { x: eye.x, y: eye.y + 100, z: eye.z };
    const dx = t.x - eye.x;
    const dy = t.y - eye.y;
    this.yaw = Math.atan2(dx, dy);
    this.pitch = Math.atan2(t.z - eye.z, Math.hypot(dx, dy) || 1);
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch));
    this.setMode('walk', true);
    this.applyWalkCamera();
  }

  private applyWalkCamera() {
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(this.pos.x, EYE_HEIGHT, -this.pos.y);
    this.camera.rotation.set(this.pitch, -this.yaw, 0);
  }

  private onDown = (e: PointerEvent) => {
    if (this.mode !== 'walk') return;
    this.dragging = { x: e.clientX, y: e.clientY };
    this.dom.style.cursor = 'grabbing';
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging || this.mode !== 'walk') return;
    const dx = e.clientX - this.dragging.x;
    const dy = e.clientY - this.dragging.y;
    this.dragging = { x: e.clientX, y: e.clientY };
    this.yaw += dx * 0.004;
    this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * 0.004));
    this.applyWalkCamera();
  };
  private onUp = () => {
    this.dragging = null;
    if (this.mode === 'walk') this.dom.style.cursor = 'grab';
  };

  setCollision(collision: number[][]) {
    this.collision = collision;
  }

  private collides(x: number, y: number): boolean {
    for (const s of this.collision) {
      if (distToSegment(x, y, s).d < BODY_RADIUS) return true;
    }
    return false;
  }

  private tryMove(dx: number, dy: number) {
    // Axis-separated so you slide along walls instead of sticking to them.
    if (!this.collides(this.pos.x + dx, this.pos.y)) this.pos.x += dx;
    if (!this.collides(this.pos.x, this.pos.y + dy)) this.pos.y += dy;
  }

  // ---------- Per frame ----------

  update(dt: number) {
    if (this.mode === 'walk') {
      const k = this.keys;
      if (k.has('arrowleft')) this.yaw -= TURN_SPEED * dt;
      if (k.has('arrowright')) this.yaw += TURN_SPEED * dt;
      const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
      const side = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
      if (fwd || side || k.has('arrowleft') || k.has('arrowright')) {
        const step = WALK_SPEED * (k.has('shift') ? 2.2 : 1) * dt;
        const sy = Math.sin(this.yaw);
        const cy = Math.cos(this.yaw);
        // Forward is (sin yaw, cos yaw) in plan; right is (cos yaw, -sin yaw).
        const mx = (sy * fwd + cy * side) * step;
        const my = (cy * fwd - sy * side) * step;
        // Sub-step so a fast frame can't tunnel through a 6 inch wall.
        const n = Math.max(1, Math.ceil(Math.hypot(mx, my) / 4));
        for (let i = 0; i < n; i++) this.tryMove(mx / n, my / n);
        this.applyWalkCamera();
      }
      return;
    }
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / 0.7);
      const e = 1 - Math.pow(1 - this.tween.t, 3);
      this.camera.position.lerpVectors(this.tween.fromP, this.tween.toP, e);
      this.orbit.target.lerpVectors(this.tween.fromT, this.tween.toT, e);
      if (this.tween.t >= 1) this.tween = null;
    }
    this.orbit.update();
  }

  // ---------- Poses (for views and share links) ----------

  pose(): Pose {
    if (this.mode === 'walk') {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const eye = toPlan(this.camera.position);
      return { mode: 'walk', eye, target: toPlan(this.camera.position.clone().addScaledVector(dir, 100)) };
    }
    return { mode: 'orbit', eye: toPlan(this.camera.position), target: toPlan(this.orbit.target) };
  }

  goTo(p: { mode?: 'orbit' | 'walk'; eye: Vec3; target: Vec3 }, animate = true) {
    if (p.mode === 'walk') {
      this.enterWalk(p.eye, p.target);
    } else {
      if (this.mode !== 'orbit') this.setMode('orbit', true);
      this.flyOrbit(toWorld(p.eye), toWorld(p.target), animate);
    }
  }

  focusPoint(p: Vec3, distance = 140) {
    if (this.mode === 'walk') return;
    const target = toWorld(p);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (this.mode === 'plan') this.setMode('orbit', true);
    this.flyOrbit(target.clone().addScaledVector(dir, distance), target, true);
  }
}
