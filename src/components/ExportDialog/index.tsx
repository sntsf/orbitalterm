import { useState } from "react";
import { save as dialogSave } from "@tauri-apps/plugin-dialog";
import { Check, Download, X } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../store/useI18nStore";
import { exportSelectedToFile } from "../../lib/commands";

interface Props {
  onClose: () => void;
  onDone: (msg: string, ok: boolean) => void;
}

export function ExportDialog({ onClose, onDone }: Props) {
  const t = useT();
  const { groups } = useAppStore();

  // Selection state: group IDs
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    () => new Set(groups.map((g) => g.id))
  );

  const allSelected = selectedGroups.size === groups.length;

  const toggleGroup = (id: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedGroups(new Set());
    } else {
      setSelectedGroups(new Set(groups.map((g) => g.id)));
    }
  };

  const nothingSelected = selectedGroups.size === 0;

  const doExport = async (includePasswords: boolean) => {
    if (nothingSelected) return;
    try {
      const path = await dialogSave({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "orbitalterm-connections.json",
      });
      if (!path) return;
      const count = await exportSelectedToFile(
        Array.from(selectedGroups),
        includePasswords,
        path,
      );
      onClose();
      onDone(`${count} ${t("exportedNConn")}`, true);
    } catch (err) {
      onDone(String(err), false);
    }
  };

  return (
    <div
      className="rdp-pierce fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--color-bg-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl w-96 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t("exportDialogTitle")}
          </span>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Group list */}
        <div className="px-4 py-3 space-y-1 max-h-72 overflow-y-auto">
          {/* Select all / deselect all */}
          <button
            onClick={toggleAll}
            className="text-[10px] text-[var(--color-accent)] hover:underline mb-2 block"
          >
            {allSelected ? t("exportDeselectAll") : t("exportSelectAll")}
          </button>

          {/* Groups */}
          {groups.map((g) => (
            <CheckRow
              key={g.id}
              label={g.name}
              checked={selectedGroups.has(g.id)}
              onChange={() => toggleGroup(g.id)}
            />
          ))}

          {groups.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)] py-4 text-center">
              {t("noConnectionsYet")}
            </p>
          )}
        </div>

        {/* Error hint */}
        {nothingSelected && (
          <p className="px-4 text-[10px] text-[var(--color-danger)]">
            {t("exportNothingSelected")}
          </p>
        )}

        {/* Actions */}
        <div className="px-4 py-3 flex gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <button
            onClick={() => doExport(false)}
            disabled={nothingSelected}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs
              bg-[var(--color-bg-hover)] hover:bg-[var(--color-border)] text-[var(--color-text-primary)]
              transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={12} />
            {t("exportWithoutPasswords")}
          </button>
          <button
            onClick={() => doExport(true)}
            disabled={nothingSelected}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs
              bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
              transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={12} />
            {t("exportWithPasswords")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors text-left"
    >
      <span
        className={[
          "w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors",
          checked
            ? "bg-[var(--color-accent)] border-[var(--color-accent)]"
            : "border-[var(--color-border)] bg-transparent",
        ].join(" ")}
      >
        {checked && <Check size={10} className="text-white" />}
      </span>
      <span className="text-xs text-[var(--color-text-primary)]">{label}</span>
    </button>
  );
}
