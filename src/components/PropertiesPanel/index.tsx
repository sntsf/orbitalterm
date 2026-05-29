import { useEffect, useState } from "react";
import { Save, Plug, Eye, EyeOff, Info } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT, useI18nStore } from "../../store/useI18nStore";
import {
  saveConnection,
  updateConnection,
  getConnections,
  savePassword,
  deletePassword,
  hasPassword,
} from "../../lib/commands";
import type { AuthType, ConnectionType } from "../../types";
import { CONN_ICONS, DEFAULT_CONN_ICON, ConnIconDisplay, type ConnIconKey } from "../../lib/connIcons";

const DEFAULT_PORTS: Record<ConnectionType, number> = {
  ssh: 22,
  rdp: 3389,
  vnc: 5900,
  ftp: 21,
  sftp: 22,
  browser: 443,
};

const AUTH_FOR_TYPE: Record<ConnectionType, AuthType[]> = {
  ssh: ["password", "key", "agent"],
  sftp: ["password", "key", "agent"],
  rdp: ["password"],
  vnc: ["password"],
  ftp: ["password"],
  browser: [],
};

type FieldKey = "type" | "name" | "desc" | "host" | "port" | "user" | "auth" | "key" | "password" | "domain" | "notes" | "icon" | "url" | "customHosts";

const HINTS: Record<"es" | "en", Record<FieldKey, { title: string; body: string }>> = {
  es: {
    type:     { title: "Tipo de conexión", body: "Protocolo usado para conectarse al servidor remoto: SSH (Linux/Unix), RDP (Windows), VNC (escritorio remoto), FTP o SFTP (transferencia de archivos)." },
    name:     { title: "Nombre", body: "Nombre descriptivo para identificar esta conexión en la lista. Puede ser el nombre del servidor o un alias personalizado." },
    desc:     { title: "Descripción", body: "Descripción opcional con información adicional sobre este servidor o su función dentro de la infraestructura." },
    host:     { title: "Host / IP", body: "Dirección IP o nombre de dominio del servidor remoto al que desea conectarse. Ejemplo: 192.168.1.10 o servidor.empresa.com." },
    port:     { title: "Puerto", body: "Puerto TCP en el que escucha el servicio remoto. El valor predeterminado depende del tipo: SSH=22, RDP=3389, VNC=5900, FTP=21, SFTP=22." },
    user:     { title: "Usuario", body: "Nombre de usuario con el que se autenticará en el servidor remoto. En Linux suele ser 'root' o un usuario con privilegios sudo." },
    auth:     { title: "Autenticación", body: "Método de autenticación: Password (contraseña), Key File (llave privada SSH), Agent (agente SSH del sistema operativo)." },
    key:      { title: "Llave SSH", body: "Ruta a su archivo de llave privada SSH. Ejemplo: ~/.ssh/id_rsa. La llave pública correspondiente debe estar en el servidor." },
    password: { title: "Contraseña", body: "Contraseña del usuario remoto. Se almacena cifrada. Déjelo vacío si no desea modificar la contraseña guardada." },
    domain:   { title: "Dominio", body: "Dominio de Windows o Active Directory al que pertenece el usuario. En equipos locales suele ser el nombre del equipo o 'WORKGROUP'." },
    notes:    { title: "Notas", body: "Campo libre para anotaciones: comandos útiles, credenciales secundarias, historial de cambios o cualquier información relevante." },
    icon:     { title: "Icono", body: "Icono visual que identifica el tipo o rol de este servidor en la lista de conexiones. Se asigna automáticamente según el tipo de conexión." },
    url:      { title: "URL", body: "Dirección web a la que se conectará el navegador integrado. Ejemplo: https://vcenter.empresa.local o 10.0.0.1. Si no incluye protocolo se usará https:// por defecto." },
    customHosts: { title: "Hosts personalizados", body: "Entradas DNS locales para esta conexión, con el mismo formato que /etc/hosts. Se aplican solo cuando este navegador está abierto, sin modificar el sistema. Ejemplo:\n10.0.0.5 vcenter.empresa.local" },
  },
  en: {
    type:     { title: "Connection type", body: "Protocol used to connect to the remote server: SSH (Linux/Unix), RDP (Windows), VNC (remote desktop), FTP or SFTP (file transfer)." },
    name:     { title: "Name", body: "Descriptive name to identify this connection in the list. Can be the server name or a custom alias." },
    desc:     { title: "Description", body: "Optional description with additional information about this server or its role in the infrastructure." },
    host:     { title: "Host / IP", body: "IP address or domain name of the remote server to connect to. Example: 192.168.1.10 or server.company.com." },
    port:     { title: "Port", body: "TCP port on which the remote service listens. Default depends on type: SSH=22, RDP=3389, VNC=5900, FTP=21, SFTP=22." },
    user:     { title: "Username", body: "Username to authenticate with on the remote server. On Linux this is often 'root' or a user with sudo privileges." },
    auth:     { title: "Authentication", body: "Authentication method: Password, Key File (SSH private key), or Agent (OS SSH agent)." },
    key:      { title: "SSH Key", body: "Path to your SSH private key file. Example: ~/.ssh/id_rsa. The matching public key must be on the server." },
    password: { title: "Password", body: "Remote user password. Stored encrypted. Leave empty to keep the currently saved password." },
    domain:   { title: "Domain", body: "Windows or Active Directory domain. On standalone machines this is usually the machine name or 'WORKGROUP'." },
    notes:    { title: "Notes", body: "Free-form field for notes: useful commands, secondary credentials, change history, or any relevant server info." },
    icon:     { title: "Icon", body: "Visual icon that identifies the role of this server in the connection list. Auto-assigned based on connection type." },
    url:      { title: "URL", body: "The web address the embedded browser will open. Example: https://vcenter.company.local or 10.0.0.1. If no scheme is given, https:// is assumed." },
    customHosts: { title: "Custom hosts", body: "Per-connection DNS overrides in /etc/hosts format. Applied only while this browser window is open — the system hosts file is never modified. Example:\n10.0.0.5 vcenter.company.local" },
  },
};

