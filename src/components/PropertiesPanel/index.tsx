import { useEffect, useRef, useState } from "react";
import { Plug, Eye, EyeOff, Info, Database, Folder as FolderIcon, type LucideIcon } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT, useI18nStore } from "../../store/useI18nStore";
import { useImportStore } from "../../store/useImportStore";
import { useMasterStore } from "../../store/useMasterStore";
import {
  updateConnection,
  getConnections,
  savePassword,
  deletePassword,
  getPassword,
  groupMasterStatus,
  hasPassword,
  updateFolder,
  getFolders,
  updateGroup,
  getGroups,
} from "../../lib/commands";
import type { AuthType, ConnectionType } from "../../types";
import { CONN_ICONS, DEFAULT_CONN_ICON, ConnIconDisplay, type ConnIconKey } from "../../lib/connIcons";
import { ICON_COLORS, iconColorClass } from "../../lib/folderColors";

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

// Sentinel shown in the password field when a password is already saved: eight
// real, deletable bullet characters (not a placeholder). The actual stored
// password is never loaded into the UI. A value that is only bullets is treated
// as "unchanged" on blur, so an untouched field never overwrites what's saved.
const PWD_DOTS = "••••••••";
const isAllDots = (s: string) => s.length > 0 && /^•+$/.test(s);

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

// Router: the panel shows whichever of connection / folder / group is selected.
export function PropertiesPanel() {
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const selectedGroupId = useAppStore((s) => s.selectedGroupId);
  if (selectedFolderId) return <FolderProperties folderId={selectedFolderId} />;
  if (selectedGroupId) return <GroupProperties groupId={selectedGroupId} />;
  return <ConnectionProperties />;
}

