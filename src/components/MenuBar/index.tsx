import { useEffect, useRef, useState } from "react";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Plus, FolderPlus, Upload, Download, LogOut,
  Globe, Info, Bug, Check, X, Maximize2, PanelLeftClose,
  Heart, RefreshCw, ExternalLink,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT, useI18nStore, LANGS } from "../../store/useI18nStore";
import {
  exportToFile, importFromFile, getConnections, getFolders,
} from "../../lib/commands";

// ── Types ─────────────────────────────────────────────────────────────────────

type MenuItemDef =
  | { separator: true }
  | {
      label: string;
      icon?: React.ReactNode;
      shortcut?: string;
      action?: () => void;
      checked?: boolean;
      disabled?: boolean;
    };

// ── MenuBar ───────────────────────────────────────────────────────────────────

export function MenuBar() {
  const t = useT();
  const { lang, setLang } = useI18nStore();
  const { startNewConnection, setConnections, setFolders, toggleSidebar, sidebarVisible } = useAppStore();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Sync initial fullscreen state
  useEffect(() => {
    getCurrentWindow().isFullscreen().then(setIsFullscreen).catch(() => {});
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    if (!openMenuId) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenuId(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [openMenuId]);

  // Keyboard shortcut: F11 → fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") { e.preventDefault(); handleFullscreen(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Auto-dismiss toast after 3 s
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const showToast = (msg: string, ok = true) => setToast({ msg, ok });

  const handleFullscreen = async () => {
    const next = !isFullscreen;
    await getCurrentWindow().setFullscreen(next);
    setIsFullscreen(next);
    setOpenMenuId(null);
  };

  const handleToggleSidebar = () => {
    toggleSidebar();
    setOpenMenuId(null);
  };

  const handleImport = async () => {
    setOpenMenuId(null);
    try {
      const path = await dialogOpen({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return;
      const count = await importFromFile(path);
      setConnections(await getConnections());
      setFolders(await getFolders());
      showToast(`${count} ${t("importedOk")}`);
    } catch (err) {
      showToast(String(err), false);
    }
  };

  const handleExport = async () => {
    setOpenMenuId(null);
    try {
      const path = await dialogSave({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "orbitalterm-connections.json",
      });
      if (!path) return;
      await exportToFile(path);
      showToast(t("exportedOk"));
    } catch (err) {
      showToast(String(err), false);
    }
  };

  const handleExit = () => {
    setOpenMenuId(null);
    getCurrentWindow().close();
  };

  const handleOpenUrl = (url: string) => {
    setOpenMenuId(null);
    shellOpen(url).catch(console.error);
  };

  const handleCheckUpdates = () => {
    setOpenMenuId(null);
    showToast(t("checkUpdatesMsg"));
    shellOpen("https://github.com/sntsf/orbitalterm/releases").catch(console.error);
  };

  // Menu definitions — rebuilt on every render so t() picks up lang changes
  const menus: { id: string; label: string; items: MenuItemDef[] }[] = [
    {
      id: "file",
      label: t("menuFile"),
      items: [
        {
          label: t("newConnection"),
          icon: <Plus size={12} />,
          shortcut: "Ctrl+N",
          action: () => { setOpenMenuId(null); startNewConnection(); },
        },
        {
          label: t("newFolder"),
          icon: <FolderPlus size={12} />,
          shortcut: "Ctrl+Shift+N",
          action: () => setOpenMenuId(null),
        },
        { separator: true },
        { label: t("importConnections"), icon: <Upload size={12} />, action: handleImport },
        { label: t("exportConnections"), icon: <Download size={12} />, action: handleExport },
        { separator: true },
        { label: t("exit"), icon: <LogOut size={12} />, shortcut: "Alt+F4", action: handleExit },
      ],
    },
    {
      id: "view",
      label: t("menuView"),
      items: [
        {
          label: t("showHideSidebar"),
          icon: <PanelLeftClose size={12} />,
          checked: sidebarVisible,
          action: handleToggleSidebar,
        },
        { separator: true },
        {
          label: t("fullscreen"),
          icon: <Maximize2 size={12} />,
          shortcut: "F11",
          checked: isFullscreen,
          action: handleFullscreen,
        },
      ],
    },
    {
      id: "tools",
      label: t("menuTools"),
      items: [
        { label: t("language"), icon: <Globe size={12} />, disabled: true },
        ...LANGS.map((l) => ({
          label: l.label,
          checked: lang === l.value,
          action: () => { setLang(l.value); setOpenMenuId(null); },
        })),
      ],
    },
    {
      id: "help",
      label: t("menuHelp"),
      items: [
        {
          label: t("about"),
          icon: <Info size={12} />,
          action: () => { setOpenMenuId(null); setShowAbout(true); },
        },
        { separator: true },
        {
          label: t("website"),
          icon: <ExternalLink size={12} />,
          action: () => handleOpenUrl("https://github.com/sntsf/orbitalterm"),
        },
        {
          label: t("donate"),
          icon: <Heart size={12} />,
          action: () => handleOpenUrl("https://github.com/sponsors/sntsf"),
        },
        { separator: true },
        {
          label: t("checkUpdates"),
          icon: <RefreshCw size={12} />,
          action: handleCheckUpdates,
        },
        {
          label: t("reportBug"),
          icon: <Bug size={12} />,
          action: () => handleOpenUrl("https://github.com/sntsf/orbitalterm/issues"),
        },
      ],
    },
  ];

  return (
    <>
      {/* Menu bar */}
      <div
        ref={barRef}
        className="flex items-center h-7 px-1 shrink-0 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] z-50 select-none"
      >
        {menus.map((menu) => (
          <div key={menu.id} className="relative">
            <button
              onMouseDown={() => setOpenMenuId(openMenuId === menu.id ? null : menu.id)}
              onMouseEnter={() => { if (openMenuId && openMenuId !== menu.id) setOpenMenuId(menu.id); }}
              className={[
                "px-2.5 py-0.5 text-xs rounded transition-colors",
                openMenuId === menu.id
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
              ].join(" ")}
            >
              {menu.label}
            </button>

            {openMenuId === menu.id && (
              <Dropdown items={menu.items} onClose={() => setOpenMenuId(null)} />
            )}
          </div>
        ))}

        {/* Toast notification */}
        {toast && (
          <div className={[
            "ml-auto mr-2 flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium",
            toast.ok
              ? "bg-[var(--color-success)]/15 text-[var(--color-success)]"
              : "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
          ].join(" ")}>
            {toast.ok ? <Check size={11} /> : <X size={11} />}
            {toast.msg}
          </div>
        )}
      </div>

      {/* About modal */}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
    </>
  );
}

// ── Dropdown ──────────────────────────────────────────────────────────────────

function Dropdown({ items, onClose }: { items: MenuItemDef[]; onClose: () => void }) {
  return (
    <div className="absolute top-full left-0 mt-0.5 min-w-[210px] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-xl z-50 py-1">
      {items.map((item, i) => {
        if ("separator" in item) {
          return <div key={i} className="my-1 border-t border-[var(--color-border)]" />;
        }
        const isHeader = item.disabled;
        return (
          <button
            key={i}
            onClick={item.action && !item.disabled ? () => { item.action!(); onClose(); } : undefined}
            disabled={item.disabled}
            className={[
              "flex items-center gap-2 w-full px-3 py-1 text-left text-xs transition-colors",
              isHeader
                ? "text-[var(--color-text-muted)] cursor-default font-semibold opacity-50"
                : item.action
                ? "hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] cursor-pointer"
                : "text-[var(--color-text-muted)] cursor-default",
            ].join(" ")}
          >
            {/* Check / icon column (fixed 16px width) */}
            <span className="w-4 shrink-0 flex items-center justify-center">
              {item.checked
                ? <Check size={11} className="text-[var(--color-accent)]" />
                : (item.icon ?? null)}
            </span>

            <span className="flex-1">{item.label}</span>

            {item.shortcut && (
              <span className="text-[10px] text-[var(--color-text-muted)] ml-4 shrink-0">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── About modal ───────────────────────────────────────────────────────────────

function AboutModal({ onClose }: { onClose: () => void }) {
  const t = useT();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-80 overflow-hidden">
        <div className="flex flex-col items-center gap-3 px-6 py-6 bg-[var(--color-bg-elevated)]">
          <img
            src="/logo.png"
            alt="OrbitalTerm"
            className="h-20 w-auto object-contain select-none"
            draggable={false}
          />
          <div className="text-center">
            <p className="text-sm font-semibold text-[var(--color-text-primary)]">OrbitalTerm</p>
            <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{t("version")} 0.1.0</p>
          </div>
        </div>

        <div className="px-6 py-4 space-y-2 text-center">
          <p className="text-xs text-[var(--color-text-muted)]">{t("aboutDesc")}</p>
          <p className="text-[10px] text-[var(--color-text-muted)] opacity-60">{t("developer")}</p>
        </div>

        <div className="px-6 pb-4 flex justify-center">
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
          >
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
