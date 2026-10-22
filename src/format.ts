/** Inches to feet-inches, to the nearest half inch: 148.5 -> 12' 4 1/2" */
export function feetInches(inches: number): string {
  const sign = inches < 0 ? '-' : '';
  const halves = Math.round(Math.abs(inches) * 2);
  const feet = Math.floor(halves / 24);
  const rest = halves - feet * 24;
  const whole = Math.floor(rest / 2);
  const frac = rest % 2 ? ' 1/2' : '';
  return `${sign}${feet}' ${whole}${frac}"`;
}

export function dims(w: number | null, d: number | null, h: number | null): string {
  const f = (v: number | null) => (v == null ? '?' : `${trim(v)}`);
  return `${f(w)} × ${f(d)} × ${f(h)} in`;
}

export function trim(v: number): string {
  return String(Math.round(v * 100) / 100);
}
