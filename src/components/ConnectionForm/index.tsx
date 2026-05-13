import { useState, useEffect } from "react";
import { X, Save, Eye, EyeOff } from "lucide-react";
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

export function ConnectionForm() {
  const { editingConnection, closeConnectionForm, setConnections, folders } = useAppStore();

  const [name, setName] = useState("");
  const [type, setType] = useState<ConnectionType>("ssh");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<AuthType>("agent");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (editingConnection) {
      setName(editingConnection.name);
      setType(editingConnection.type);
      setHost(editingConnection.host);
      setPort(editingConnection.port);
      setUsername(editingConnection.username);
      setAuthType(editingConnection.auth_type);
      setKeyPath(editingConnection.key_path);
      setFolderId(editingConnection.folder_id ?? "");
      setNotes(editingConnection.notes);

      if (editingConnection.auth_type === "password") {
        hasPassword(editingConnection.id)
          .then(setHasSavedPassword)
          .catch(() => setHasSavedPassword(false));
      }
    }
  }, [editingConnection]);

  const handleTypeChange = (t: ConnectionType) => {
    setType(t);
    setPort(t === "ssh" ? 22 : 3389);
    if (t === "rdp") setAuthType("password");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

      if (editingConnection) {
        const updated = await updateConnection({ ...editingConnection, ...payload });
        savedId = updated.id;
      } else {
        const created = await saveConnection(payload);
        savedId = created.id;
      }

      // Persist password to system keyring (separate from DB)
      if (authType === "password") {
        if (password) {
          await savePassword(savedId, password);
        }
      } else {
        // Auth type changed away from password — remove any stored credential
        await deletePassword(savedId).catch(() => {});
      }

      setConnections(await getConnections());
      closeConnectionForm();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const authLabels: Record<AuthType, string> = {
    agent: "SSH Agent",
    password: "Password",
    key: "Key File",
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-lg w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h2 className="font-semibold text-sm">
            {editingConnection ? "Edit Connection" : "New Connection"}
          </h2>
          <button
            onClick={closeConnectionForm}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]"
          >
            <X size={15} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3 max-h-[80vh] overflow-y-auto">
          {/* Protocol */}
          <div className="flex gap-1 bg-[var(--color-bg-elevated)] rounded p-1">
            {(["ssh", "rdp"] as ConnectionType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleTypeChange(t)}
                className={[
                  "flex-1 py-1 rounded text-xs font-medium uppercase transition-colors",
                  type === t
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                ].join(" ")}
              >
                {t}
              </button>
            ))}
          </div>

          <Field label="Name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Server"
              className={inputClass}
            />
          </Field>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Field label="Host / IP" required>
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.1.10"
                  className={inputClass}
                />
              </Field>
            </div>
            <Field label="Port">
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="Username" required>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              className={inputClass}
            />
          </Field>

          {/* Auth type — only for SSH */}
          {type === "ssh" && (
            <Field label="Authentication">
              <div className="flex gap-1 bg-[var(--color-bg-elevated)] rounded p-1">
                {(["agent", "password", "key"] as AuthType[]).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAuthType(a)}
                    className={[
                      "flex-1 py-1 rounded text-xs transition-colors",
                      authType === a
                        ? "bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] font-medium"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                    ].join(" ")}
                  >
                    {authLabels[a]}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {/* SSH agent info */}
          {type === "ssh" && authType === "agent" && (
            <p className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)] rounded px-3 py-2">
              Uses <code className="font-mono">$SSH_AUTH_SOCK</code>. Your existing SSH agent
              keys will be offered automatically.
            </p>
          )}

          {/* Key file */}
          {authType === "key" && (
            <Field label="Private Key Path" required>
              <input
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_rsa"
                className={inputClass}
              />
            </Field>
          )}

          {/* Password */}
          {authType === "password" && (
            <Field label="Password">
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasSavedPassword ? "●●●●●● (saved — leave blank to keep)" : "Enter password"}
                  className={inputClass + " pr-8"}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >
                  {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                Stored in system keyring (not in the database).
              </p>
            </Field>
          )}

          <Field label="Folder">
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className={inputClass}
            >
              <option value="">— No folder —</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className={inputClass + " resize-none"}
              placeholder="Optional notes..."
            />
          </Field>

          {error && <p className="text-[var(--color-danger)] text-xs">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeConnectionForm}
              className="px-3 py-1.5 rounded text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white font-medium transition-colors disabled:opacity-50"
            >
              <Save size={12} />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-[var(--color-text-muted)]">
        {label}
        {required && <span className="text-[var(--color-danger)] ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-2 py-1.5 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] transition-colors";
