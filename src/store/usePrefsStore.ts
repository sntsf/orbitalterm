import { create } from "zustand";

export type Theme = "dark" | "light" | "nord" | "system";
export type FontSize = 12 | 13 | 15 | 18;

export const THEMES: { value: Theme; label: string; labelEs: string }[] = [
  { value: "system", label: "System", labelEs: "Sistema" },
  { value: "dark",   label: "Dark",   labelEs: "Oscuro"  },
  { value: "light",  label: "Light",  labelEs: "Claro"   },
  { value: "nord",   label: "Nord",   labelEs: "Nord"    },
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
  const savedTheme = (localStorage.getItem("orbitalterm:theme") as Theme | null) ?? "dark";
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
