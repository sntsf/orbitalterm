import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { HardDrive } from "lucide-react";
import { connectSsh, disconnectSsh, resizePty, sendInput, sftpConnect, sftpDisconnect } from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
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
    setShowSftp((v) => {
      if (v) {
        // Closing sftp panel — disconnect
        if (sftpSessionId) {
          sftpDisconnect(sftpSessionId).catch(console.error);
          setSftpSessionId(null);
        }
      }
      return !v;
    });
    // Re-fit after toggle
    setTimeout(() => fitAddonRef.current?.fit(), 50);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: "#0f1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#388bfd44",
        black: "#0d1117",        red: "#f85149",
        green: "#3fb950",        yellow: "#d29922",
        blue: "#388bfd",         magenta: "#bc8cff",
        cyan: "#39c5cf",         white: "#b1bac4",
        brightBlack: "#6e7681",  brightRed: "#ff7b72",
        brightGreen: "#56d364",  brightYellow: "#e3b341",
        brightBlue: "#79c0ff",   brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",   brightWhite: "#f0f6fc",
      },
      fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",monospace',
      fontSize: 13,
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
      const connection = getConnectionById(tab.connection_id);
      if (!connection) {
        term.writeln("\x1b[31mConnection not found.\x1b[0m");
        setTabStatus(tab.id, "error");
        return;
      }

      term.writeln(
        `\x1b[2mConnecting to \x1b[0m\x1b[33m${connection.username}@${connection.host}\x1b[0m\x1b[2m...\x1b[0m`
      );

      try {
        const sessionId = await connectSsh(connection.id);
        sessionIdRef.current = sessionId;
        setTabSessionId(tab.id, sessionId);
        setTabStatus(tab.id, "connected");

        // Auto-open SFTP panel and connect
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
          term.writeln("\r\n\x1b[2m[Connection closed]\x1b[0m");
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
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[Connection failed: ${err}]\x1b[0m`);
        setTabStatus(tab.id, "error");
      }
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
      if (sessionIdRef.current) {
        disconnectSsh(sessionIdRef.current).catch(console.error);
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
      {showSftp && (
        <div
          onMouseDown={onDividerMouseDown}
          className="w-1 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] transition-colors shrink-0"
        />
      )}

      {/* SFTP panel */}
      {showSftp && (
        <div
          className="overflow-hidden shrink-0"
          style={{ width: `${sftpWidth}%` }}
        >
          <SftpBrowser
            sessionId={sftpSessionId}
            connectionId={connection?.id ?? tab.connection_id}
            username={connection?.username}
            onConnect={handleSftpConnect}
          />
        </div>
      )}
    </div>
  );
}
