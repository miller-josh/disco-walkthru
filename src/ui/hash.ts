import type { Pose } from '../controls/rig';
import type { Vec3 } from '../types';

const r = (v: number) => Math.round(v);
const enc = (v: Vec3) => `${r(v.x)},${r(v.y)},${r(v.z)}`;

/** #v=w|o;eyeX,eyeY,eyeZ;targetX,targetY,targetZ  (plan inches, z up) */
export function encodePose(p: Pose): string {
  return `#v=${p.mode === 'walk' ? 'w' : 'o'};${enc(p.eye)};${enc(p.target)}`;
}

export function decodePose(hash: string): Pose | null {
  const m = /^#v=([wo]);(-?\d+),(-?\d+),(-?\d+);(-?\d+),(-?\d+),(-?\d+)$/.exec(hash);
  if (!m) return null;
  const n = m.slice(2).map(Number);
  return {
    mode: m[1] === 'w' ? 'walk' : 'orbit',
    eye: { x: n[0], y: n[1], z: n[2] },
    target: { x: n[3], y: n[4], z: n[5] },
  };
}
