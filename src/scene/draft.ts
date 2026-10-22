import * as THREE from 'three';
import type { DxfEquipment } from '../dxf/parse';

/** Stand-in heights (inches) by AL block name. AL's DWG is plan-only, so these are guesses. */
const HEIGHTS: [RegExp, number][] = [
  [/pm933/i, 66],
  [/proof/i, 70],
  [/mixer/i, 48],
  [/metro_rack/i, 72],
  [/refrigerator/i, 36],
  [/table/i, 30],
  [/countertop/i, 36],
  [/kds/i, 18],
  [/point_of_sale/i, 6],
];

/** Draws AL's equipment inserts as flat-colored, see-through footprint boxes. Not pickable. */
export function buildDraftEquipment(items: DxfEquipment[]): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x8a6fd1, transparent: true, opacity: 0.45, depthWrite: false });
  const edge = new THREE.LineBasicMaterial({ color: 0x5b3fae });
  for (const it of items) {
    const h = HEIGHTS.find(([re]) => re.test(it.block))?.[1] ?? 36;
    const [a, b] = it.footprint;
    const geo = new THREE.BoxGeometry(it.width, h, it.depth);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge));
    // Box axes are (x, up, -y). Orient the local x axis along the footprint's first edge.
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    mesh.rotation.y = ang;
    mesh.position.set(it.center.x, h / 2, -it.center.y);
    group.add(mesh);
  }
  return group;
}
