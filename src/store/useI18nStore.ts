import { create } from "zustand";

export type Lang = "es" | "en";

export const LANGS: { value: Lang; label: string }[] = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
];

const T = {
  es: {
    // Menu bar
    menuFile: "Archivo",
    menuView: "Ver",
    menuTools: "Herramientas",
    menuHelp: "Ayuda",
    // File menu
    newConnection: "Nueva Conexión",
    newFolder: "Nueva Carpeta",
    newDataSource: "Nueva fuente de datos…",
    importConnections: "Importar conexiones…",
    exportConnections: "Exportar conexiones…",
    exit: "Salir",
    // View menu
    fullscreen: "Pantalla Completa",
    showHideSidebar: "Mostrar/Ocultar Sidebar",
    // Tools menu
    language: "Idioma",
    theme: "Tema",
    termFontSize: "Tamaño de fuente (terminal)",
    resetLayout: "Restablecer disposición",
    // Help menu
    about: "Acerca de OrbitalTerm",
    website: "Sitio Web",
    donate: "Donar",
    checkUpdates: "Comprobar Actualizaciones",
    reportBug: "Reportar un error",
    // About dialog
    aboutDesc: "Todas tus conexiones remotas en un mismo espacio de trabajo.",
    version: "Versión",
    close: "Cerrar",
    developer: "Desarrollado por OrbitalTerm",
    // Messages
    importedOk: "conexión(es) importada(s).",
    exportedOk: "Archivo exportado correctamente.",
    checkUpdatesMsg: "Revisando la última versión en GitHub…",
    // Sidebar / UI
    connections: "Conexiones",
    searchPlaceholder: "Buscar por nombre o IP…",
    noResults: "Sin resultados",
    results: "resultado(s)",
    navHint: "↑↓ navegar · Enter abrir",
    noConnectionsYet: "Sin conexiones aún.",
    addFirst: "Agrega la primera",
    newConnectionMenu: "Nueva Conexión",
    newSubfolder: "Nueva Subcarpeta",
    rename: "Renombrar",
    delete: "Eliminar",
    connect: "Conectar",
    duplicate: "Duplicar",
    // Properties panel
    propNewConnection: "Nueva Conexión",
    propProperties: "Propiedades",
    propConnect: "Conectar",
    propSave: "Guardar",
    propSaving: "Guardando…",
    propRequired: "Nombre, host y usuario son obligatorios.",
    propType: "Tipo",
    propName: "Nombre",
    propDesc: "Descripción",
    propHost: "Host / IP",
    propPort: "Puerto",
    propUser: "Usuario",
    propAuth: "Autent.",
    propSshKey: "Llave SSH",
    propPassword: "Contraseña",
    propPasswordSaved: "●●●●●●",
    propPasswordPlaceholder: "",
    propDomain: "Dominio",
    propNotes: "Notas",
    propSelectOrCreate: "Selecciona una conexión o haz clic en + para crear una",
    propUrl: "URL",
    propCustomHosts: "Hosts personalizados",
    // Welcome
    welcomeSubtitle: "Todas tus conexiones remotas en un mismo espacio de trabajo",
    welcomeNewSsh: "Nueva SSH",
    welcomeNewSshDesc: "Conectar a un servidor Linux / Unix",
    welcomeNewRdp: "Nuevo RDP",
    welcomeNewRdpDesc: "Conectar a un servidor Windows",
    welcomeImport: "Importar",
    welcomeImportDesc: "Importar desde JSON o mRemoteNG",
    welcomeHint: "Haz doble clic en una conexión para abrirla. Todos los datos se guardan localmente.",
    // Export dialog
    exportDialogTitle: "Seleccionar grupos a exportar",
    exportSelectAll: "Seleccionar todo",
    exportDeselectAll: "Deseleccionar todo",
    exportRootConnections: "Conexiones raíz (sin carpeta)",
    exportWithPasswords: "Exportar con contraseñas",
    exportWithoutPasswords: "Exportar sin contraseñas",
    exportNothingSelected: "Selecciona al menos un grupo.",
    exportedNConn: "conexión(es) exportada(s).",
    // Group management
    newGroup: "Nueva Base de Datos",
    renameGroup: "Renombrar",
    deleteGroup: "Eliminar",
    deleteGroupConfirm: "¿Eliminar este grupo y todo su contenido?",
    groupNamePlaceholder: "Nombre del grupo…",
    // Connection states
    connRetry: "Reintentar",
    connReconnect: "Reconectar",
    connReconnecting: "Reconectando…",
    connSessionEnded: "Sesión finalizada",
    // RDP pane
    rdpLaunching: "Iniciando cliente RDP…",
    rdpSessionExternal: "Sesión RDP activa en ventana externa",
    rdpExternalHint: "El cliente RDP fue iniciado. Ciérralo para finalizar la sesión o usa Reconectar para abrir una nueva ventana.",
    rdpNoPasswordTitle: "Contraseña no guardada",
    rdpNoPasswordDesc: "Para conectarte en modo embebido necesitás guardar la contraseña. Cerrá esta pestaña, seleccioná la conexión en el sidebar, ingresá la contraseña en Propiedades y guardá.",
    rdpMissingClientTitle: "Cliente RDP no instalado",
    rdpInstallCmd: "Comando de instalación",
    rdpInstallHint: "Después de instalar, haz clic en Reintentar.",
    // VNC pane
    vncConnecting: "Conectando a VNC…",
    vncDisconnected: "Sesión VNC desconectada",
    vncConnError: "Error de conexión VNC",
    // SSH terminal inline
    sshConnecting: "Conectando a",
    sshConnFailed: "Conexión fallida",
    sshConnClosed: "Conexión cerrada",
    sshSessionResumed: "Sesión retomada",
    sshConnNotFound: "Conexión no encontrada.",
  },
  en: {
    menuFile: "File",
    menuView: "View",
    menuTools: "Tools",
    menuHelp: "Help",
    newConnection: "New Connection",
    newFolder: "New Folder",
    newDataSource: "New data source…",
    importConnections: "Import connections…",
    exportConnections: "Export connections…",
    exit: "Exit",
    fullscreen: "Fullscreen",
    showHideSidebar: "Show/Hide Sidebar",
    language: "Language",
    theme: "Theme",
    termFontSize: "Terminal font size",
    resetLayout: "Reset layout",
    about: "About OrbitalTerm",
    website: "Website",
    donate: "Donate",
    checkUpdates: "Check for Updates",
    reportBug: "Report a bug",
    aboutDesc: "All your remote connections in one workspace.",
    version: "Version",
    close: "Close",
    developer: "Developed by OrbitalTerm",
    importedOk: "connection(s) imported.",
    exportedOk: "File exported successfully.",
    checkUpdatesMsg: "Checking for the latest version on GitHub…",
    connections: "Connections",
    searchPlaceholder: "Search by name or IP…",
    noResults: "No results",
    results: "result(s)",
    navHint: "↑↓ navigate · Enter open",
    noConnectionsYet: "No connections yet.",
    addFirst: "Add the first one",
    newConnectionMenu: "New Connection",
    newSubfolder: "New Subfolder",
    rename: "Rename",
    delete: "Delete",
    connect: "Connect",
    duplicate: "Duplicate",
    propNewConnection: "New Connection",
    propProperties: "Properties",
    propConnect: "Connect",
    propSave: "Save",
    propSaving: "Saving…",
    propRequired: "Name, host and username are required.",
    propType: "Type",
    propName: "Name",
    propDesc: "Description",
    propHost: "Host / IP",
    propPort: "Port",
    propUser: "Username",
    propAuth: "Auth",
    propSshKey: "SSH Key",
    propPassword: "Password",
    propPasswordSaved: "●●●●●●",
    propPasswordPlaceholder: "",
    propDomain: "Domain",
    propNotes: "Notes",
    propSelectOrCreate: "Select a connection or click + to create one",
    propUrl: "URL",
    propCustomHosts: "Custom hosts",
    welcomeSubtitle: "All your remote connections in one workspace",
    welcomeNewSsh: "New SSH",
    welcomeNewSshDesc: "Connect to a Linux / Unix server",
    welcomeNewRdp: "New RDP",
    welcomeNewRdpDesc: "Connect to a Windows server",
    welcomeImport: "Import",
    welcomeImportDesc: "Import from JSON or mRemoteNG",
    welcomeHint: "Double-click any connection to open it as a tab. All data is stored locally.",
    // Export dialog
    exportDialogTitle: "Select groups to export",
    exportSelectAll: "Select all",
    exportDeselectAll: "Deselect all",
    exportRootConnections: "Root connections (no folder)",
    exportWithPasswords: "Export with passwords",
    exportWithoutPasswords: "Export without passwords",
    exportNothingSelected: "Select at least one group.",
    exportedNConn: "connection(s) exported.",
    // Group management
    newGroup: "New Database",
    renameGroup: "Rename",
    deleteGroup: "Delete",
    deleteGroupConfirm: "Delete this group and all its contents?",
    groupNamePlaceholder: "Group name…",
    // Connection states
    connRetry: "Retry",
    connReconnect: "Reconnect",
    connReconnecting: "Reconnecting…",
    connSessionEnded: "Session ended",
    // RDP pane
    rdpLaunching: "Launching RDP client…",
    rdpSessionExternal: "RDP session active in external window",
    rdpExternalHint: "The RDP client was launched. Close it to end the session, or use Reconnect to open a new window.",
    rdpNoPasswordTitle: "Password not saved",
    rdpNoPasswordDesc: "To connect in embedded mode you need to save the password. Close this tab, select the connection in the sidebar, enter the password in Properties and save.",
    rdpMissingClientTitle: "No RDP client installed",
    rdpInstallCmd: "Install command",
    rdpInstallHint: "After installing, click Retry below.",
    // VNC pane
    vncConnecting: "Connecting to VNC…",
    vncDisconnected: "VNC session disconnected",
    vncConnError: "VNC connection error",
    // SSH terminal inline
    sshConnecting: "Connecting to",
    sshConnFailed: "Connection failed",
    sshConnClosed: "Connection closed",
    sshSessionResumed: "Session resumed",
    sshConnNotFound: "Connection not found.",
  },
} as const;

export type TranslationKey = keyof typeof T.es;

interface I18nStore {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: TranslationKey) => string;
}

export const useI18nStore = create<I18nStore>((set, get) => ({
  lang: (localStorage.getItem("orbitalterm:lang") as Lang | null) ?? "es",
  setLang: (lang) => {
    localStorage.setItem("orbitalterm:lang", lang);
    set({ lang });
  },
  t: (k) => T[get().lang][k] as string,
}));

export function useT() {
  // Destructure lang so this hook re-renders when lang changes
  const { lang, t } = useI18nStore();
  void lang;
  return t;
}
