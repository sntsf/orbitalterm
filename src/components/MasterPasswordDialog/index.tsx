import { useState } from "react";
import { KeyRound, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { groupMasterCreate, groupMasterChange, groupMasterVerify } from "../../lib/commands";
import { useMasterStore } from "../../store/useMasterStore";
import { useI18nStore } from "../../store/useI18nStore";

// Create / change / unlock a data source's master password (the per-BD "view
// lock" for revealing connection passwords). Driven by useMasterStore so the
// File menu, the data-source context menu and the password eye can all open it.
export function MasterPasswordDialog() {
  const { dialog, closeDialog, markUnlocked, openDialog } = useMasterStore();
  const { lang } = useI18nStore();
  const es = lang === "es";

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [unlockPw, setUnlockPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!dialog) return null;
  const { mode, groupId, groupName } = dialog;

  const reset = () => {
    setOldPw(""); setNewPw(""); setConfirmPw(""); setUnlockPw("");
    setShow(false); setError(""); setBusy(false);
  };
  const close = () => { reset(); closeDialog(); };

  const bd = `"${groupName}"`;
  const title =
    mode === "create" ? (es ? `Crear contraseña maestra · BD ${bd}` : `Create master password · DB ${bd}`)
    : mode === "change" ? (es ? `Cambiar contraseña maestra · BD ${bd}` : `Change master password · DB ${bd}`)
    : mode === "unlock" ? (es ? `Desbloquear · BD ${bd}` : `Unlock · DB ${bd}`)
    : (es ? "Contraseñas protegidas" : "Passwords are protected");

  const submit = async () => {
    setError("");
    try {
      setBusy(true);
      if (mode === "create" || mode === "change") {
        if (newPw.length < 4) { setError(es ? "Mínimo 4 caracteres." : "At least 4 characters."); return; }
        if (newPw !== confirmPw) { setError(es ? "Las contraseñas no coinciden." : "Passwords don't match."); return; }
        if (mode === "create") await groupMasterCreate(groupId, newPw);
        else await groupMasterChange(groupId, oldPw, newPw);
        markUnlocked(groupId);
        close();
      } else if (mode === "unlock") {
        const ok = await groupMasterVerify(groupId, unlockPw);
        if (!ok) { setError(es ? "Contraseña maestra incorrecta." : "Incorrect master password."); return; }
        markUnlocked(groupId);
        const after = dialog.afterUnlock;
        close();
        after?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-3 py-1.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)] pr-8";

  const field = (value: string, setter: (v: string) => void, placeholder: string, autoFocus = false) => (
    <div className="relative">
      <input
        autoFocus={autoFocus}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => setter(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") close(); }}
        placeholder={placeholder}
        className={inputCls}
      />
      <button type="button" onClick={() => setShow((s) => !s)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
        {show ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </div>
  );

  const warning = es
    ? `Guarda muy bien esta contraseña maestra. Protege la visualización de las contraseñas de la BD ${bd}. Si la olvidas no se puede recuperar: tendrás que eliminar esta fuente de datos y volver a crearla (perderás sus conexiones) para poder ver contraseñas de nuevo. Las conexiones seguirán funcionando aunque la olvides; solo no podrás revelar sus contraseñas.`
    : `Store this master password safely. It protects viewing the passwords of DB ${bd}. If you forget it there is no recovery: you'll have to delete this data source and recreate it (losing its connections) to view passwords again. Connections keep working even if you forget it — you just won't be able to reveal their passwords.`;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-[26rem] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <KeyRound size={14} className="text-[var(--color-accent)]" />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
        </div>

        {mode === "require" ? (
          <div className="px-4 py-4 flex flex-col gap-3">
            <p className="text-[12px] text-[var(--color-text-primary)] leading-relaxed">
              {es
                ? `Para ver las contraseñas de la BD ${bd} primero debes crear una contraseña maestra para esta fuente de datos. Así evitas que cualquier persona sin autorización pueda verlas.`
                : `To view passwords in DB ${bd} you must first create a master password for this data source. This prevents anyone without authorization from viewing them.`}
            </p>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-snug">
              {es
                ? "Puedes crearla aquí, o desde Archivo → Crear contraseña maestra, o con clic derecho sobre la fuente de datos."
                : "Create it here, or from File → Create master password, or by right-clicking the data source."}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={close}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors">
                {es ? "Cerrar" : "Close"}
              </button>
              <button onClick={() => openDialog({ mode: "create", groupId, groupName })}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors">
                {es ? "Crear ahora" : "Create now"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-4 flex flex-col gap-2.5">
              {mode === "change" && field(oldPw, setOldPw, es ? "Contraseña maestra actual" : "Current master password", true)}
              {(mode === "create" || mode === "change") && (
                <>
                  {field(newPw, setNewPw, es ? "Nueva contraseña maestra" : "New master password", mode === "create")}
                  {field(confirmPw, setConfirmPw, es ? "Repite la nueva contraseña" : "Repeat new password")}
                  <div className="flex gap-2 mt-0.5">
                    <AlertTriangle size={24} className="text-[var(--color-warning)] shrink-0" />
                    <p className="text-[10px] text-[var(--color-text-muted)] leading-snug">{warning}</p>
                  </div>
                </>
              )}
              {mode === "unlock" && field(unlockPw, setUnlockPw, es ? "Contraseña maestra" : "Master password", true)}
              {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
            </div>
            <div className="px-4 pb-4 flex justify-end gap-2">
              <button onClick={close}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors">
                {es ? "Cancelar" : "Cancel"}
              </button>
              <button onClick={submit} disabled={busy}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-40">
                {mode === "unlock" ? (es ? "Desbloquear" : "Unlock") : (es ? "Guardar" : "Save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
