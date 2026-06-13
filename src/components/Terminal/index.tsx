import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { HardDrive } from "lucide-react";
import { connectSsh, disconnectSsh, resizePty, sendInput, sftpConnectFromSsh, sftpDisconnect } from "../../lib/commands";
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

  // The interactive SSH session id (russh) — reused by the SFTP browser so both
  // share one authenticated connection.
  const [sshSessionId, setSshSessionId] = useState<string | null>(null);

  // Credential prompt shown when the connection has no saved username/password
  // (russh authenticates up-front; the prompt's resolver feeds connect_ssh).
  const [credPrompt, setCredPrompt] = useState<{ needUser: boolean; authFailed?: boolean } | null>(null);
  const credResolveRef = useRef<((c: { username?: string; password?: string } | null) => void) | null>(null);

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

      let sessionId = "";

      if (tab.session_id) {
        // Resume a transferred session — skip the SSH handshake
        sessionId = tab.session_id;
        sessionIdRef.current = sessionId;
        setTabStatus(tab.id, "connected");
        term.writeln(`\x1b[2m[${t("sshSessionResumed")}]\x1b[0m`);
      } else {
        term.writeln(
          `\x1b[2m${t("sshConnecting")} \x1b[0m\x1b[33m${connection.username || "?"}@${connection.host}\x1b[0m\x1b[2m...\x1b[0m`
        );
        // russh authenticates up-front. If credentials are missing, prompt for
        // them and retry (so the terminal AND the SFTP browser share the
        // session that this single login establishes).
        let creds: { username?: string; password?: string } = {};
        let connected = false;
        while (!connected) {
          try {
            sessionId = await connectSsh(connection.id, creds.username, creds.password);
            connected = true;
          } catch (err) {
            const raw = String(err);
            const needCreds = raw.includes("NEED_CREDENTIALS");
            const authFailed = raw.includes("AUTH_FAILED");
            // Missing OR rejected credentials → (re)prompt and retry instead of
            // failing, so a typo doesn't kill the tab.
            if (needCreds || authFailed) {
              const provided = await new Promise<{ username?: string; password?: string } | null>((resolve) => {
                credResolveRef.current = resolve;
                setCredPrompt({ needUser: !connection.username, authFailed });
              });
              setCredPrompt(null);
              credResolveRef.current = null;
              if (!provided) {
                term.writeln(`\r\n\x1b[2m[${t("sshConnClosed")}]\x1b[0m`);
                setTabStatus(tab.id, "error");
                return;
              }
              creds = provided;
              continue;
            }
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
        sessionIdRef.current = sessionId!;
        setTabSessionId(tab.id, sessionId!);
        setTabStatus(tab.id, "connected");
      }

      // Reuse THIS SSH session for the SFTP browser (shared single connection).
      setSshSessionId(sessionId);
      setShowSftp(true);
      setTimeout(() => fitAddonRef.current?.fit(), 50);
      sftpConnectFromSsh(sessionId).then((sid) => {
        setSftpSessionId(sid);
        sftpSessionIdRef.current = sid;
      }).catch(console.error);

      // Buffer SSH output to detect connection errors emitted by the ssh process.
      // connectSsh() returns immediately after spawning; errors appear as PTY text.
      let sshConnError: string | null = null;
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\r\n]+/g, " ").trim();

      // Stream SSH output into xterm
      const unlistenData = await listen<string>(`ssh-data-${sessionId}`, (e) => {
        term.write(e.payload);
        if (!sshConnError) {
          const plain = stripAnsi(e.payload).toLowerCase();
          if (
            plain.includes("connection refused") || plain.includes("no route to host") ||
            plain.includes("connection timed out") || plain.includes("network is unreachable") ||
            plain.includes("host unreachable") || plain.includes("could not resolve") ||
            plain.includes("name or service not known") || plain.includes("ssh: connect to host") ||
            plain.includes("permission denied") || plain.includes("host key verification failed") ||
            plain.includes("too many authentication failures") || plain.includes("port 22: ")
          ) {
            sshConnError = stripAnsi(e.payload);
          }
        }
      });
      cleanups.push(unlistenData);

      // Handle SSH process exit — notify if a connection error was detected, then close tab
      const unlistenClosed = await listen(`ssh-closed-${sessionId}`, () => {
        const { t: tNow } = useI18nStore.getState();
        term.writeln(`\r\n\x1b[2m[${tNow("sshConnClosed")}]\x1b[0m`);
        if (sshConnError) {
          useNotifStore.getState().add({
            connName: connection.name,
            connType: "ssh",
            host: connection.host,
            raw: sshConnError,
          });
        }
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
        {credPrompt && (
          <CredentialPrompt
            needUser={credPrompt.needUser}
            authFailed={credPrompt.authFailed}
            host={connection?.host ?? ""}
            onSubmit={(c) => credResolveRef.current?.(c)}
            onCancel={() => credResolveRef.current?.(null)}
          />
        )}
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
          sshSessionId={sshSessionId}
          connectionId={connection?.id ?? tab.connection_id}
          username={connection?.username}
          onConnect={handleSftpConnect}
        />
      </div>
    </div>
  );
}

// Inline credential prompt for SSH connections without saved username/password.
function CredentialPrompt({
  needUser, authFailed, host, onSubmit, onCancel,
}: {
  needUser: boolean;
  authFailed?: boolean;
  host: string;
  onSubmit: (c: { username?: string; password?: string }) => void;
  onCancel: () => void;
}) {
  const { lang } = useI18nStore();
  const es = lang === "es";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  useEffect(() => { (needUser ? userRef : passRef).current?.focus(); }, [needUser]);

  const submit = () => onSubmit({ username: needUser ? username : undefined, password });

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
      <div className="w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 shadow-xl">
        <p className="text-[13px] font-semibold text-[var(--color-text-primary)] mb-0.5">
          {es ? "Credenciales requeridas" : "Credentials required"}
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3 truncate">{host}</p>
        {authFailed && (
          <p className="text-[11px] text-[var(--color-danger)] mb-2 -mt-1">
            {es ? "Credenciales incorrectas, intenta de nuevo." : "Invalid credentials, try again."}
          </p>
        )}
        {needUser && (
          <input
            ref={userRef}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") passRef.current?.focus(); if (e.key === "Escape") onCancel(); }}
            placeholder={es ? "Usuario" : "Username"}
            className="w-full mb-2 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
        )}
        <input
          ref={passRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
          placeholder={es ? "Contraseña" : "Password"}
          className="w-full mb-3 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel}
            className="px-2 py-1 text-[12px] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">
            {es ? "Cancelar" : "Cancel"}
          </button>
          <button onClick={submit}
            className="px-3 py-1 text-[12px] rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]">
            {es ? "Conectar" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
