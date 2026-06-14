import { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, Loader, Eye, EyeOff, Maximize2, Minimize2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { vncConnect, vncDisconnect, vncKeyEvent, vncPointerEvent, vncSendClipboard } from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
import { useNotifStore } from "../../store/useNotifStore";
import { useT } from "../../store/useI18nStore";
import type { Tab } from "../../types";

interface VncPaneProps {
  tab: Tab;
}

// Map DOM KeyboardEvent.code → X11 keysym (RFB uses X11 keysyms)
function domKeyToKeysym(e: KeyboardEvent): number {
  // Printable ASCII: keysym = Unicode codepoint
  if (e.key.length === 1) {
    return e.key.charCodeAt(0);
  }
  switch (e.code) {
    // Function keys
    case "F1":  return 0xffbe;
    case "F2":  return 0xffbf;
    case "F3":  return 0xffc0;
    case "F4":  return 0xffc1;
    case "F5":  return 0xffc2;
    case "F6":  return 0xffc3;
    case "F7":  return 0xffc4;
    case "F8":  return 0xffc5;
    case "F9":  return 0xffc6;
    case "F10": return 0xffc7;
    case "F11": return 0xffc8;
    case "F12": return 0xffc9;
    // Navigation
    case "Escape":    return 0xff1b;
    case "Tab":       return 0xff09;
    case "Enter":     return 0xff0d;
    case "Backspace": return 0xff08;
    case "Delete":    return 0xffff;
    case "Insert":    return 0xff63;
    case "Home":      return 0xff50;
    case "End":       return 0xff57;
    case "PageUp":    return 0xff55;
    case "PageDown":  return 0xff56;
    case "ArrowLeft":  return 0xff51;
    case "ArrowUp":    return 0xff52;
    case "ArrowRight": return 0xff53;
    case "ArrowDown":  return 0xff54;
    // Modifiers
    case "ShiftLeft":   case "ShiftRight":   return 0xffe1;
    case "ControlLeft": case "ControlRight": return 0xffe3;
    case "AltLeft":     return 0xffe9;
    case "AltRight":    return 0xffea;
    case "MetaLeft":    case "MetaRight":    return 0xffeb;
    case "CapsLock":    return 0xffe5;
    case "NumLock":     return 0xff7f;
    case "ScrollLock":  return 0xff14;
    // Numpad
    case "Numpad0": return 0xffb0;
    case "Numpad1": return 0xffb1;
    case "Numpad2": return 0xffb2;
    case "Numpad3": return 0xffb3;
    case "Numpad4": return 0xffb4;
    case "Numpad5": return 0xffb5;
    case "Numpad6": return 0xffb6;
    case "Numpad7": return 0xffb7;
    case "Numpad8": return 0xffb8;
    case "Numpad9": return 0xffb9;
    case "NumpadAdd":      return 0xffab;
    case "NumpadSubtract": return 0xffad;
    case "NumpadMultiply": return 0xffaa;
    case "NumpadDivide":   return 0xffaf;
    case "NumpadDecimal":  return 0xffae;
    case "NumpadEnter":    return 0xff8d;
    default: return 0;
  }
}

interface VncFrame {
  data: string;
  width: number;
  height: number;
}

export function VncPane({ tab }: VncPaneProps) {
  const { getConnectionById, setTabStatus, closeTab } = useAppStore();
  const connection = getConnectionById(tab.connection_id);
  const t = useT();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [status, setStatus] = useState<"connecting" | "connected">("connecting");
  const [vncSize, setVncSize] = useState({ width: 1024, height: 768 });
  const [viewOnly, setViewOnly] = useState(false);
  const [fitMode, setFitMode] = useState<"fit" | "actual">("fit");

  // Draw a received JPEG frame onto the canvas
  const drawFrame = useCallback((payload: VncFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0); };
    img.src = `data:image/jpeg;base64,${payload.data}`;
  }, []);

  const connect = useCallback(async () => {
    if (!connection) return;
    setStatus("connecting");
    try {
      const result = await vncConnect(connection.id);
      sessionIdRef.current = result.session_id;
      setVncSize({ width: result.width, height: result.height });
      setStatus("connected");
      setTabStatus(tab.id, "connected");
    } catch (err) {
      const raw = String(err);
      useNotifStore.getState().add({
        connName: connection.name,
        connType: "vnc",
        host: connection.host,
        raw,
      });
      closeTab(tab.id);
    }
  }, [connection, tab.id, setTabStatus, closeTab]);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => {
      if (sessionIdRef.current) {
        vncDisconnect(sessionIdRef.current).catch(console.error);
        sessionIdRef.current = null;
      }
    };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen to frames and disconnection events
  useEffect(() => {
    if (status !== "connected" || !sessionIdRef.current) return;
    const sid = sessionIdRef.current;
    const cleanups: (() => void)[] = [];

    listen<VncFrame>(`vnc-frame-${sid}`, (e) => drawFrame(e.payload))
      .then((fn) => cleanups.push(fn));
    listen(`vnc-disconnected-${sid}`, () => {
      closeTab(tab.id);
    }).then((fn) => cleanups.push(fn));
    // Remote clipboard → local OS clipboard
    listen<string>(`vnc-clipboard-${sid}`, (e) => {
      navigator.clipboard.writeText(e.payload).catch(() => {});
    }).then((fn) => cleanups.push(fn));

    return () => cleanups.forEach((fn) => fn());
  }, [status, drawFrame, tab.id, setTabStatus]);

  // Mouse event handlers
  const getVncCoords = (e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = vncSize.width / rect.width;
    const scaleY = vncSize.height / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const getButtons = (e: React.MouseEvent, isDown: boolean): number => {
    if (!isDown) return 0;
    // RFB button mask: bit0=left, bit1=middle, bit2=right
    switch (e.button) {
      case 0: return 0x01;
      case 1: return 0x02;
      case 2: return 0x04;
      default: return 0;
    }
  };

  const sendPointer = (e: React.MouseEvent, buttons: number) => {
    if (!sessionIdRef.current || viewOnly) return;
    const { x, y } = getVncCoords(e);
    vncPointerEvent(sessionIdRef.current, buttons, x, y).catch(console.error);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!sessionIdRef.current || viewOnly) return;
    // Send current button state with position
    const { x, y } = getVncCoords(e);
    const buttons = (e.buttons & 1) | ((e.buttons & 4) >> 1) | ((e.buttons & 2) << 1);
    vncPointerEvent(sessionIdRef.current, buttons, x, y).catch(console.error);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (!sessionIdRef.current || viewOnly) return;
    const { x, y } = getVncCoords(e as unknown as React.MouseEvent);
    // Wheel up = button 4 (0x08), wheel down = button 5 (0x10)
    const btn = e.deltaY < 0 ? 0x08 : 0x10;
    vncPointerEvent(sessionIdRef.current, btn, x, y).catch(console.error);
    vncPointerEvent(sessionIdRef.current, 0, x, y).catch(console.error);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!sessionIdRef.current || viewOnly) return;
    e.preventDefault();
    const key = domKeyToKeysym(e.nativeEvent);
    if (key) vncKeyEvent(sessionIdRef.current, true, key).catch(console.error);
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (!sessionIdRef.current || viewOnly) return;
    e.preventDefault();
    const key = domKeyToKeysym(e.nativeEvent);
    if (key) vncKeyEvent(sessionIdRef.current, false, key).catch(console.error);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  // Push the local OS clipboard to the server when the viewer gains focus, so
  // pasting inside the remote desktop works.
  const handleFocus = () => {
    if (viewOnly || !sessionIdRef.current) return;
    navigator.clipboard.readText().then((txt) => {
      if (txt && sessionIdRef.current) vncSendClipboard(sessionIdRef.current, txt).catch(() => {});
    }).catch(() => {});
  };

  // ── Connecting spinner ─────────────────────────────────────────────────────

  if (status === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--color-text-muted)] bg-[var(--color-bg-base)]">
        <Loader size={32} className="animate-spin opacity-40" />
        <p className="text-xs">{t("vncConnecting")}</p>
        {connection && (
          <p className="text-[10px] text-[var(--color-text-muted)]">
            {connection.host}:{connection.port}
          </p>
        )}
      </div>
    );
  }

  // ── Connected: canvas viewer ───────────────────────────────────────────────

  const fit = fitMode === "fit";

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-black focus:outline-none flex ${
        fit ? "items-center justify-center overflow-hidden" : "overflow-auto"
      }`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onFocus={handleFocus}
    >
      {/* Toolbar */}
      <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
        <button
          onClick={() => setViewOnly((v) => !v)}
          title={viewOnly ? "Solo lectura: activo (clic para permitir control)" : "Permitir control (clic para solo lectura)"}
          className={`p-1 rounded transition-colors ${viewOnly ? "bg-[var(--color-accent)] text-white" : "bg-black/60 text-[var(--color-text-muted)] hover:text-white"}`}
        >
          {viewOnly ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <button
          onClick={() => setFitMode((m) => (m === "fit" ? "actual" : "fit"))}
          title={fit ? "Ajustar a ventana (clic para tamaño real 1:1)" : "Tamaño real 1:1 (clic para ajustar)"}
          className="p-1 rounded bg-black/60 text-[var(--color-text-muted)] hover:text-white transition-colors"
        >
          {fit ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
        </button>
      </div>

      {/* Status bar */}
      <div className="absolute top-1 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-black/60 rounded px-2 py-0.5 opacity-0 hover:opacity-100 transition-opacity">
        <Monitor size={10} className="text-green-400" />
        <span className="text-[10px] text-[var(--color-text-muted)] font-mono">
          {connection?.host}:{connection?.port} — {vncSize.width}×{vncSize.height}{viewOnly ? " — solo lectura" : ""}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        width={vncSize.width}
        height={vncSize.height}
        style={{
          maxWidth: fit ? "100%" : "none",
          maxHeight: fit ? "100%" : "none",
          objectFit: "contain",
          cursor: viewOnly ? "default" : "crosshair",
          margin: fit ? undefined : "auto",
          display: "block",
        }}
        onMouseDown={(e) => { sendPointer(e, getButtons(e, true)); (e.currentTarget.parentElement as HTMLDivElement)?.focus(); }}
        onMouseUp={(e) => sendPointer(e, 0)}
        onMouseMove={handleMouseMove}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}
