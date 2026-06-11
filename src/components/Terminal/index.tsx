import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { HardDrive } from "lucide-react";
import { connectSsh, disconnectSsh, resizePty, sendInput, sftpConnect, sftpDisconnect } from "../../lib/commands";
import { skipDisconnectSessions } from "../../lib/sessionTransfer";
import { useAppStore } from "../../store/useAppStore";
import { usePrefsStore, resolvedTermTheme } from "../../store/usePrefsStore";
import { useNotifStore } from "../../store/useNotifStore";
import { useI18nStore } from "../../store/useI18nStore";
import { friendlyConnError } from "../../lib/connErrors";
import { SftpBrowser } from "../SftpBrowser";
import type { Tab } from "../../types";

interface TerminalPaneProps {
  tab: Tab;
}

export function TerminalPane({ tab }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { setTabStatus, setTabSessionId, getConnectionById, closeTab } = useAppStore();
  const { fontSize, theme } = usePrefsStore();

  // SFTP panel state
  const [showSftp, setShowSftp] = useState(false);
  const [sftpSessionId, setSftpSessionId] = useState<string | null>(null);
  const sftpSessionIdRef = useRef<string | null>(null);
  const [sftpWidth, setSftpWidth] = useState(35); // percentage

  // Drag handle state
  const draggingDivider = useRef(false);
  const dividerStartX = useRef(0);
  const dividerStartWidth = useRef(35);
  const containerDivRef = useRef<HTMLDivElement>(null);

  const onDividerMouseDown = (e: React.MouseEvent) => {
    draggingDivider.current = true;
    dividerStartX.current = e.clientX;
    dividerStartWidth.current = sftpWidth;

    const onMove = (ev: MouseEvent) => {
      if (!draggingDivider.current || !containerDivRef.current) return;
      const totalWidth = containerDivRef.current.getBoundingClientRect().width;
      const delta = dividerStartX.current - ev.clientX;
      const deltaPercent = (delta / totalWidth) * 100;
      const newWidth = Math.max(20, Math.min(60, dividerStartWidth.current + deltaPercent));
      setSftpWidth(newWidth);
    };
    const onUp = () => {
      draggingDivider.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Re-fit terminal after resize
      fitAddonRef.current?.fit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleSftpConnect = useCallback((sid: string) => {
    setSftpSessionId(sid);
    sftpSessionIdRef.current = sid;
  }, []);

  const toggleSftp = () => {
    setShowSftp((v) => !v);
    setTimeout(() => fitAddonRef.current?.fit(), 50);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      theme: resolvedTermTheme(theme) as any,
      fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",monospace',
      fontSize,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    const cleanups: Array<() => void> = [];

    const init = async () => {
      const { t, lang } = useI18nStore.getState();
      const connection = getConnectionById(tab.connection_id);
      if (!connection) {
        term.writeln(`\x1b[31m${t("sshConnNotFound")}\x1b[0m`);
        setTabStatus(tab.id, "error");
        return;
      }

      let sessionId: string;

      if (tab.session_id) {
        // Resume a transferred session — skip the SSH handshake
        sessionId = tab.session_id;
        sessionIdRef.current = sessionId;
        setTabStatus(tab.id, "connected");
        term.writeln(`\x1b[2m[${t("sshSessionResumed")}]\x1b[0m`);
      } else {
        term.writeln(
          `\x1b[2m${t("sshConnecting")} \x1b[0m\x1b[33m${connection.username}@${connection.host}\x1b[0m\x1b[2m...\x1b[0m`
        );
        try {
          sessionId = await connectSsh(connection.id);
          sessionIdRef.current = sessionId;
          setTabSessionId(tab.id, sessionId);
          setTabStatus(tab.id, "connected");
        } catch (err) {
          const raw = String(err);
          const friendly = friendlyConnError(raw, lang, "ssh");
          term.writeln(`\r\n\x1b[31m[${t("sshConnFailed")}: ${friendly}]\x1b[0m`);
          setTabStatus(tab.id, "error");
          useNotifStore.getState().add({
            connName: connection.name,
            connType: connection.type,
            host: connection.host,
            raw,
          });
          return;
        }
      }

      // Auto-open SFTP panel and connect (always reconnect SFTP — it's independent)
      setShowSftp(true);
      setTimeout(() => fitAddonRef.current?.fit(), 50);
      sftpConnect(connection.id).then((sid) => {
        setSftpSessionId(sid);
        sftpSessionIdRef.current = sid;
      }).catch(console.error);

      // Stream SSH output into xterm
      const unlistenData = await listen<string>(`ssh-data-${sessionId}`, (e) => {
        term.write(e.payload);
      });
      cleanups.push(unlistenData);

      // Handle SSH process exit — close SFTP and the tab
      const unlistenClosed = await listen(`ssh-closed-${sessionId}`, () => {
        const { t: tNow } = useI18nStore.getState();
        term.writeln(`\r\n\x1b[2m[${tNow("sshConnClosed")}]\x1b[0m`);
        if (sftpSessionIdRef.current) {
          sftpDisconnect(sftpSessionIdRef.current).catch(console.error);
          sftpSessionIdRef.current = null;
        }
        setTimeout(() => closeTab(tab.id), 1500);
      });
      cleanups.push(unlistenClosed);

      // Copy-on-select (like PuTTY): selecting text copies it automatically
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      });

      // Forward keystrokes to SSH
      term.onData((data) => {
        if (sessionIdRef.current) {
          sendInput(sessionIdRef.current, data).catch(console.error);
        }
      });

      // Sync terminal size with PTY on resize
      term.onResize(({ cols, rows }) => {
        if (sessionIdRef.current) {
          resizePty(sessionIdRef.current, cols, rows).catch(console.error);
        }
      });

      // Initial size sync
      await resizePty(sessionId, term.cols, term.rows);
    };

    init();

    // Resize observer keeps PTY in sync when the pane is resized
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      cleanups.forEach((fn) => fn());
      term.dispose();
      fitAddonRef.current = null;
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sid) {
        if (skipDisconnectSessions.has(sid)) {
          skipDisconnectSessions.delete(sid);
        } else {
          disconnectSsh(sid).catch(console.error);
        }
      }
    };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup SFTP on unmount
  useEffect(() => {
    return () => {
      if (sftpSessionId) {
        sftpDisconnect(sftpSessionId).catch(console.error);
      }
    };
  }, [sftpSessionId]);

  const connection = getConnectionById(tab.connection_id);

  return (
    <div ref={containerDivRef} className="flex w-full h-full overflow-hidden relative">
      {/* Terminal pane */}
      <div
        className="flex flex-col overflow-hidden"
        style={{ width: showSftp ? `${100 - sftpWidth}%` : "100%" }}
      >
        {/* Toggle button */}
        <div className="absolute top-1 right-1 z-10">
          <button
            onClick={toggleSftp}
            title={showSftp ? "Hide SFTP panel" : "Show SFTP panel"}
            className={`p-1 rounded transition-colors ${
              showSftp
                ? "bg-[var(--color-accent)] text-white"
                : "bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            <HardDrive size={13} />
          </button>
        </div>
        <div ref={containerRef} className="w-full h-full" style={{ padding: "4px" }} />
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDividerMouseDown}
        className="w-1 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors shrink-0"
        style={{ display: showSftp ? undefined : "none" }}
      />

      {/* SFTP panel — always mounted to preserve navigation state */}
      <div
        className="overflow-hidden shrink-0"
        style={{ width: `${sftpWidth}%`, display: showSftp ? undefined : "none" }}
      >
        <SftpBrowser
          sessionId={sftpSessionId}
          connectionId={connection?.id ?? tab.connection_id}
          username={connection?.username}
          onConnect={handleSftpConnect}
        />
      </div>
    </div>
  );
}
