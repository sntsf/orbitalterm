import { create } from "zustand";
import { useEffect, useState } from "react";

export type Theme =
  | "dark" | "light" | "nord" | "system"
  | "high-contrast" | "gray"
  | "magenta" | "cyan" | "ice" | "orange" | "yellow"
  | "pastel-yellow" | "pastel-blue" | "pastel-pink" | "pastel-orange";
export type FontSize = 12 | 13 | 15 | 18;

export const THEMES: { value: Theme; label: string; labelEs: string }[] = [
  { value: "system",        label: "System",         labelEs: "Sistema"          },
  { value: "dark",          label: "Dark",           labelEs: "Oscuro"           },
  { value: "light",         label: "Light",          labelEs: "Claro"            },
  { value: "nord",          label: "Nord",           labelEs: "Nord"             },
  { value: "high-contrast", label: "High Contrast",  labelEs: "Alto contraste"   },
  { value: "gray",          label: "Gray",           labelEs: "Gris"             },
  { value: "magenta",       label: "Magenta",        labelEs: "Magenta"          },
  { value: "cyan",          label: "Cyan",           labelEs: "Cian"             },
  { value: "ice",           label: "Ice",            labelEs: "Hielo"            },
  { value: "orange",        label: "Orange",         labelEs: "Naranja"          },
  { value: "yellow",        label: "Yellow",         labelEs: "Amarillo"         },
  { value: "pastel-yellow", label: "Pastel Yellow",  labelEs: "Amarillo pastel"  },
  { value: "pastel-orange", label: "Pastel Orange",  labelEs: "Naranja pastel"   },
  { value: "pastel-blue",   label: "Pastel Blue",    labelEs: "Celeste pastel"   },
  { value: "pastel-pink",   label: "Pastel Pink",    labelEs: "Rosa pastel"      },
];

export const FONT_SIZES: { value: FontSize; label: string }[] = [
  { value: 12, label: "Pequeño / Small (12px)"       },
  { value: 13, label: "Normal (13px)"                 },
  { value: 15, label: "Grande / Large (15px)"         },
  { value: 18, label: "Extra Grande / XL (18px)"      },
];