export function PropertiesPanel() {
  const t = useT();
  const { lang } = useI18nStore();
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

  const { sidebarHint } = useAppStore();
  const existing = connections.find((c) => c.id === selectedConnectionId);

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
  const [icon, setIcon] = useState<string>("");
  const [url, setUrl] = useState("");
  const [customHosts, setCustomHosts] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [focusedField, setFocusedField] = useState<FieldKey | null>(null);

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
      setIcon(existing.icon || DEFAULT_CONN_ICON[existing.type]);
      setUrl(existing.url ?? "");
      setCustomHosts(existing.custom_hosts ?? "");
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
      setIcon(DEFAULT_CONN_ICON["ssh"]);
      setFolderId(newConnectionFolderId ?? "");
      const folderGroup = newConnectionFolderId
        ? folders.find((f) => f.id === newConnectionFolderId)?.group_id
        : null;
      setGroupId(folderGroup ?? newConnectionGroupId ?? groups[0]?.id ?? "");
      setNotes("");
      setUrl("");
      setCustomHosts("");
      setHasSaved(false);
      setError("");
    }
  }, [existing?.id, isCreatingNew, newConnectionFolderId, newConnectionGroupId]);

  const handleTypeChange = (newType: ConnectionType) => {
    setType(newType);
    setPort(DEFAULT_PORTS[newType]);
    const supportedAuth = AUTH_FOR_TYPE[newType];
    if (!supportedAuth.includes(authType)) setAuthType(supportedAuth[0]);
    // Auto-update icon if it still matches the old type's default
    setIcon((prev) => {
      const oldDefault = DEFAULT_CONN_ICON[type];
      if (!prev || prev === oldDefault) return DEFAULT_CONN_ICON[newType];
      return prev;
    });
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError("");
    const isBrowser = type === "browser";
    if (!name.trim() || (!isBrowser && (!host.trim() || !username.trim()))) {
      setError(isBrowser ? (lang === "es" ? "El nombre y la URL son obligatorios." : "Name and URL are required.") : t("propRequired"));
      return;
    }
    if (isBrowser && !url.trim()) {
      setError(lang === "es" ? "El nombre y la URL son obligatorios." : "Name and URL are required.");
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
        icon,
        url: url.trim(),
        custom_hosts: customHosts,
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

  if (!existing && !isCreatingNew) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)] text-xs px-4 text-center">
          {t("propSelectOrCreate")}
        </div>
        <HintBox hint={sidebarHint} lang={lang} />
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

  const hint = focusedField ? HINTS[lang][focusedField] : sidebarHint;
  const focus = (f: FieldKey) => () => setFocusedField(f);
  const blur = () => setFocusedField(null);

  return (
    <form onSubmit={handleSave} className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] shrink-0">
        <span className="text-[12px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">
          {isCreatingNew ? t("propNewConnection") : t("propProperties")}
        </span>
        <div className="flex gap-1">
          {existing && (
            <button
              type="button"
              onClick={handleConnect}
              title={t("propConnect")}
              className="flex items-center gap-1 px-2 py-1 rounded text-[12px] text-[var(--color-success)] hover:bg-[var(--color-success)]/10 transition-colors"
            >
              <Plug size={13} />
              {t("propConnect")}
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-1 px-2 py-1 rounded text-[12px] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
          >
            <Save size={13} />
            {saving ? t("propSaving") : t("propSave")}
          </button>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0">
        <Row label={t("propType")}>
          <select
            value={type}
            onChange={(e) => handleTypeChange(e.target.value as ConnectionType)}
            onFocus={focus("type")} onBlur={blur}
            className={inp}
          >
            <option value="ssh">SSH</option>
            <option value="rdp">RDP</option>
            <option value="vnc">VNC</option>
            <option value="ftp">FTP</option>
            <option value="sftp">SFTP</option>
            <option value="browser">{lang === "es" ? "Navegador" : "Browser"}</option>
          </select>
        </Row>

        {/* Icon picker */}
        <Row label={lang === "es" ? "Icono" : "Icon"}>
          <div className="flex items-center gap-2" onFocus={focus("icon")} onBlur={blur}>
            <ConnIconDisplay iconKey={icon || DEFAULT_CONN_ICON[type]} size={20} />
            <select
              value={icon || DEFAULT_CONN_ICON[type]}
              onChange={(e) => setIcon(e.target.value)}
              className={inp}
            >
              {(Object.entries(CONN_ICONS) as [ConnIconKey, typeof CONN_ICONS[ConnIconKey]][]).map(([key, def]) => (
                <option key={key} value={key}>
                  {lang === "es" ? def.label_es : def.label_en}
                </option>
              ))}
            </select>
          </div>
        </Row>

        <Row label={t("propName")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server"
            onFocus={focus("name")} onBlur={blur} className={inp} />
        </Row>

        <Row label={t("propDesc")}>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description"
            onFocus={focus("desc")} onBlur={blur} className={inp} />
        </Row>

        {type !== "browser" && (
          <>
            <Row label={t("propHost")}>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10"
                onFocus={focus("host")} onBlur={blur} className={inp} />
            </Row>
            <Row label={t("propPort")}>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}
                onFocus={focus("port")} onBlur={blur} className={inp} />
            </Row>
            <Row label={t("propUser")}>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root"
                onFocus={focus("user")} onBlur={blur} className={inp} />
            </Row>
          </>
        )}

        {showAuthSection && (
          <Row label={t("propAuth")}>
            <select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}
              onFocus={focus("auth")} onBlur={blur} className={inp}>
              {supportedAuthTypes.map((a) => (
                <option key={a} value={a}>{authLabels[a]}</option>
              ))}
            </select>
          </Row>
        )}

        {showKeyField && (
          <Row label={t("propSshKey")}>
            <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa"
              onFocus={focus("key")} onBlur={blur} className={inp} />
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
                onFocus={focus("password")} onBlur={blur}
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
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="WORKGROUP"
              onFocus={focus("domain")} onBlur={blur} className={inp} />
          </Row>
        )}

        {type === "browser" ? (
          <>
            <Row label={t("propUrl")}>
              <input value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="https://vcenter.empresa.local"
                onFocus={focus("url")} onBlur={blur} className={inp} />
            </Row>
            <Row label={t("propCustomHosts")}>
              <textarea
                value={customHosts}
                onChange={(e) => setCustomHosts(e.target.value)}
                rows={5}
                placeholder={"# Formato /etc/hosts\n10.0.0.10 vcenter.empresa.local\n10.0.0.11 esxi.empresa.local"}
                onFocus={focus("customHosts")} onBlur={blur}
                className={inp + " resize-none font-mono text-[11px]"}
              />
            </Row>
          </>
        ) : (
          <Row label={t("propNotes")}>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="…"
              onFocus={focus("notes")} onBlur={blur} className={inp + " resize-none"} />
          </Row>
        )}

        {error && <p className="text-[var(--color-danger)] text-[12px]">{error}</p>}
      </div>

      {/* Contextual hint */}
      <HintBox hint={hint} lang={lang} />
    </form>
  );
}

function HintBox({ hint, lang }: { hint: { title: string; body: string } | null; lang: "es" | "en" }) {
  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-base)] px-3 py-2 min-h-[72px]">
      {hint ? (
        <div className="flex gap-2">
          <Info size={13} className="text-[var(--color-accent)] shrink-0 mt-0.5" />
          <div>
            <p className="text-[12px] font-semibold text-[var(--color-text-primary)] leading-tight mb-0.5">
              {hint.title}
            </p>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-snug">{hint.body}</p>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 items-start opacity-40">
          <Info size={13} className="text-[var(--color-text-muted)] shrink-0 mt-0.5" />
          <p className="text-[11px] text-[var(--color-text-muted)] leading-snug italic">
            {lang === "es"
              ? "Haz clic en un campo para ver su descripción."
              : "Click any field to see its description."}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-start gap-1.5">
      <span className="text-[12px] text-[var(--color-text-muted)] pt-1.5 truncate">{label}</span>
      <div>{children}</div>
    </div>
  );
}

const inp =
  "w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] transition-colors";
