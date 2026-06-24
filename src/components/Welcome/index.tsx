import { Terminal, Monitor, Download, FileInput } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../store/useI18nStore";
import { useIsLightTheme } from "../../store/usePrefsStore";

export function Welcome() {
  const { startNewConnection } = useAppStore();
  const t = useT();
  const light = useIsLightTheme();

  // Import flows live in the MenuBar (dialog + progress wiring); fire the same
  // events it listens for instead of duplicating that logic here.
  const importJson = () => window.dispatchEvent(new Event("orbitalterm:importJson"));
  const importMremoteng = () => window.dispatchEvent(new Event("orbitalterm:importMremoteng"));

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center p-8 bg-[var(--color-bg-base)] h-full">
      <div className="flex flex-col items-center gap-3">
        <img
          src={light ? "/logo_centro_light.svg" : "/logo_centro.svg"}
          alt="OrbitalTerm"
          className="h-36 w-auto object-contain select-none"
          draggable={false}
        />
        <p className="text-[var(--color-text-muted)] text-sm">
          {t("welcomeSubtitle")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-md">
        <ActionCard
          icon={<Terminal size={18} />}
          title={t("welcomeNewSsh")}
          desc={t("welcomeNewSshDesc")}
          onClick={() => startNewConnection(null, null, t("welcomeNewSsh"), "ssh")}
          accent
        />
        <ActionCard
          icon={<Monitor size={18} />}
          title={t("welcomeNewRdp")}
          desc={t("welcomeNewRdpDesc")}
          onClick={() => startNewConnection(null, null, t("welcomeNewRdp"), "rdp")}
        />
        <ActionCard
          icon={<Download size={18} />}
          title={t("welcomeImportOrbital")}
          desc={t("welcomeImportOrbitalDesc")}
          onClick={importJson}
        />
        <ActionCard
          icon={<FileInput size={18} />}
          title={t("welcomeImportMrng")}
          desc={t("welcomeImportMrngDesc")}
          onClick={importMremoteng}
        />
      </div>

      <p className="text-xs text-[var(--color-text-muted)] max-w-xs">
        {t("welcomeHint")}
      </p>
    </div>
  );
}

function ActionCard({
  icon, title, desc, onClick, accent = false,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex flex-col items-center gap-2 p-4 rounded-lg border text-center transition-colors",
        accent
          ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 hover:bg-[var(--color-accent)]/10 text-[var(--color-accent-hover)]"
          : "border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
      ].join(" ")}
    >
      {icon}
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-[10px] mt-0.5 opacity-70">{desc}</p>
      </div>
    </button>
  );
}
