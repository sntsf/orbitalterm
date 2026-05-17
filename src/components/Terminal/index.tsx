import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { connectSsh, disconnectSsh, resizePty, sendInput } from "../../lib/commands";
import { useAppStore } from "../../store/useAppStore";
import type { Tab } from "../../types";

interface TerminalPaneProps {
  tab: Tab;
}

export function TerminalPane({ tab }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const { setTabStatus, setTabSessionId, getConnectionById } = useAppStore();

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

        // Stream SSH output into xterm
        const unlistenData = await listen<string>(`ssh-data-${sessionId}`, (e) => {
          term.write(e.payload);
        });
        cleanups.push(unlistenData);

        // Handle SSH process exit
        const unlistenClosed = await listen(`ssh-closed-${sessionId}`, () => {
          term.writeln("\r\n\x1b[2m[Connection closed]\x1b[0m");
          setTabStatus(tab.id, "idle");
        });
        cleanups.push(unlistenClosed);

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
      if (sessionIdRef.current) {
        disconnectSsh(sessionIdRef.current).catch(console.error);
      }
    };
  }, [tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="w-full h-full" style={{ padding: "4px" }} />;
}
