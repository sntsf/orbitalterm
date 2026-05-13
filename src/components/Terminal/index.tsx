import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { Tab } from "../../types";

interface TerminalPaneProps {
  tab: Tab;
}

export function TerminalPane({ tab }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: "#0f1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#388bfd44",
        black: "#0d1117",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#388bfd",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ff7b72",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;

    // Placeholder until real SSH backend is wired
    term.writeln(`\x1b[1;34mOrbitalTerm\x1b[0m — connecting to \x1b[33m${tab.connection_name}\x1b[0m...`);
    term.writeln("\x1b[2mSSH backend coming in next milestone.\x1b[0m");
    term.writeln("");

    const observer = new ResizeObserver(() => fitAddon.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [tab.id]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ padding: "4px" }}
    />
  );
}
