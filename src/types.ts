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
    /** Layer of block inserts to show as draft equipment boxes. */
    equipment?: string;
  };
  /**
   * Overrides for openings found in the DXF. `at` (plan inches) names the opening nearest that point,
   * for drawings with no text labels. x/y/width/depth/angle move or resize it; `deleted` fills it in.
   */
  openings: (OpeningGeometry & { id: string; label?: string; sill: number | null; head: number | null; at?: Pt; deleted?: boolean })[];
  soffits: { id: string; label?: string; height: number | null }[];
  /** Per-wall overrides. Walls are the closed outlines on the walls layer, numbered wall-1, wall-2, ... */
  walls?: { id: string; label?: string; height: number | null }[];
  /** A stretch of wall (a to b, `width` across) with its own height. */
  wallSections?: { id: string; label?: string; a: Pt; b: Pt; width: number; height: number }[];
  /** Openings added in the viewer. Centre x/y, width along `angle`, depth through the wall. */
  /** Ceiling beams and joists. Each is a box: centre x/y, `length` along `angle`, `width` across, `depth` tall. */
  beams?: Beam[];
  customOpenings?: (Required<OpeningGeometry> & { id: string; kind: 'door' | 'window'; label?: string; sill: number; head: number })[];
}

export interface Beam {
  id: string;
  label?: string;
  /** Centre in plan inches. */
  x: number;
  y: number;
  /** Run of the beam, inches. null = TBD (drawn with a stand-in). */
  length: number | null;
  /** Across the beam, inches. */
  width: number | null;
  /** Vertical size of the beam, inches. */
  depth: number | null;
  /** Height of the underside above the floor. null = hangs flush under the ceiling (ceiling height minus depth). */
  bottom?: number | null;
  /** Degrees counter-clockwise from east: the direction `length` runs. 90 = north-south. */
  angle: number;
  notes?: string;
}

export interface OpeningGeometry {
  x?: number;
  y?: number;
  width?: number;
  depth?: number;
  /** Degrees counter-clockwise from east: the direction the opening's width runs. */
  angle?: number;
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
  kind: 'fixture' | 'opening' | 'soffit' | 'beam' | 'building';
  label: string;
  missing: string[];
}
