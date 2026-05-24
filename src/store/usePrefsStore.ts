import { create } from "zustand";

export type Theme = "dark" | "light" | "nord";
export type FontSize = 12 | 13 | 15 | 18;

export const THEMES: { value: Theme; label: string; labelEs: string }[] = [
  { value: "dark",  label: "Dark",  labelEs: "Oscuro" },
  { value: "light", label: "Light", labelEs: "Claro"  },
  { value: "nord",  label: "Nord",  labelEs: "Nord"   },
];

export const FONT_SIZES: { value: FontSize; label: string }[] = [
  { value: 12, label: "Pequeño / Small (12px)"       },
  { value: 13, label: "Normal (13px)"                 },
  { value: 15, label: "Grande / Large (15px)"         },
  { value: 18, label: "Extra Grande / XL (18px)"      },
];

// CSS variable sets for each theme
const THEME_VARS: Record<Theme, Record<string, string>> = {
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
    "--color-bg-base":      "#ffffff",
    "--color-bg-surface":   "#f6f8fa",
    "--color-bg-elevated":  "#eaeef2",
    "--color-bg-hover":     "#e0e6eb",
    "--color-border":       "#d0d7de",
    "--color-text-primary": "#1f2328",
    "--color-text-muted":   "#6e7781",
    "--color-accent":       "#0969da",
    "--color-accent-hover": "#0550ae",
    "--color-success":      "#1a7f37",
    "--color-warning":      "#9a6700",
    "--color-danger":       "#cf222e",
    "color-scheme":         "light",
  },
  nord: {
    "--color-bg-base":      "#2e3440",
    "--color-bg-surface":   "#3b4252",
    "--color-bg-elevated":  "#434c5e",
    "--color-bg-hover":     "#4c566a",
    "--color-border":       "#4c566a",
    "--color-text-primary": "#eceff4",
    "--color-text-muted":   "#81a1c1",
    "--color-accent":       "#88c0d0",
    "--color-accent-hover": "#8fbcbb",
    "--color-success":      "#a3be8c",
    "--color-warning":      "#ebcb8b",
    "--color-danger":       "#bf616a",
    "color-scheme":         "dark",
  },
};

// Terminal color palettes per theme
export const TERM_THEMES: Record<Theme, object> = {
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
    background: "#ffffff", foreground: "#1f2328", cursor: "#0969da",
    selectionBackground: "#0969da33",
    black: "#24292f",       red: "#cf222e",
    green: "#116329",       yellow: "#9a6700",
    blue: "#0969da",        magenta: "#8250df",
    cyan: "#1b7c83",        white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26",
    brightGreen: "#1a7f37", brightYellow: "#633c01",
    brightBlue: "#0550ae",  brightMagenta: "#6639ba",
    brightCyan: "#3192aa",  brightWhite: "#8c959f",
  },
  nord: {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0",
    selectionBackground: "#88c0d044",
    black: "#3b4252",       red: "#bf616a",
    green: "#a3be8c",       yellow: "#ebcb8b",
    blue: "#81a1c1",        magenta: "#b48ead",
    cyan: "#88c0d0",        white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a",
    brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",  brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",  brightWhite: "#eceff4",
  },
};

function applyTheme(theme: Theme) {
  const vars = THEME_VARS[theme];
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
  const savedTheme = (localStorage.getItem("orbitalterm:theme") as Theme | null) ?? "dark";
  const savedSize = Number(localStorage.getItem("orbitalterm:fontSize") ?? "13") as FontSize;

  // Apply saved theme immediately on store creation
  applyTheme(savedTheme);

  return {
    theme: savedTheme,
    fontSize: savedSize,

    setTheme: (theme) => {
      localStorage.setItem("orbitalterm:theme", theme);
      applyTheme(theme);
      set({ theme });
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
