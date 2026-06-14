import { useState } from "react";
import { ArrowUp, ArrowDown, Check, X, RotateCw, ChevronDown, ChevronUp, Loader } from "lucide-react";
import { useTransferStore } from "../../store/useTransferStore";
import { useI18nStore } from "../../store/useI18nStore";

function pct(j: { transferred: number; total: number }) {
  return j.total > 0 ? Math.min(100, Math.round((j.transferred / j.total) * 100)) : 0;
}

export function TransferPanel() {
  const jobs = useTransferStore((s) => s.jobs);
  const clearDone = useTransferStore((s) => s.clearDone);
  const retry = useTransferStore((s) => s.retry);
  const remove = useTransferStore((s) => s.remove);
  const { lang } = useI18nStore();
  const es = lang === "es";
  const [collapsed, setCollapsed] = useState(false);

  if (jobs.length === 0) return null;

  const pending = jobs.filter((j) => j.status === "queued" || j.status === "active").length;
  const failed = jobs.filter((j) => j.status === "error").length;
  const title = pending > 0
    ? (es ? `Transfiriendo · ${pending} en cola` : `Transferring · ${pending} queued`)
    : (es ? "Transferencias" : "Transfers");

  return (
    <div className="fixed bottom-2 right-2 z-[9998] w-72 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-xl overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        {pending > 0 ? <Loader size={11} className="animate-spin text-[var(--color-accent)]" /> : <Check size={11} className="text-[var(--color-success)]" />}
        <span className="text-[11px] font-medium text-[var(--color-text-primary)] flex-1 truncate">{title}</span>
        {failed > 0 && <span className="text-[10px] text-[var(--color-danger)]">{failed} ✕</span>}
        <button onClick={() => setCollapsed((v) => !v)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button onClick={clearDone} title={es ? "Limpiar completadas" : "Clear completed"}
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X size={12} /></button>
      </div>

      {!collapsed && (
        <div className="max-h-56 overflow-y-auto">
          {jobs.map((j) => (
            <div key={j.id} className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--color-border)]/50 last:border-0">
              {j.dir === "up" ? <ArrowUp size={11} className="text-[var(--color-accent)] shrink-0" /> : <ArrowDown size={11} className="text-cyan-400 shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-[var(--color-text-primary)] truncate leading-tight">{j.label}</div>
                {j.status === "active" && (
                  <div className="h-0.5 mt-0.5 bg-[var(--color-border)] rounded overflow-hidden">
                    <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct(j)}%` }} />
                  </div>
                )}
                {j.status === "error" && <div className="text-[10px] text-[var(--color-danger)] truncate leading-tight">{j.error}</div>}
              </div>
              {j.status === "queued" && <span className="text-[9px] text-[var(--color-text-muted)]">⋯</span>}
              {j.status === "active" && <span className="text-[9px] text-[var(--color-accent)]">{pct(j)}%</span>}
              {j.status === "done" && <Check size={11} className="text-[var(--color-success)] shrink-0" />}
              {j.status === "error" && (
                <button onClick={() => retry(j.id)} title={es ? "Reintentar" : "Retry"}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><RotateCw size={11} /></button>
              )}
              {(j.status === "done" || j.status === "error") && (
                <button onClick={() => remove(j.id)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><X size={11} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
