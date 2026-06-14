// Map raw SFTP/FTP errors to a short, friendly message. Shared by the SSH
// side-panel browser, the standalone SFTP dual-pane, and the FTP browser so
// permission/missing-folder errors read the same everywhere.
export function friendlyFsError(err: unknown): string {
  const s = String(err).toLowerCase();
  if (
    s.includes("permission denied") || s.includes("permission") || s.includes("eacces") ||
    s.includes("access is denied") || s.includes("550") || s.includes("530")
  ) {
    return "Sin permiso para acceder a esta carpeta.";
  }
  if (
    s.includes("no such file") || s.includes("does not exist") || s.includes("not found") ||
    s.includes("no existe")
  ) {
    return "La carpeta no existe o no es accesible.";
  }
  return String(err);
}
