import { useState } from "react";
import { KeyRound, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { groupMasterCreate, groupMasterChange, groupMasterVerify } from "../../lib/commands";
import { useMasterStore } from "../../store/useMasterStore";
import { useT } from "../../store/useI18nStore";

// Create / change / unlock a data source's master password (the per-BD "view
// lock" for revealing connection passwords). Driven by useMasterStore so the
// File menu, the data-source context menu and the password eye can all open it.
export function MasterPasswordDialog() {
  const { dialog, closeDialog, markUnlocked, openDialog } = useMasterStore();
  const t = useT();

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
  const ti = (k: Parameters<typeof t>[0]) => t(k).replace("{bd}", bd);
  const title =
    mode === "create" ? ti("mpTitleCreate")
    : mode === "change" ? ti("mpTitleChange")
    : mode === "unlock" ? ti("mpTitleUnlock")
    : t("mpTitleProtected");

  const submit = async () => {
    setError("");
    try {
      setBusy(true);
      if (mode === "create" || mode === "change") {
        if (newPw.length < 4) { setError(t("mpMin4")); return; }
        if (newPw !== confirmPw) { setError(t("mpNoMatch")); return; }
        if (mode === "create") await groupMasterCreate(groupId, newPw);
        else await groupMasterChange(groupId, oldPw, newPw);
        markUnlocked(groupId);
        close();
      } else if (mode === "unlock") {
        const ok = await groupMasterVerify(groupId, unlockPw);
        if (!ok) { setError(t("mpIncorrect")); return; }
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

  const warning = ti("mpWarning");

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
              {ti("mpRequireNotice")}
            </p>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-snug">
              {t("mpRequireHint")}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={close}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors">
                {t("close")}
              </button>
              <button onClick={() => openDialog({ mode: "create", groupId, groupName })}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors">
                {t("mpCreateNow")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-4 flex flex-col gap-2.5">
              {mode === "change" && field(oldPw, setOldPw, t("mpCurrentPh"), true)}
              {(mode === "create" || mode === "change") && (
                <>
                  {field(newPw, setNewPw, t("mpNewPh"), mode === "create")}
                  {field(confirmPw, setConfirmPw, t("mpRepeatPh"))}
                  <div className="flex gap-2 mt-0.5">
                    <AlertTriangle size={24} className="text-[var(--color-warning)] shrink-0" />
                    <p className="text-[10px] text-[var(--color-text-muted)] leading-snug">{warning}</p>
                  </div>
                </>
              )}
              {mode === "unlock" && field(unlockPw, setUnlockPw, t("mpMasterPh"), true)}
              {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
            </div>
            <div className="px-4 pb-4 flex justify-end gap-2">
              <button onClick={close}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] hover:bg-[var(--color-border)] transition-colors">
                {t("mpCancel")}
              </button>
              <button onClick={submit} disabled={busy}
                className="px-4 py-1.5 rounded text-xs bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-40">
                {mode === "unlock" ? t("mpUnlock") : t("propSave")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