// CSS variable sets for each theme
const THEME_VARS: Record<Exclude<Theme, "system">, Record<string, string>> = {
  dark: {
    "--color-bg-base":      "#0f1117",
    "--color-bg-surface":   "#161b22",
    "--color-bg-elevated":  "#1c2330",
    "--color-bg-hover":     "#21262d",
    "--color-border":       "#30363d",
    "--color-text-primary": "#e6edf3",
    "--color-text-muted":   "#8b949e",
    "--color-accent":       "#388bfd",
    "--color-accent-hover": "#58a6ff",
    "--color-success":      "#3fb950",
    "--color-warning":      "#d29922",
    "--color-danger":       "#f85149",
    "color-scheme":         "dark",
  },
  light: {
    // Slightly tinted grey base instead of pure white — much easier on the eyes.
    // Elevated surfaces are white so dropdowns/cards pop against the grey base.
    "--color-bg-base":      "#eef0f4",
    "--color-bg-surface":   "#f5f7fa",
    "--color-bg-elevated":  "#ffffff",
    "--color-bg-hover":     "#e2e6ec",
    "--color-border":       "#c8cdd6",
    "--color-text-primary": "#111827",
    "--color-text-muted":   "#4b5563",
    "--color-accent":       "#0969da",
    "--color-accent-hover": "#0550ae",
    "--color-success":      "#16a34a",
    "--color-warning":      "#b45309",
    "--color-danger":       "#dc2626",
    "color-scheme":         "light",
  },
  nord: {
    // Deeper polar-night shades — less glare, more separation between layers.
    "--color-bg-base":      "#1e2430",
    "--color-bg-surface":   "#252b38",
    "--color-bg-elevated":  "#2e3440",
    "--color-bg-hover":     "#3b4252",
    "--color-border":       "#343d4f",
    "--color-text-primary": "#eceff4",
    "--color-text-muted":   "#7b92aa",
    "--color-accent":       "#5e81ac",
    "--color-accent-hover": "#81a1c1",
    "--color-success":      "#a3be8c",
    "--color-warning":      "#ebcb8b",
    "--color-danger":       "#bf616a",
    "color-scheme":         "dark",
  },
  // IntelliJ "High Contrast" — pure black, white text, vivid accents, bright
  // borders for maximum legibility.
  "high-contrast": {
    "--color-bg-base":      "#000000",
    "--color-bg-surface":   "#0a0a0a",
    "--color-bg-elevated":  "#141414",
    "--color-bg-hover":     "#2a2a2a",
    "--color-border":       "#6a6a6a",
    "--color-text-primary": "#ffffff",
    "--color-text-muted":   "#cfcfcf",
    "--color-accent":       "#1fd0ff",
    "--color-accent-hover": "#7fe6ff",
    "--color-success":      "#36ff5e",
    "--color-warning":      "#ffd633",
    "--color-danger":       "#ff4d4d",
    "color-scheme":         "dark",
  },
  // Synthwave magenta — dark plum base with hot-pink accents.
  magenta: {
    "--color-bg-base":      "#150b14",
    "--color-bg-surface":   "#1e0f1a",
    "--color-bg-elevated":  "#281422",
    "--color-bg-hover":     "#341a2c",
    "--color-border":       "#4a2540",
    "--color-text-primary": "#fce4f1",
    "--color-text-muted":   "#c98bb0",
    "--color-accent":       "#ff2d8a",
    "--color-accent-hover": "#ff66ab",
    "--color-success":      "#2dd4a7",
    "--color-warning":      "#ffb340",
    "--color-danger":       "#ff4d6d",
    "color-scheme":         "dark",
  },
  // Vivid cyan on dark teal.
  cyan: {
    "--color-bg-base":      "#0a1417",
    "--color-bg-surface":   "#0e1c20",
    "--color-bg-elevated":  "#122529",
    "--color-bg-hover":     "#173138",
    "--color-border":       "#1f4650",
    "--color-text-primary": "#d6f6fb",
    "--color-text-muted":   "#79c2cf",
    "--color-accent":       "#14d3e8",
    "--color-accent-hover": "#5ee6f5",
    "--color-success":      "#2dd4a7",
    "--color-warning":      "#ffb340",
    "--color-danger":       "#ff4d6d",
    "color-scheme":         "dark",
  },
  // Bright ice-blue on cool dark.
  ice: {
    "--color-bg-base":      "#0a0f18",
    "--color-bg-surface":   "#0e1622",
    "--color-bg-elevated":  "#121d2e",
    "--color-bg-hover":     "#18283c",
    "--color-border":       "#213652",
    "--color-text-primary": "#e6f3ff",
    "--color-text-muted":   "#8fb6dc",
    "--color-accent":       "#5cb8ff",
    "--color-accent-hover": "#8fcfff",
    "--color-success":      "#2dd4a7",
    "--color-warning":      "#ffb340",
    "--color-danger":       "#ff4d6d",
    "color-scheme":         "dark",
  },
  // Vivid orange on dark warm.
  orange: {
    "--color-bg-base":      "#170d06",
    "--color-bg-surface":   "#1f130a",
    "--color-bg-elevated":  "#29190f",
    "--color-bg-hover":     "#352115",
    "--color-border":       "#4d2f19",
    "--color-text-primary": "#ffe8d4",
    "--color-text-muted":   "#d2a07c",
    "--color-accent":       "#ff7a1a",
    "--color-accent-hover": "#ff9d52",
    "--color-success":      "#2dd4a7",
    "--color-warning":      "#ffc233",
    "--color-danger":       "#ff4d6d",
    "color-scheme":         "dark",
  },
  // Vivid yellow on dark warm.
  yellow: {
    "--color-bg-base":      "#16140a",
    "--color-bg-surface":   "#1d1a0f",
    "--color-bg-elevated":  "#262213",
    "--color-bg-hover":     "#312b19",
    "--color-border":       "#463e22",
    "--color-text-primary": "#faf4d6",
    "--color-text-muted":   "#c8b876",
    "--color-accent":       "#ffd11a",
    "--color-accent-hover": "#ffe066",
    "--color-success":      "#2dd4a7",
    "--color-warning":      "#ff9a3d",
    "--color-danger":       "#ff4d6d",
    "color-scheme":         "dark",
  },
  // Neutral grayscale with strong layer contrast.
  gray: {
    "--color-bg-base":      "#0e0e10",
    "--color-bg-surface":   "#161618",
    "--color-bg-elevated":  "#1f1f22",
    "--color-bg-hover":     "#2a2a2e",
    "--color-border":       "#45454c",
    "--color-text-primary": "#f4f4f5",
    "--color-text-muted":   "#a1a1aa",
    "--color-accent":       "#6b7280",
    "--color-accent-hover": "#9ca3af",
    "--color-success":      "#4ade80",
    "--color-warning":      "#facc15",
    "--color-danger":       "#f87171",
    "color-scheme":         "dark",
  },
  "pastel-yellow": {
    "--color-bg-base":      "#fbf5e0",
    "--color-bg-surface":   "#fdf9ec",
    "--color-bg-elevated":  "#fffdf6",
    "--color-bg-hover":     "#f2e9cd",
    "--color-border":       "#e4d9b3",
    "--color-text-primary": "#574613",
    "--color-text-muted":   "#8a7635",
    "--color-accent":       "#ca8a04",
    "--color-accent-hover": "#a16207",
    "--color-success":      "#16a34a",
    "--color-warning":      "#b45309",
    "--color-danger":       "#dc2626",
    "color-scheme":         "light",
  },
  "pastel-orange": {
    "--color-bg-base":      "#fdeede",
    "--color-bg-surface":   "#fef5ec",
    "--color-bg-elevated":  "#fffdfa",
    "--color-bg-hover":     "#f7e2cd",
    "--color-border":       "#ecd2b6",
    "--color-text-primary": "#5a300f",
    "--color-text-muted":   "#8a5a30",
    "--color-accent":       "#ea7317",
    "--color-accent-hover": "#c2410c",
    "--color-success":      "#16a34a",
    "--color-warning":      "#b45309",
    "--color-danger":       "#dc2626",
    "color-scheme":         "light",
  },
  "pastel-blue": {
    "--color-bg-base":      "#e4f1fb",
    "--color-bg-surface":   "#eff8fd",
    "--color-bg-elevated":  "#ffffff",
    "--color-bg-hover":     "#d3e9f6",
    "--color-border":       "#b8d9ed",
    "--color-text-primary": "#0e3850",
    "--color-text-muted":   "#3d6e88",
    "--color-accent":       "#0284c7",
    "--color-accent-hover": "#0369a1",
    "--color-success":      "#0d9488",
    "--color-warning":      "#b45309",
    "--color-danger":       "#dc2626",
    "color-scheme":         "light",
  },
  "pastel-pink": {
    "--color-bg-base":      "#fceaf2",
    "--color-bg-surface":   "#fef3f8",
    "--color-bg-elevated":  "#ffffff",
    "--color-bg-hover":     "#f9dbe7",
    "--color-border":       "#f1c5d8",
    "--color-text-primary": "#591d39",
    "--color-text-muted":   "#8a4a64",
    "--color-accent":       "#db2777",
    "--color-accent-hover": "#be185d",
    "--color-success":      "#16a34a",
    "--color-warning":      "#b45309",
    "--color-danger":       "#dc2626",
    "color-scheme":         "light",
  },
};

