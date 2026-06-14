// Decide which of the dropped/selected local paths to actually upload, asking
// once if any target filename already exists in the destination folder.
// Cancel = skip the conflicting ones (upload only the new files).
export function resolveUploadOverwrites(localPaths: string[], existingNames: Set<string>): string[] {
  const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const conflicts = localPaths.filter((p) => existingNames.has(baseName(p)));
  if (conflicts.length === 0) return localPaths;

  const ok = window.confirm(
    conflicts.length === 1
      ? `Ya existe "${baseName(conflicts[0])}" en esta carpeta. ¿Sobrescribir?`
      : `Ya existen ${conflicts.length} archivos en esta carpeta. ¿Sobrescribir?\n(Cancelar sube solo los que no existen.)`
  );
  if (ok) return localPaths;

  const conflictSet = new Set(conflicts);
  return localPaths.filter((p) => !conflictSet.has(p));
}