function ConnectionProperties() {
  const t = useT();
  const { lang } = useI18nStore();
  const {
    connections,
    selectedConnectionId,
    setConnections,
    openTab,
  } = useAppStore();

  const { sidebarHint, groups } = useAppStore();
  const { isUnlocked: isGroupUnlocked, openDialog: openMasterDialog } = useMasterStore();
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
  const [notes, setNotes] = useState("");
  const [groupId, setGroupId] = useState("");
  const [icon, setIcon] = useState<string>("");
  const [url, setUrl] = useState("");
  const [customHosts, setCustomHosts] = useState("");
  const [tunnels, setTunnels] = useState("");
  const [proxyJump, setProxyJump] = useState("");
  const [rdpRedirectDrives, setRdpRedirectDrives] = useState(false);
  const [rdpDrivePath, setRdpDrivePath] = useState("");
  const [rdpGateway, setRdpGateway] = useState("");
  const [connectError, setConnectError] = useState("");
  const [focusedField, setFocusedField] = useState<FieldKey | null>(null);

  // Skip the first auto-save effect run when populating fields from a new selection
  const skipSaveRef = useRef(false);

  // Always-current save function (avoids stale closures in setTimeout)
  const doSaveRef = useRef<() => Promise<void>>();
  doSaveRef.current = async () => {
    if (!existing) return;
    try {
      await updateConnection({
        ...existing,
        name: name.trim() || existing.name,
        description: description.trim(),
        type,
        host: host.trim(),
        port,
        username: username.trim(),
        domain: domain.trim(),
        auth_type: authType,
        key_path: keyPath.trim(),
        folder_id: folderId || null,
        notes,
        group_id: groupId,
        icon,
        url: url.trim(),
        custom_hosts: customHosts,
        tunnels,
        proxy_jump: proxyJump.trim(),
        rdp_redirect_drives: rdpRedirectDrives,
        rdp_drive_path: rdpDrivePath,
        rdp_gateway: rdpGateway.trim(),
      });
      setConnections(await getConnections());
    } catch (err) {
      console.error("[auto-save]", err);
    }
  };

  // Populate fields when selected connection changes
  useEffect(() => {
    if (!existing) return;
    skipSaveRef.current = true;
    setName(existing.name);
    setDescription(existing.description);
    setType(existing.type);
    setHost(existing.host);
    setPort(existing.port);
    setUsername(existing.username);
    setDomain(existing.domain);
    setAuthType(existing.auth_type);
    setKeyPath(existing.key_path);
    setFolderId(existing.folder_id ?? "");
    setGroupId(existing.group_id ?? "");
    setNotes(existing.notes);
    setIcon(existing.icon || DEFAULT_CONN_ICON[existing.type]);
    setUrl(existing.url ?? "");
    setCustomHosts(existing.custom_hosts ?? "");
    setTunnels(existing.tunnels ?? "");
    setProxyJump(existing.proxy_jump ?? "");
    setRdpRedirectDrives(existing.rdp_redirect_drives ?? false);
    setRdpDrivePath(existing.rdp_drive_path ?? "");
    setRdpGateway(existing.rdp_gateway ?? "");
    setPassword("");
    setConnectError("");
    if (existing.auth_type === "password") {
      hasPassword(existing.id).then((has) => {
        setHasSaved(has);
        // Show eight deletable dots when a password is stored; empty otherwise.
        setPassword(has ? PWD_DOTS : "");
      }).catch(() => setHasSaved(false));
    } else {
      setHasSaved(false);
    }
  }, [existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced auto-save: fires 600ms after the last field change
  useEffect(() => {
    if (!existing) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    const timer = setTimeout(() => { doSaveRef.current?.(); }, 600);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, host, port, username, domain, authType, keyPath, type, folderId, groupId, notes, icon, url, customHosts, tunnels, proxyJump, rdpRedirectDrives, rdpDrivePath, rdpGateway]);

  const handleTypeChange = (newType: ConnectionType) => {
    setType(newType);
    setPort(DEFAULT_PORTS[newType]);
    const supportedAuth = AUTH_FOR_TYPE[newType];
    if (supportedAuth.length === 0) setAuthType("password");
    else if (!supportedAuth.includes(authType)) setAuthType(supportedAuth[0]);
    setIcon((prev) => {
      const oldDefault = DEFAULT_CONN_ICON[type];
      if (!prev || prev === oldDefault) return DEFAULT_CONN_ICON[newType];
      return prev;
    });
  };

  // Password is saved on blur (not on debounce) to avoid saving on every keystroke.
  //  • only-dots (untouched sentinel)  → keep the stored password as-is
  //  • empty                            → delete the stored password
  //  • anything else                    → save it, then show the dots again
  const handlePasswordBlur = async () => {
    if (!existing) return;
    const val = password;
    if (isAllDots(val)) return;
    try {
      if (val === "") {
        if (hasSaved) await deletePassword(existing.id);
        setHasSaved(false);
        return;
      }
      await savePassword(existing.id, val);
      setHasSaved(true);
      setPassword(PWD_DOTS);
    } catch (err) {
      console.error("[save-password]", err);
    }
  };

  // Auth type change: delete saved password when switching away from password auth
  const handleAuthTypeChange = async (newAuth: AuthType) => {
    setAuthType(newAuth);
    if (newAuth !== "password" && existing) {
      await deletePassword(existing.id).catch(() => {});
      setHasSaved(false);
      setPassword("");
    }
  };

  const handleConnect = () => {
    if (!existing) return;
    setConnectError("");
    openTab(existing);
  };

  if (!existing) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)] text-xs px-4 text-center">
          {t("propSelectOrCreate")}
        </div>
        <HintBox hint={sidebarHint} hintLang={lang === "es" ? "es" : "en"} />
      </div>
    );
  }

  const authLabels: Record<AuthType, string> = {
    password: "Password",
    key: "Key File",
    agent: "Agent",
  };

  const supportedAuthTypes = AUTH_FOR_TYPE[type];
  const showAuthSection = supportedAuthTypes.length > 1 || (supportedAuthTypes.length === 1 && supportedAuthTypes[0] !== "password");
  const showDomain = type === "rdp";
  const showPasswordField = authType === "password";
  const showKeyField = authType === "key";

  const hintLang = lang === "es" ? "es" : "en";
  const hint = focusedField ? HINTS[hintLang][focusedField] : sidebarHint;
  const focus = (f: FieldKey) => () => setFocusedField(f);
  const blur = () => setFocusedField(null);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-0.5 border-b border-[var(--color-border)] shrink-0">
        <span className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">
          {t("propProperties")}
        </span>
        <button
          type="button"
          onClick={handleConnect}
          title={t("propConnect")}
          className="flex items-center gap-1 px-2 py-px rounded text-[12px] text-[var(--color-success)] hover:bg-[var(--color-success)]/10 transition-colors"
        >
          <Plug size={13} />
          {t("propConnect")}
        </button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-3 py-1 space-y-1 min-h-0">
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
            <select value={authType} onChange={(e) => handleAuthTypeChange(e.target.value as AuthType)}
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
                onBlur={handlePasswordBlur}
                placeholder=""
                onFocus={focus("password")}
                className={inp + " pr-7"}
              />
              <button
                type="button"
                onClick={async () => {
                  // Hiding is always allowed.
                  if (showPassword) { setShowPassword(false); return; }
                  // Reveal: fetch the real decrypted value (if the field still
                  // shows the saved-password sentinel) and show it.
                  const doReveal = async () => {
                    if (existing && isAllDots(password)) {
                      try {
                        const real = await getPassword(existing.id);
                        if (real) setPassword(real);
                      } catch { /* ignore */ }
                    }
                    setShowPassword(true);
                  };
                  // Per-data-source view lock: a connection's passwords can only
                  // be revealed when its data source has a master password and it
                  // has been unlocked this session.
                  const gid = existing?.group_id ?? "";
                  const gname = groups.find((g) => g.id === gid)?.name ?? "";
                  const set = await groupMasterStatus(gid).catch(() => false);
                  if (!set) {
                    openMasterDialog({ mode: "require", groupId: gid, groupName: gname });
                    return;
                  }
                  if (!isGroupUnlocked(gid)) {
                    openMasterDialog({ mode: "unlock", groupId: gid, groupName: gname, afterUnlock: () => { void doReveal(); } });
                    return;
                  }
                  await doReveal();
                }}
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

        {type === "rdp" && (
          <>
            <Row label="RD Gateway">
              <input value={rdpGateway} onChange={(e) => setRdpGateway(e.target.value)}
                placeholder={lang === "es" ? "host del gateway (opcional)" : "gateway host (optional)"}
                className={inp} />
            </Row>
            <Row label={lang === "es" ? "Carpeta / Unidades" : "Folder / Drives"}>
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-primary)] cursor-pointer">
                <input type="checkbox" checked={rdpRedirectDrives}
                  onChange={(e) => setRdpRedirectDrives(e.target.checked)} />
                {lang === "es" ? "Compartir carpeta / discos con el remoto" : "Share a folder / drives with the remote"}
              </label>
            </Row>
            {rdpRedirectDrives && (
              <Row label={lang === "es" ? "Carpeta a montar" : "Folder to mount"}>
                <div className="flex flex-col gap-1">
                  <input value={rdpDrivePath} onChange={(e) => setRdpDrivePath(e.target.value)}
                    placeholder={lang === "es" ? "vacío = Descargas" : "empty = Downloads"}
                    className={inp} />
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {lang === "es"
                      ? "Linux: carpeta local compartida como unidad. En Windows se comparten los discos locales. Reinicia la conexión para aplicar."
                      : "Linux: local folder shared as a drive. On Windows the local disks are shared. Reconnect to apply."}
                  </span>
                </div>
              </Row>
            )}
          </>
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

        {(type === "ssh" || type === "sftp") && (
          <Row label={lang === "es" ? "Bastión" : "Jump host"}>
            <input value={proxyJump} onChange={(e) => setProxyJump(e.target.value)}
              placeholder="[usuario@]host[:puerto]"
              className={inp} />
          </Row>
        )}

        {(type === "ssh" || type === "sftp") && (
          <Row label={lang === "es" ? "Túneles" : "Tunnels"}>
            <textarea
              value={tunnels}
              onChange={(e) => setTunnels(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder={lang === "es"
                ? "Uno por línea:\nL 8080 db.interna 5432\nR 9000 localhost 3000\nD 1080  (proxy SOCKS5)"
                : "One per line:\nL 8080 db.internal 5432\nR 9000 localhost 3000\nD 1080  (SOCKS5 proxy)"}
              className={inp + " resize-none font-mono text-[11px]"}
            />
          </Row>
        )}

        {connectError && <p className="text-[var(--color-danger)] text-[11px]">{connectError}</p>}
      </div>

      {/* Contextual hint */}
      <HintBox hint={hint} hintLang={hintLang} />
    </div>
  );
}