// Terminal color palettes per theme
export const TERM_THEMES: Record<Exclude<Theme, "system">, object> = {
  dark: {
    background: "#0f1117", foreground: "#e6edf3", cursor: "#58a6ff",
    selectionBackground: "#388bfd44",
    black: "#0d1117",       red: "#f85149",
    green: "#3fb950",       yellow: "#d29922",
    blue: "#388bfd",        magenta: "#bc8cff",
    cyan: "#39c5cf",        white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ff7b72",
    brightGreen: "#56d364", brightYellow: "#e3b341",
    brightBlue: "#79c0ff",  brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",  brightWhite: "#f0f6fc",
  },
  light: {
    background: "#eef0f4", foreground: "#111827", cursor: "#0969da",
    selectionBackground: "#0969da33",
    black: "#1f2937",       red: "#dc2626",
    green: "#16a34a",       yellow: "#b45309",
    blue: "#0969da",        magenta: "#7c3aed",
    cyan: "#0891b2",        white: "#4b5563",
    brightBlack: "#6b7280", brightRed: "#b91c1c",
    brightGreen: "#15803d", brightYellow: "#92400e",
    brightBlue: "#0550ae",  brightMagenta: "#6d28d9",
    brightCyan: "#0e7490",  brightWhite: "#374151",
  },
  nord: {
    background: "#1e2430", foreground: "#d8dee9", cursor: "#88c0d0",
    selectionBackground: "#5e81ac44",
    black: "#2e3440",       red: "#bf616a",
    green: "#a3be8c",       yellow: "#ebcb8b",
    blue: "#5e81ac",        magenta: "#b48ead",
    cyan: "#88c0d0",        white: "#e5e9f0",
    brightBlack: "#3b4252", brightRed: "#bf616a",
    brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",  brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",  brightWhite: "#eceff4",
  },
  "high-contrast": {
    background: "#000000", foreground: "#ffffff", cursor: "#ffffff",
    selectionBackground: "#1fd0ff55",
    black: "#000000",       red: "#ff5f5f",
    green: "#36ff5e",       yellow: "#ffd633",
    blue: "#5f8cff",        magenta: "#ff5fff",
    cyan: "#1fd0ff",        white: "#ffffff",
    brightBlack: "#8a8a8a", brightRed: "#ff8a8a",
    brightGreen: "#7dff97", brightYellow: "#ffe770",
    brightBlue: "#9db8ff",  brightMagenta: "#ff8aff",
    brightCyan: "#7fe6ff",  brightWhite: "#ffffff",
  },
  magenta: {
    background: "#150b14", foreground: "#fce4f1", cursor: "#ff2d8a",
    selectionBackground: "#ff2d8a44",
    black: "#2a1626",       red: "#ff4d6d",
    green: "#2dd4a7",       yellow: "#ffb340",
    blue: "#8a6bff",        magenta: "#ff2d8a",
    cyan: "#3ad0d0",        white: "#e9c7da",
    brightBlack: "#6a4560", brightRed: "#ff7d95",
    brightGreen: "#5ee6c2", brightYellow: "#ffc873",
    brightBlue: "#ab92ff",  brightMagenta: "#ff66ab",
    brightCyan: "#6ee0e0",  brightWhite: "#ffe6f4",
  },
  cyan: {
    background: "#0a1417", foreground: "#d6f6fb", cursor: "#14d3e8",
    selectionBackground: "#14d3e844",
    black: "#102228",       red: "#ff4d6d",
    green: "#2dd4a7",       yellow: "#ffb340",
    blue: "#3aa0ff",        magenta: "#c792ea",
    cyan: "#14d3e8",        white: "#bfe9ef",
    brightBlack: "#3f6b73", brightRed: "#ff7d95",
    brightGreen: "#5ee6c2", brightYellow: "#ffc873",
    brightBlue: "#79c0ff",  brightMagenta: "#dab8f5",
    brightCyan: "#5ee6f5",  brightWhite: "#e6fbff",
  },
  ice: {
    background: "#0a0f18", foreground: "#e6f3ff", cursor: "#5cb8ff",
    selectionBackground: "#5cb8ff44",
    black: "#152133",       red: "#ff4d6d",
    green: "#2dd4a7",       yellow: "#ffb340",
    blue: "#5cb8ff",        magenta: "#a78bfa",
    cyan: "#38d0e8",        white: "#cfe4f7",
    brightBlack: "#3f5c7a", brightRed: "#ff7d95",
    brightGreen: "#5ee6c2", brightYellow: "#ffc873",
    brightBlue: "#8fcfff",  brightMagenta: "#c4b5fd",
    brightCyan: "#7fe6ff",  brightWhite: "#eaf5ff",
  },
  orange: {
    background: "#170d06", foreground: "#ffe8d4", cursor: "#ff7a1a",
    selectionBackground: "#ff7a1a44",
    black: "#2b1a0e",       red: "#ff4d6d",
    green: "#2dd4a7",       yellow: "#ffc233",
    blue: "#7aa2ff",        magenta: "#e08bf0",
    cyan: "#3ad0d0",        white: "#f0d2bc",
    brightBlack: "#6a472b", brightRed: "#ff7d95",
    brightGreen: "#5ee6c2", brightYellow: "#ffd766",
    brightBlue: "#a3bcff",  brightMagenta: "#f0a8ff",
    brightCyan: "#6ee0e0",  brightWhite: "#fff0e4",
  },
  yellow: {
    background: "#16140a", foreground: "#faf4d6", cursor: "#ffd11a",
    selectionBackground: "#ffd11a44",
    black: "#2b270f",       red: "#ff6d5a",
    green: "#7bd44a",       yellow: "#ffd11a",
    blue: "#7aa2ff",        magenta: "#e08bf0",
    cyan: "#3ad0d0",        white: "#ebe1b8",
    brightBlack: "#6a5f2b", brightRed: "#ff8f80",
    brightGreen: "#9fe66e", brightYellow: "#ffe066",
    brightBlue: "#a3bcff",  brightMagenta: "#f0a8ff",
    brightCyan: "#6ee0e0",  brightWhite: "#fffae4",
  },
  gray: {
    background: "#0e0e10", foreground: "#f4f4f5", cursor: "#d4d4d8",
    selectionBackground: "#71717a55",
    black: "#1f1f22",       red: "#f87171",
    green: "#4ade80",       yellow: "#facc15",
    blue: "#60a5fa",        magenta: "#c084fc",
    cyan: "#22d3ee",        white: "#d4d4d8",
    brightBlack: "#71717a", brightRed: "#fca5a5",
    brightGreen: "#86efac", brightYellow: "#fde047",
    brightBlue: "#93c5fd",  brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",  brightWhite: "#fafafa",
  },
  "pastel-yellow": {
    background: "#fdf9ec", foreground: "#574613", cursor: "#ca8a04",
    selectionBackground: "#ca8a0433",
    black: "#574613",       red: "#dc2626",
    green: "#16a34a",       yellow: "#a16207",
    blue: "#0969da",        magenta: "#7c3aed",
    cyan: "#0891b2",        white: "#8a7635",
    brightBlack: "#8a7635", brightRed: "#b91c1c",
    brightGreen: "#15803d", brightYellow: "#854d0e",
    brightBlue: "#0550ae",  brightMagenta: "#6d28d9",
    brightCyan: "#0e7490",  brightWhite: "#3f3410",
  },
  "pastel-orange": {
    background: "#fef5ec", foreground: "#5a300f", cursor: "#ea7317",
    selectionBackground: "#ea731733",
    black: "#5a300f",       red: "#dc2626",
    green: "#16a34a",       yellow: "#b45309",
    blue: "#0969da",        magenta: "#c2410c",
    cyan: "#0891b2",        white: "#8a5a30",
    brightBlack: "#8a5a30", brightRed: "#b91c1c",
    brightGreen: "#15803d", brightYellow: "#92400e",
    brightBlue: "#0550ae",  brightMagenta: "#9a3412",
    brightCyan: "#0e7490",  brightWhite: "#3a1f0a",
  },
  "pastel-blue": {
    background: "#eff8fd", foreground: "#0e3850", cursor: "#0284c7",
    selectionBackground: "#0284c733",
    black: "#0e3850",       red: "#dc2626",
    green: "#0d9488",       yellow: "#b45309",
    blue: "#0284c7",        magenta: "#7c3aed",
    cyan: "#0891b2",        white: "#3d6e88",
    brightBlack: "#3d6e88", brightRed: "#b91c1c",
    brightGreen: "#0f766e", brightYellow: "#92400e",
    brightBlue: "#0369a1",  brightMagenta: "#6d28d9",
    brightCyan: "#0e7490",  brightWhite: "#0a2a3c",
  },
  "pastel-pink": {
    background: "#fef3f8", foreground: "#591d39", cursor: "#db2777",
    selectionBackground: "#db277733",
    black: "#591d39",       red: "#dc2626",
    green: "#16a34a",       yellow: "#b45309",
    blue: "#0969da",        magenta: "#db2777",
    cyan: "#0891b2",        white: "#8a4a64",
    brightBlack: "#8a4a64", brightRed: "#b91c1c",
    brightGreen: "#15803d", brightYellow: "#92400e",
    brightBlue: "#0550ae",  brightMagenta: "#be185d",
    brightCyan: "#0e7490",  brightWhite: "#451530",
  },
};

