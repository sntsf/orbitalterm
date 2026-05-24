import { useEffect, useState } from "react";
import { Save, Plug, Eye, EyeOff } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../store/useI18nStore";
import {
  saveConnection,
  updateConnection,
  getConnections,
  savePassword,
  deletePassword,
  hasPassword,
} from "../../lib/commands";
import type { AuthType, ConnectionType } from "../../types";

const DEFAULT_PORTS: Record<ConnectionType, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  ftp: 21,
  sftp: 22,
};

// Which auth modes each type supports — order determines dropdown order
const AUTH_FOR_TYPE: Record<ConnectionType, AuthType[]> = {
  ssh: ["password", "key", "agent"],
  sftp: ["password", "key", "agent"],
  rdp: ["password"],
  vnc: ["password"],
  ftp: ["password"],
};

export function PropertiesPanel() {
  const t = useT();
  const {
    connections,
    folders,
    groups,
    selectedConnectionId,
    isCreatingNew,
    newConnectionFolderId,
    newConnectionGroupId,
    setConnections,
    setIsCreatingNew,
    selectConnection,
    openTab,
  } = useAppStore();

  const existing = connections.find((c) => c.id === selectedConnectionId);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ConnectionType>("ssh");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [domain, setDomain] = useState("");
  const [authType, setAuthType] = useState<AuthType>("agent");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [folderId, setFolderId] = useState("");
  const [rdpAdmin, setRdpAdmin] = useState(false);
  const [notes, setNotes] = useState("");
  const [groupId, setGroupId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load existing connection into form
  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description);
      setType(existing.type);
      setHost(existing.host);
      setPort(existing.port);
      setUsername(existing.username);
      setDomain(existing.domain);
      setRdpAdmin(existing.rdp_admin ?? false);
      setAuthType(existing.auth_type);
      setKeyPath(existing.key_path);
      setFolderId(existing.folder_id ?? "");
      setGroupId(existing.group_id ?? "");
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
      setDescription("");
      setType("ssh");
      setHost("");
      setPort(22);
      setUsername("");
      setDomain("");
      setRdpAdmin(false);
      setAuthType("password");
      setKeyPath("");
      setPassword("");
      setFolderId(newConnectionFolderId ?? "");
      // Determine group_id: from folder's group, or newConnectionGroupId, or first group
      const folderGroup = newConnectionFolderId
        ? folders.find((f) => f.id === newConnectionFolderId)?.group_id
        : null;
      setGroupId(folderGroup ?? newConnectionGroupId ?? groups[0]?.id ?? "");
      setNotes("");
      setHasSaved(false);
      setError("");
    }
  }, [existing?.id, isCreatingNew, newConnectionFolderId, newConnectionGroupId]);

  const handleTypeChange = (newType: ConnectionType) => {
    setType(newType);
    setPort(DEFAULT_PORTS[newType]);
    const supportedAuth = AUTH_FOR_TYPE[newType];
    if (!supportedAuth.includes(authType)) {
      setAuthType(supportedAuth[0]);
    }
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError("");
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError(t("propRequired"));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        type,
        host: host.trim(),
        port,
        username: username.trim(),
        domain: domain.trim(),
        rdp_admin: rdpAdmin,
        auth_type: authType,
        key_path: keyPath.trim(),
        folder_id: folderId || null,
        notes,
        group_id: groupId,
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
        {t("propSelectOrCreate")}
      </div>
    );
  }

  const authLabels: Record<AuthType, string> = {
    password: "Password",
    key: "Key File",
    agent: "Agent",
  };

  const supportedAuthTypes = AUTH_FOR_TYPE[type];
  const showAuthSection = supportedAuthTypes.length > 1 || supportedAuthTypes[0] !== "password";
  const showDomain = type === "rdp";
  const showPasswordField = authType === "password";
  const showKeyField = authType === "key";

  return (
    <form onSubmit={handleSave} className="flex flex-col h-full overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">
          {isCreatingNew ? t("propNewConnection") : t("propProperties")}
        </span>
        <div className="flex gap-1">
          {existing && (
            <button
              type="button"
              onClick={handleConnect}
              title={t("propConnect")}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-success)] hover:bg-[var(--color-success)]/10 transition-colors"
            >
              <Plug size={11} />
              {t("propConnect")}
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
          >
            <Save size={11} />
            {saving ? t("propSaving") : t("propSave")}
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        <Row label={t("propType")}>
          <select
            value={type}
            onChange={(e) => handleTypeChange(e.target.value as ConnectionType)}
            className={inp}
          >
            <option value="ssh">SSH</option>
            <option value="rdp">RDP</option>
            <option value="vnc">VNC</option>
            <option value="ftp">FTP</option>
            <option value="sftp">SFTP</option>
          </select>
        </Row>

        <Row label={t("propName")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server" className={inp} />
        </Row>

        <Row label={t("propDesc")}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" className={inp} />
        </Row>

        <Row label={t("propHost")}>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" className={inp} />
        </Row>

        <Row label={t("propPort")}>
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inp} />
        </Row>

        <Row label={t("propUser")}>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" className={inp} />
        </Row>

        {showAuthSection && (
          <Row label={t("propAuth")}>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as AuthType)}
              className={inp}
            >
              {supportedAuthTypes.map((a) => (
                <option key={a} value={a}>{authLabels[a]}</option>
              ))}
            </select>
          </Row>
        )}

        {showKeyField && (
          <Row label={t("propSshKey")}>
            <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa" className={inp} />
          </Row>
        )}

        {showPasswordField && (
          <Row label={t("propPassword")}>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasSaved ? t("propPasswordSaved") : t("propPasswordPlaceholder")}
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

        {showDomain && (
          <Row label={t("propDomain")}>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="WORKGROUP"
              className={inp}
            />
          </Row>
        )}

        <Row label={t("propNotes")}>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="…"
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