function HintBox({ hint, hintLang: _hintLang }: { hint: { title: string; body: string } | null; hintLang: "es" | "en" }) {
  const t = useT();
  const importProgress = useImportStore((s) => s.progress);

  // While a (potentially large) mRemoteNG import runs in the background, the
  // info box doubles as a live progress indicator.
  if (importProgress) {
    const { name, done, total } = importProgress;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-base)] px-3 py-1.5 h-[92px] flex items-center">
        <div className="flex gap-2.5 items-center">
          <ProgressRing pct={pct} indeterminate={total === 0} />
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-[var(--color-text-primary)] leading-tight mb-0.5 flex items-center gap-1">
              <Database size={12} className="text-[var(--color-accent)] shrink-0" />
              <span className="truncate">{t("importingDb")}</span>
            </p>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-snug truncate">
              {name} · {done}{total > 0 ? `/${total}` : ""} {t("importConnsCount")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg-base)] px-3 py-1.5 h-[92px]">
      {hint ? (
        <div className="flex gap-2 h-full">
          <Info size={13} className="text-[var(--color-accent)] shrink-0 mt-0.5" />
          <div className="overflow-y-auto pr-1 min-w-0">
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
            {t("hintClickField")}
          </p>
        </div>
      )}
    </div>
  );
}