/** Returns the actual vars to apply, resolving "system" to dark or light. */
function resolvedVars(theme: Theme): Record<string, string> {
  if (theme !== "system") return THEME_VARS[theme] ?? THEME_VARS.dark;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return THEME_VARS[prefersDark ? "dark" : "light"];
}

/** Returns the resolved terminal theme, resolving "system". */
export function resolvedTermTheme(theme: Theme): object {
  if (theme !== "system") return TERM_THEMES[theme] ?? TERM_THEMES.dark;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return TERM_THEMES[prefersDark ? "dark" : "light"];
}

function applyTheme(theme: Theme) {
  const vars = resolvedVars(theme);
  const root = document.documentElement;
  for (const [key, val] of Object.entries(vars)) {
    if (key === "color-scheme") {
      root.style.colorScheme = val;
    } else {
      root.style.setProperty(key, val);
    }
  }
}

interface PrefsStore {
  theme: Theme;
  fontSize: FontSize;
  setTheme: (t: Theme) => void;
  setFontSize: (s: FontSize) => void;
  resetLayout: () => void;
}

export const usePrefsStore = create<PrefsStore>((set) => {
  // No saved preference → follow the OS ("system"), so the app is born in the
  // operating system's light/dark mode.
  const rawTheme = localStorage.getItem("orbitalterm:theme") as Theme | null;
  // Validate against known themes so a stale value (e.g. a removed theme) safely
  // falls back to "system" instead of breaking.
  const savedTheme: Theme =
    rawTheme && (rawTheme === "system" || rawTheme in THEME_VARS) ? rawTheme : "system";
  const savedSize = Number(localStorage.getItem("orbitalterm:fontSize") ?? "13") as FontSize;

  applyTheme(savedTheme);

  // For "system" theme: re-apply whenever the OS preference changes.
  if (savedTheme === "system") {
    window.matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => applyTheme("system"));
  }

  return {
    theme: savedTheme,
    fontSize: savedSize,

    setTheme: (theme) => {
      localStorage.setItem("orbitalterm:theme", theme);
      applyTheme(theme);
      set({ theme });

      // Wire up (or remove) the OS-preference listener.
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      if (theme === "system") {
        mq.addEventListener("change", handler);
      } else {
        mq.removeEventListener("change", handler);
      }
    },

    setFontSize: (fontSize) => {
      localStorage.setItem("orbitalterm:fontSize", String(fontSize));
      set({ fontSize });
    },

    resetLayout: () => {
      localStorage.removeItem("orbitalterm:sidebarWidth");
      localStorage.removeItem("orbitalterm:panelHeight");
      window.dispatchEvent(new CustomEvent("orbitalterm:resetLayout"));
    },
  };
});

/**
 * True when the active theme renders on a light background, derived from each
 * theme's declared color-scheme ("light" and the pastel themes are light; dark,
 * nord and terminal are dark). Drives the light logo variants. Reacts to OS
 * preference changes while on "system".
 */
export function useIsLightTheme(): boolean {
  const theme = usePrefsStore((s) => s.theme);
  const [sysDark, setSysDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setSysDark(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);
  const resolved = theme === "system" ? (sysDark ? "dark" : "light") : theme;
  return THEME_VARS[resolved]["color-scheme"] === "light";
}
