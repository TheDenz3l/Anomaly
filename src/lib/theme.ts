/** Raw token values for places className can't reach (SVG, icons, native props). Mirrors src/global.css. */
export const colors = {
  background: "#000000",
  drawer: "#111113",
  surface: "#18181B",
  raised: "#27272A",
  raisedHigh: "#3F3F46",
  hairline: "rgba(39, 39, 42, 0.6)",
  primary: "#3B82F6",
  primarySoft: "rgba(59, 130, 246, 0.15)",
  primaryStrong: "#60A5FA",
  text: "#FAFAFA",
  textMuted: "#A1A1AA",
  textFaint: "#71717A",
  danger: "#DC4A44",
  success: "#17C964",
  warning: "#F5A524",
} as const;

export const fonts = {
  body: "Satoshi-Regular",
  medium: "Satoshi-Medium",
  bold: "Satoshi-Bold",
  italic: "Satoshi-Italic",
  display: "Moderniz",
} as const;

/** Deterministic hue from a string — used for generated posters, favicons and avatars (no network images in mock mode). */
export function hueFrom(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) % 360;
  return h;
}

export function hsl(h: number, s: number, l: number, a = 1): string {
  return `hsla(${Math.round(h)}, ${s}%, ${l}%, ${a})`;
}