function ProgressRing({ pct, indeterminate }: { pct: number; indeterminate?: boolean }) {
  const size = 36, stroke = 4, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className={indeterminate ? "animate-spin" : ""} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="var(--color-accent)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={indeterminate ? circ * 0.75 : offset}
          style={{ transition: indeterminate ? "none" : "stroke-dashoffset 0.2s ease" }}
        />
      </svg>
      {!indeterminate && (
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-[var(--color-text-primary)]">
          {pct}%
        </span>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_1fr] items-start gap-1">
      <span className="text-[11px] text-[var(--color-text-muted)] pt-0.5 truncate">{label}</span>
      <div>{children}</div>
    </div>
  );
}

const inp =
  "w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-2 py-px text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] transition-colors";

// ── Folder / Group properties ──────────────────────────────────────────────────

function FolderProperties({ folderId }: { folderId: string }) {
  const folders = useAppStore((s) => s.folders);
  const setFolders = useAppStore((s) => s.setFolders);
  const folder = folders.find((f) => f.id === folderId);
  return (
    <ItemEditor
      key={folderId}
      missing={!folder}
      Icon={FolderIcon}
      defaultColorKey="amber"
      initial={{ name: folder?.name ?? "", description: folder?.description ?? "", color: folder?.color ?? "" }}
      onSave={async (n, d, c) => {
        if (!folder) return;
        await updateFolder(folder.id, n, d, c);
        setFolders(await getFolders());
      }}
    />
  );
}

function GroupProperties({ groupId }: { groupId: string }) {
  const groups = useAppStore((s) => s.groups);
  const setGroups = useAppStore((s) => s.setGroups);
  const group = groups.find((g) => g.id === groupId);
  return (
    <ItemEditor
      key={groupId}
      missing={!group}
      Icon={Database}
      defaultColorKey="blue"
      initial={{ name: group?.name ?? "", description: group?.description ?? "", color: group?.color ?? "" }}
      onSave={async (n, d, c) => {
        if (!group) return;
        await updateGroup(group.id, n, d, c);
        setGroups(await getGroups());
      }}
    />
  );
}

// Shared editor for folders and connection databases. Remounted per item (via
// `key`), so it initialises from `initial` once and never clobbers in-progress
// edits when the list refetches after a save.
function ItemEditor({
  missing, Icon, defaultColorKey, initial, onSave,
}: {
  missing: boolean;
  Icon: LucideIcon;
  defaultColorKey: string;
  initial: { name: string; description: string; color: string };
  onSave: (name: string, description: string, color: string) => Promise<void>;
}) {
  const t = useT();
  const { lang } = useI18nStore();
  const sidebarHint = useAppStore((s) => s.sidebarHint);

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [color, setColor] = useState(initial.color || defaultColorKey);
  const firstRun = useRef(true);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  // Debounced auto-save, skipping the initial mount.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const timer = setTimeout(() => {
      saveRef.current(name.trim() || initial.name, description.trim(), color).catch(console.error);
    }, 600);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, color]);

  const hintLang = lang === "es" ? "es" : "en";

  if (missing) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)] text-xs px-4 text-center">
          {t("propSelectOrCreate")}
        </div>
        <HintBox hint={sidebarHint} hintLang={hintLang} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-0.5 border-b border-[var(--color-border)] shrink-0">
        <Icon size={13} className="text-[var(--color-text-muted)] shrink-0" />
        <span className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)] font-medium">
          {t("propProperties")}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-1 space-y-1 min-h-0">
        <Row label={t("propName")}>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inp} />
        </Row>
        <Row label={t("propColor")}>
          <div className="flex items-center gap-2">
            <Icon size={20} className={iconColorClass(color)} />
            <select value={color} onChange={(e) => setColor(e.target.value)} className={inp}>
              {ICON_COLORS.map((c) => (
                <option key={c.key} value={c.key}>
                  {lang === "es" ? c.label_es : c.label_en}
                </option>
              ))}
            </select>
          </div>
        </Row>
        <Row label={t("propDesc")}>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            placeholder="…" className={inp + " resize-none"} />
        </Row>
      </div>

      <HintBox hint={sidebarHint} hintLang={hintLang} />
    </div>
  );
}
