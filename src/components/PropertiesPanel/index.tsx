import { useEffect, useState } from "react";
import { Save, Plug, Eye, EyeOff } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import {
  saveConnection,
  updateConnection,
  getConnections,
  savePassword,
  deletePassword,
  hasPassword,
} from "../../lib/commands";
import type { AuthType, ConnectionType } from "../../types";

export function PropertiesPanel() {
  const {
    connections,
    selectedConnectionId,
    isCreatingNew,
    setConnections,
    setIsCreatingNew,
    selectConnection,
    openTab,
    folders,
  } = useAppStore();

  const existing = connections.find((c) => c.id === selectedConnectionId);

  // Form state
  const [name, setName] = useState("");
  const [type, setType] = useState<ConnectionType>("ssh");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<AuthType>("agent");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load existing connection into form
  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setType(existing.type);
      setHost(existing.host);
      setPort(existing.port);
      setUsername(existing.username);
      setAuthType(existing.auth_type);
      setKeyPath(existing.key_path);
      setFolderId(existing.folder_id ?? "");
      setNotes(existing.notes);
      setPassword("");
      setError("");
      if (existing.auth_type === "password") {
        hasPassword(existing.id).then(setHasSaved).catch(() => setHasSaved(false));
      } else {
        setHasSaved(false);
      }
    } else if (isCreatingNew) {
      setName("");
      setType("ssh");
      setHost("");
      setPort(22);
      setUsername("");
      setAuthType("agent");
      setKeyPath("");
      setPassword("");
      setFolderId("");
      setNotes("");
      setHasSaved(false);
      setError("");
    }
  }, [existing?.id, isCreatingNew]);

  const handleTypeChange = (t: ConnectionType) => {
    setType(t);
    setPort(t === "ssh" ? 22 : 3389);
    if (t === "rdp") setAuthType("password");
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError("");
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError("Name, host and username are required.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        type,
        host: host.trim(),
        port,
        username: username.trim(),
        auth_type: authType,
        key_path: keyPath.trim(),
        folder_id: folderId || null,
        notes,
      };

      let savedId: string;
      if (existing) {
        const updated = await updateConnection({ ...existing, ...payload });
        savedId = updated.id;
      } else {
        const created = await saveConnection(payload);
        savedId = created.id;
        selectConnection(created.id);
        setIsCreatingNew(false);
      }

      if (authType === "password") {
        if (password) await savePassword(savedId, password);
      } else {
        await deletePassword(savedId).catch(() => {});
      }

      setConnections(await getConnections());
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    if (existing) openTab(existing);
  };

  // Empty state
  if (!existing && !isCreatingNew) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-muted)] text-xs">
        Select a connection or click + to create one
      </div>
    );
  }

  const authLabels: Record<AuthType, string> = {
    agent: "Agent",
    password: "Password",
    key: "Key File",
  };

  return (
    <form onSubmit={handleSave} className="flex flex-col h-full overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">
          {isCreatingNew ? "New Connection" : "Properties"}
        </span>
        <div className="flex gap-1">
          {existing && (
            <button
              type="button"
              onClick={handleConnect}
              title="Connect"
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-success)] hover:bg-[var(--color-success)]/10 transition-colors"
            >
              <Plug size={11} />
              Connect
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
          >
            <Save size={11} />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {/* Type toggle */}
        <Row label="Type">
          <div className="flex gap-1 bg-[var(--color-bg-elevated)] rounded p-0.5">
            {(["ssh", "rdp"] as ConnectionType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleTypeChange(t)}
                className={[
                  "flex-1 py-0.5 rounded text-[10px] uppercase font-medium transition-colors",
                  type === t
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                ].join(" ")}
              >
                {t}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server" className={inp} />
        </Row>

        <Row label="Host / IP">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" className={inp} />
        </Row>

        <Row label="Port">
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inp} />
        </Row>

        <Row label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" className={inp} />
        </Row>

        {/* Auth — SSH only */}
        {type === "ssh" && (
          <Row label="Auth">
            <div className="flex gap-1 bg-[var(--color-bg-elevated)] rounded p-0.5">
              {(["agent", "password", "key"] as AuthType[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAuthType(a)}
                  className={[
                    "flex-1 py-0.5 rounded text-[10px] transition-colors",
                    authType === a
                      ? "bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] font-medium"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                  ].join(" ")}
                >
                  {authLabels[a]}
                </button>
              ))}
            </div>
          </Row>
        )}

        {authType === "key" && (
          <Row label="Key Path">
            <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa" className={inp} />
          </Row>
        )}

        {authType === "password" && (
          <Row label="Password">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasSaved ? "●●●●●● (saved)" : "Enter password"}
                className={inp + " pr-7"}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              >
                {showPassword ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </div>
          </Row>
        )}

        <Row label="Folder">
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className={inp}>
            <option value="">— None —</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Row>

        <Row label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes…"
            className={inp + " resize-none"}
          />
        </Row>

        {error && <p className="text-[var(--color-danger)] text-[10px]">{error}</p>}
      </div>
    </form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-start gap-1.5">
      <span className="text-[10px] text-[var(--color-text-muted)] pt-1.5 truncate">{label}</span>
      <div>{children}</div>
    </div>
  );
}

const inp =
  "w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] transition-colors";
