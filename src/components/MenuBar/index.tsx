import { useEffect, useRef, useState, forwardRef } from "react";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  Plus, FolderPlus, Upload, Download, LogOut,
  Globe, Info, Bug, Check, X, Maximize2, PanelLeftClose,
  Heart, RefreshCw, ExternalLink, Palette, Type, RotateCcw, Database, KeyRound,
  ChevronRight,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT, useI18nStore, LANGS } from "../../store/useI18nStore";
import { usePrefsStore, useIsLightTheme, THEMES, FONT_SIZES } from "../../store/usePrefsStore";
import { useImportStore, type ImportProgress } from "../../store/useImportStore";
import {
  importFromFile, importFromMremoteng, getConnections, getFolders, getGroups, saveGroup,
  rdpWindowsSetMenuRegion,
} from "../../lib/commands";
import { ExportDialog } from "../ExportDialog";
import { MasterPasswordDialog } from "../MasterPasswordDialog";
import { useMasterStore } from "../../store/useMasterStore";
import { groupMasterStatus } from "../../lib/commands";


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
      submenu?: MenuItemDef[];
    };

// ── MenuBar ───────────────────────────────────────────────────────────────────

export function MenuBar() {
  const t = useT();
  const { lang, setLang } = useI18nStore();
  const { theme, fontSize, setTheme, setFontSize, resetLayout } = usePrefsStore();
  const { startNewConnection, setConnections, setFolders, groups, setGroups, toggleSidebar, sidebarVisible, tabs, activeTabId } = useAppStore();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showMasterHelp, setShowMasterHelp] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const { dialog: masterDialog, openDialog: openMasterDialog } = useMasterStore();
  const [masterStatuses, setMasterStatuses] = useState<Record<string, boolean>>({});

  // Per-data-source master-password status (refresh whenever the dialog closes).
  useEffect(() => {
    if (masterDialog) return;
    let cancelled = false;
    Promise.all(
      groups.map((g) =>
        groupMasterStatus(g.id).then((s) => [g.id, s] as const).catch(() => [g.id, false] as const)
      )
    ).then((entries) => { if (!cancelled) setMasterStatuses(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [masterDialog, groups]);
  const barRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Sync initial fullscreen state
  useEffect(() => {
    getCurrentWindow().isFullscreen().then(setIsFullscreen).catch(() => {});
  }, []);

  // When a menu bar dropdown opens, carve a hole in the RDP WS_POPUP so the dropdown
  // shows through without blacking out the RDP.  When closed, restore the full region.
  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const sessionId = activeTab?.session_id;
    if (!sessionId) return;

    if (openMenuId !== null) {
      // Measure after the dropdown has rendered
      requestAnimationFrame(() => {
        const el = dropdownRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        rdpWindowsSetMenuRegion(sessionId, [
          Math.floor(r.left), Math.floor(r.top),
          Math.ceil(r.width), Math.ceil(r.height),
        ]).catch(() => {});
      });
    } else {
      rdpWindowsSetMenuRegion(sessionId, null).catch(() => {});
    }
  }, [openMenuId, tabs, activeTabId]);

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

  const refreshAfterImport = async () => {
    setConnections(await getConnections());
    setFolders(await getFolders());
    setGroups(await getGroups());
  };

  // OrbitalTerm-native import (.json)
  const handleImport = async () => {
    setOpenMenuId(null);
    try {
      const path = await dialogOpen({
        multiple: false,
        filters: [{ name: "OrbitalTerm", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return;
      const count = await importFromFile(path);
      await refreshAfterImport();
      showToast(`${count} ${t("importedOk")}`);
    } catch (err) {
      showToast(String(err), false);
    }
  };

  // mRemoteNG migration import (.xml). Runs on a background thread in Rust and
  // reports progress via events, so the app (and any live RDP session) stays
  // responsive even for files with thousands of connections.
  const handleImportMremoteng = async () => {
    setOpenMenuId(null);
    if (useImportStore.getState().progress) {
      showToast(t("importInProgress"), false);
      return;
    }
    try {
      const path = await dialogOpen({
        multiple: false,
        filters: [{ name: "mRemoteNG", extensions: ["xml"] }],
      });
      if (!path || typeof path !== "string") return;

      const setProgress = useImportStore.getState().setProgress;
      const fileName = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "mRemoteNG";
      setProgress({ name: fileName, done: 0, total: 0 });

      const unlisten: Array<() => void> = [];
      const cleanup = () => unlisten.forEach((u) => u());

      unlisten.push(await listen<ImportProgress>("mrng-import-progress", (e) => {
        setProgress(e.payload);
      }));
      unlisten.push(await listen<number>("mrng-import-done", async (e) => {
        cleanup();
        await refreshAfterImport();
        setProgress(null);
        showToast(`${e.payload} ${t("importedOk")}`);
      }));
      unlisten.push(await listen<string>("mrng-import-error", (e) => {
        cleanup();
        setProgress(null);
        showToast(String(e.payload), false);
      }));

      await importFromMremoteng(path);
    } catch (err) {
      useImportStore.getState().setProgress(null);
      showToast(String(err), false);
    }
  };

  // Let other screens (e.g. the Welcome panel) trigger the same import flows
  // without duplicating the dialog + progress-event wiring. A ref keeps the
  // listeners pointed at the latest handlers without re-registering each render.
  const importHandlers = useRef({ handleImport, handleImportMremoteng });
  importHandlers.current = { handleImport, handleImportMremoteng };
  useEffect(() => {
    const onJson = () => importHandlers.current.handleImport();
    const onMrng = () => importHandlers.current.handleImportMremoteng();
    window.addEventListener("orbitalterm:importJson", onJson);
    window.addEventListener("orbitalterm:importMremoteng", onMrng);
    return () => {
      window.removeEventListener("orbitalterm:importJson", onJson);
      window.removeEventListener("orbitalterm:importMremoteng", onMrng);
    };
  }, []);

  const handleExport = () => {
    setOpenMenuId(null);
    setShowExport(true);
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

  const handleNewDataSource = () => {
    setOpenMenuId(null);
    setNewGroupName("");
    setShowNewGroup(true);
  };

  const confirmNewDataSource = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await saveGroup(name);
      setGroups(await getGroups());
      showToast(`"${name}" creado.`);
    } catch (err) {
      showToast(String(err), false);
    } finally {
      setShowNewGroup(false);
      setNewGroupName("");
    }
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
        {
          label: t("newDataSource"),
          icon: <Database size={12} />,
          action: handleNewDataSource,
        },
        { separator: true },
        { label: t("importConnections"), icon: <Upload size={12} />, action: handleImport },
        { label: t("importMremoteng"), icon: <Upload size={12} />, action: handleImportMremoteng },
        { label: t("exportConnections"), icon: <Download size={12} />, action: handleExport },
        { separator: true },
        ...groups.map((g) => ({
          label:
            (masterStatuses[g.id]
              ? (lang === "es" ? "Cambiar contraseña maestra · BD " : "Change master password · DB ")
              : (lang === "es" ? "Crear contraseña maestra · BD " : "Create master password · DB ")) +
            `"${g.name}"`,
          icon: <KeyRound size={12} />,
          action: () => {
            setOpenMenuId(null);
            openMasterDialog({
              mode: masterStatuses[g.id] ? "change" : "create",
              groupId: g.id,
              groupName: g.name,
            });
          },
        })),
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
        // Theme (flyout submenu)
        {
          label: t("theme"),
          icon: <Palette size={12} />,
          submenu: THEMES.map((th) => ({
            label: lang === "es" ? th.labelEs : th.label,
            checked: theme === th.value,
            action: () => { setTheme(th.value); setOpenMenuId(null); },
          })),
        },
        // Terminal font size (flyout submenu)
        {
          label: t("termFontSize"),
          icon: <Type size={12} />,
          submenu: FONT_SIZES.map((fs) => ({
            label: fs.label,
            checked: fontSize === fs.value,
            action: () => { setFontSize(fs.value); setOpenMenuId(null); },
          })),
        },
        // Language (flyout submenu)
        {
          label: t("language"),
          icon: <Globe size={12} />,
          submenu: LANGS.map((l) => ({
            label: l.label,
            checked: lang === l.value,
            action: () => { setLang(l.value); setOpenMenuId(null); },
          })),
        },
        { separator: true },
        // Reset layout
        {
          label: t("resetLayout"),
          icon: <RotateCcw size={12} />,
          action: () => { resetLayout(); setOpenMenuId(null); },
        },
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
        {
          label: lang === "es" ? "Olvidé mi contraseña maestra" : "I forgot my master password",
          icon: <KeyRound size={12} />,
          action: () => { setOpenMenuId(null); setShowMasterHelp(true); },
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
        className="flex items-center h-9 px-1 shrink-0 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] z-50 select-none"
      >
        {menus.map((menu) => (
          <div key={menu.id} className="relative">
            <button
              onMouseDown={() => setOpenMenuId(openMenuId === menu.id ? null : menu.id)}
              onMouseEnter={() => { if (openMenuId && openMenuId !== menu.id) setOpenMenuId(menu.id); }}
              className={[
                "px-3 py-1 text-[13px] rounded transition-colors",
                openMenuId === menu.id
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
              ].join(" ")}
            >
              {menu.label}
            </button>

            {openMenuId === menu.id && (
              <Dropdown ref={dropdownRef} items={menu.items} onClose={() => setOpenMenuId(null)} />
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

      {/* Master password recovery help */}
      {showMasterHelp && <MasterHelpModal es={lang === "es"} onClose={() => setShowMasterHelp(false)} />}

      {/* Export dialog */}
      {showExport && (
        <ExportDialog
          onClose={() => setShowExport(false)}
          onDone={(msg, ok) => showToast(msg, ok)}
        />
      )}

      <MasterPasswordDialog />

      {/* New data source dialog */}
      {showNewGroup && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowNewGroup(false); }}
        >
          <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-80 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <Database size={14} className="text-[var(--color-accent)]" />
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">{t("newDataSource")}</span>
            </div>
            <div className="px-4 py-4">
              <input
                autoFocus
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmNewDataSource();
                  if (e.key === "Escape") setShowNewGroup(false);
                }}
                placeholder={t("groupNamePlaceholder")}
                className="w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="px-4 pb-4 flex justify-end gap-2">
              <button
                onClick={() => setShowNewGroup(false)}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors"
              >
                {t("close")}
              </button>
              <button
                onClick={confirmNewDataSource}
                disabled={!newGroupName.trim()}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-40"
              >
                {t("propSave")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Dropdown ──────────────────────────────────────────────────────────────────

// A single menu row (leaf or submenu parent). Submenu parents reveal a flyout
// panel to the right on hover.
function MenuRow({ item, onClose }: { item: Exclude<MenuItemDef, { separator: true }>; onClose: () => void }) {
  const [subOpen, setSubOpen] = useState(false);
  const hasSub = !!item.submenu?.length;
  const isHeader = item.disabled && !hasSub;

  return (
    <div
      className="relative"
      onMouseEnter={() => hasSub && setSubOpen(true)}
      onMouseLeave={() => hasSub && setSubOpen(false)}
    >
      <button
        onClick={
          hasSub
            ? () => setSubOpen((s) => !s)
            : item.action && !item.disabled
            ? () => { item.action!(); onClose(); }
            : undefined
        }
        disabled={item.disabled}
        className={[
          "flex items-center gap-2 w-full px-3 py-1 text-left text-xs transition-colors",
          isHeader
            ? "text-[var(--color-text-muted)] cursor-default font-semibold opacity-50"
            : item.action || hasSub
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
        {hasSub && <ChevronRight size={11} className="ml-1 shrink-0 text-[var(--color-text-muted)]" />}
      </button>

      {hasSub && subOpen && (
        <div className="absolute left-full top-0 -mt-1 ml-0.5 min-w-[180px] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-xl z-50 py-1">
          {item.submenu!.map((sub, j) =>
            "separator" in sub
              ? <div key={j} className="my-1 border-t border-[var(--color-border)]" />
              : <MenuRow key={j} item={sub} onClose={onClose} />,
          )}
        </div>
      )}
    </div>
  );
}

const Dropdown = forwardRef<HTMLDivElement, { items: MenuItemDef[]; onClose: () => void }>(
function Dropdown({ items, onClose }, ref) {
  return (
    <div ref={ref} className="absolute top-full left-0 mt-0.5 min-w-[210px] bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded shadow-xl z-50 py-1">
      {items.map((item, i) =>
        "separator" in item
          ? <div key={i} className="my-1 border-t border-[var(--color-border)]" />
          : <MenuRow key={i} item={item} onClose={onClose} />,
      )}
    </div>
  );
});

// ── About modal ───────────────────────────────────────────────────────────────

function AboutModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const light = useIsLightTheme();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-80 overflow-hidden">
        <div className="flex flex-col items-center gap-3 px-6 py-6 bg-[var(--color-bg-elevated)]">
          <img
            src={light ? "/logo_centro_light.svg" : "/logo_centro.svg"}
            alt="OrbitalTerm"
            className="h-28 w-auto object-contain select-none"
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

// ── Master password recovery help ──────────────────────────────────────────────

function MasterHelpModal({ es, onClose }: { es: boolean; onClose: () => void }) {
  const steps = es
    ? [
        "La contraseña maestra protege solo la VISUALIZACIÓN de contraseñas de una fuente de datos (BD). Tus conexiones seguirán funcionando aunque la olvides.",
        "Si la olvidaste y necesitas volver a ver las contraseñas de esa BD, debes eliminar la fuente de datos y volver a crearla:",
        "1) Clic derecho sobre la fuente de datos (BD) en la barra lateral → Eliminar. Esto borra sus conexiones y su candado.",
        "2) Vuelve a crear la fuente de datos (menú Archivo → Nueva fuente de datos) y registra de nuevo tus conexiones.",
        "3) Crea una nueva contraseña maestra para esa BD y guárdala en un lugar seguro.",
        "Consejo: exporta tus conexiones (Archivo → Exportar) ANTES, para no perder los datos al recrear la BD. El export incluye las contraseñas en texto plano.",
      ]
    : [
        "The master password only protects VIEWING the saved passwords of a data source (DB). Your connections keep working even if you forget it.",
        "If you forgot it and need to view that DB's passwords again, delete the data source and recreate it:",
        "1) Right-click the data source (DB) in the sidebar → Delete. This removes its connections and its lock.",
        "2) Recreate the data source (File → New data source) and re-add your connections.",
        "3) Create a new master password for that DB and store it somewhere safe.",
        "Tip: export your connections (File → Export) BEFORE recreating, so you don't lose data. The export contains plaintext passwords.",
      ];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-[30rem] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <KeyRound size={14} className="text-[var(--color-accent)]" />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {es ? "Olvidé mi contraseña maestra" : "I forgot my master password"}
          </span>
        </div>
        <div className="px-5 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {steps.map((s, i) => (
            <p key={i} className="text-[12px] text-[var(--color-text-primary)] leading-relaxed">{s}</p>
          ))}
        </div>
        <div className="px-5 pb-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
          >
            {es ? "Entendido" : "Got it"}
          </button>
        </div>
      </div>
    </div>
  );
}
