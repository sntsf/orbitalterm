import { useState } from "react";
import { KeyRound, Eye, EyeOff } from "lucide-react";
import { masterCreate, masterChange, masterVerify } from "../../lib/commands";
import { useMasterStore } from "../../store/useMasterStore";
import { useI18nStore } from "../../store/useI18nStore";

// Create / change / unlock the master password (the "view lock" for revealing
// connection passwords). Driven by useMasterStore so both the File menu and the
// password eye button can open it.
export function MasterPasswordDialog() {
  const { dialogMode, closeDialog, setUnlocked, pendingAfterUnlock } = useMasterStore();
  const { lang } = useI18nStore();
  const es = lang === "es";

  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [unlockPw, setUnlockPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!dialogMode) return null;

  const reset = () => {
    setOldPw(""); setNewPw(""); setConfirmPw(""); setUnlockPw("");
    setShow(false); setError(""); setBusy(false);
  };
  const close = () => { reset(); closeDialog(); };

  const title =
    dialogMode === "create" ? (es ? "Crear contraseña maestra" : "Create master password")
    : dialogMode === "change" ? (es ? "Cambiar contraseña maestra" : "Change master password")
    : (es ? "Desbloquear contraseñas" : "Unlock passwords");

  const submit = async () => {
    setError("");
    try {
      setBusy(true);
      if (dialogMode === "create") {
        if (newPw.length < 4) { setError(es ? "Mínimo 4 caracteres." : "At least 4 characters."); return; }
        if (newPw !== confirmPw) { setError(es ? "Las contraseñas no coinciden." : "Passwords don't match."); return; }
        await masterCreate(newPw);
        setUnlocked(true);
        close();
      } else if (dialogMode === "change") {
        if (newPw.length < 4) { setError(es ? "Mínimo 4 caracteres." : "At least 4 characters."); return; }
        if (newPw !== confirmPw) { setError(es ? "Las contraseñas no coinciden." : "Passwords don't match."); return; }
        await masterChange(oldPw, newPw);
        setUnlocked(true);
        close();
      } else {
        const ok = await masterVerify(unlockPw);
        if (!ok) { setError(es ? "Contraseña maestra incorrecta." : "Incorrect master password."); return; }
        setUnlocked(true);
        const after = pendingAfterUnlock;
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
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
      >
        {show ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-96 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <KeyRound size={14} className="text-[var(--color-accent)]" />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
        </div>
        <div className="px-4 py-4 flex flex-col gap-2.5">
          {dialogMode === "change" && field(oldPw, setOldPw, es ? "Contraseña maestra actual" : "Current master password", true)}
          {(dialogMode === "create" || dialogMode === "change") && (
            <>
              {field(newPw, setNewPw, es ? "Nueva contraseña maestra" : "New master password", dialogMode === "create")}
              {field(confirmPw, setConfirmPw, es ? "Repite la nueva contraseña" : "Repeat new password")}
            </>
          )}
          {dialogMode === "unlock" && field(unlockPw, setUnlockPw, es ? "Contraseña maestra" : "Master password", true)}

          {dialogMode === "create" && (
            <p className="text-[10px] text-[var(--color-text-muted)] leading-snug">
              {es
                ? "Si la olvidas, las conexiones seguirán funcionando, pero no podrás revelar contraseñas. Se puede resetear borrando el archivo master.lock."
                : "If you forget it, connections keep working but you can't reveal passwords. It can be reset by deleting master.lock."}
            </p>
          )}
          {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
        </div>
        <div className="px-4 pb-4 flex justify-end gap-2">
          <button
            onClick={close}
            className="px-4 py-1.5 rounded text-xs bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors"
          >
            {es ? "Cancelar" : "Cancel"}
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-4 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-40"
          >
            {dialogMode === "unlock" ? (es ? "Desbloquear" : "Unlock") : (es ? "Guardar" : "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
