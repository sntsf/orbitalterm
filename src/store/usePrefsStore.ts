import { create } from "zustand";
import { useEffect, useState } from "react";

export type Theme =
  | "dark" | "light" | "nord" | "system"
  | "terminal" | "pastel-yellow" | "pastel-blue" | "pastel-pink";
export type FontSize = 12 | 13 | 15 | 18;

export const THEMES: { value: Theme; label: string; labelEs: string }[] = [
  { value: "system",        label: "System",        labelEs: "Sistema"          },
  { value: "dark",          label: "Dark",          labelEs: "Oscuro"           },
  { value: "light",         label: "Light",         labelEs: "Claro"            },
  { value: "nord",          label: "Nord",          labelEs: "Nord"             },
  { value: "terminal",      label: "Terminal",      labelEs: "Terminal"         },
  { value: "pastel-yellow", label: "Pastel Yellow", labelEs: "Amarillo pastel"  },
  { value: "pastel-blue",   label: "Pastel Blue",   labelEs: "Celeste pastel"   },
  { value: "pastel-pink",   label: "Pastel Pink",   labelEs: "Rosa pastel"      },
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
  // Green-phosphor look — everything reads like a classic terminal.
  terminal: {
    "--color-bg-base":      "#060a06",
    "--color-bg-surface":   "#0a0f0a",
    "--color-bg-elevated":  "#0e150e",
    "--color-bg-hover":     "#142016",
    "--color-border":       "#1d3a24",
    "--color-text-primary": "#4ade80",
    "--color-text-muted":   "#3f8f5c",
    "--color-accent":       "#22c55e",
    "--color-accent-hover": "#4ade80",
    "--color-success":      "#22c55e",
    "--color-warning":      "#d4d44a",
    "--color-danger":       "#ff5f56",
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
  terminal: {
    background: "#060a06", foreground: "#4ade80", cursor: "#22c55e",
    selectionBackground: "#22c55e44",
    black: "#0a0f0a",       red: "#ff6b6b",
    green: "#4ade80",       yellow: "#d4d44a",
    blue: "#4fd0e0",        magenta: "#c792ea",
    cyan: "#56d4dd",        white: "#b8e0c0",
    brightBlack: "#3f8f5c", brightRed: "#ff8b8b",
    brightGreen: "#86efac", brightYellow: "#eaea6a",
    brightBlue: "#7ee0ee",  brightMagenta: "#dab8f5",
    brightCyan: "#86e8ee",  brightWhite: "#e0ffe8",
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
  if (theme !== "system") return THEME_VARS[theme];
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return THEME_VARS[prefersDark ? "dark" : "light"];
}

/** Returns the resolved terminal theme, resolving "system". */
export function resolvedTermTheme(theme: Theme): object {
  if (theme !== "system") return TERM_THEMES[theme];
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
  const savedTheme = (localStorage.getItem("orbitalterm:theme") as Theme | null) ?? "system";
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
