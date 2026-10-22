export type Units = 'in' | 'ft' | 'mm' | 'cm' | 'm';

export interface BuildingConfig {
  units: Units;
  ceilingHeight: number | null;
  defaultWallThickness: number;
  defaultDoorHeight: number;
  /** How closed polylines on the walls layer are read. Default "outline". */
  closedPolylines?: 'outline' | 'centerline';
  /** Total width of the cut made through a wall by an opening, inches. Default 24. */
  openingDepth?: number;
  /** How far from an entity a label may be to name it, inches. Default 72. */
  labelSearchRadius?: number;
  layers: {
    walls: string;
    doors: string;
    windows: string;
    soffits: string;
    annotation?: string;
  };
  openings: { id: string; sill: number | null; head: number | null }[];
  soffits: { id: string; height: number | null }[];
}

export type Category =
  | 'equipment'
  | 'refrigeration'
  | 'sink'
  | 'storage'
  | 'seating'
  | 'counter'
  | 'hood'
  | 'other';

export interface Fixture {
  id: string;
  name: string;
  category: Category;
  width: number | null;
  depth: number | null;
  height: number | null;
  elevation?: number | null;
  x: number | null;
  y: number | null;
  rotation?: number;
  phase?: 'opening' | 'future';
  notes?: string;
}

export interface Pt {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ViewDef {
  id: string;
  name: string;
  mode?: 'orbit' | 'walk';
  eye: Vec3;
  target: Vec3;
}

export interface OpenItem {
  /** Fixture id, opening id, etc. Used to focus the item when clicked. */
  id: string;
  kind: 'fixture' | 'opening' | 'soffit' | 'building';
  label: string;
  missing: string[];
}
