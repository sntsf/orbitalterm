// Color palette for folder / connection-database icons. The icon shape stays
// the same (a folder, or a database) — only the tint changes, like mRemoteNG.
//
// NOTE: the `cls` values must be full literal Tailwind classes so the scanner
// keeps them in the build (never build them dynamically like `text-${c}-400`).

export interface IconColorDef {
  key: string;
  label_es: string;
  label_en: string;
  cls: string;
}

export const ICON_COLORS: IconColorDef[] = [
  { key: "amber",   label_es: "Ámbar",     label_en: "Amber",   cls: "text-amber-400" },
  { key: "yellow",  label_es: "Amarillo",  label_en: "Yellow",  cls: "text-yellow-400" },
  { key: "orange",  label_es: "Naranja",   label_en: "Orange",  cls: "text-orange-400" },
  { key: "red",     label_es: "Rojo",      label_en: "Red",     cls: "text-red-400" },
  { key: "pink",    label_es: "Rosa",      label_en: "Pink",    cls: "text-pink-400" },
  { key: "purple",  label_es: "Morado",    label_en: "Purple",  cls: "text-purple-400" },
  { key: "indigo",  label_es: "Índigo",    label_en: "Indigo",  cls: "text-indigo-400" },
  { key: "blue",    label_es: "Azul",      label_en: "Blue",    cls: "text-blue-400" },
  { key: "cyan",    label_es: "Cian",      label_en: "Cyan",    cls: "text-cyan-400" },
  { key: "green",   label_es: "Verde",     label_en: "Green",   cls: "text-green-400" },
  { key: "emerald", label_es: "Esmeralda", label_en: "Emerald", cls: "text-emerald-400" },
  { key: "slate",   label_es: "Gris",      label_en: "Gray",    cls: "text-slate-400" },
];

const BY_KEY = new Map(ICON_COLORS.map((c) => [c.key, c]));

/** Tailwind text-color class for a stored color key, with a sensible fallback. */
export function iconColorClass(color: string | undefined | null, fallback = "text-amber-400"): string {
  if (!color) return fallback;
  return BY_KEY.get(color)?.cls ?? fallback;
}
