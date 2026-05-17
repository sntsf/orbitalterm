import { MonitorDot, FolderInput, FolderLock } from "lucide-react";

interface IconProps {
  size?: number;
  className?: string;
}

export function TuxIcon({ size = 12, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="Linux"
    >
      {/* Tux silhouette — simplified penguin shape */}
      <ellipse cx="12" cy="7" rx="5" ry="6" />
      <ellipse cx="12" cy="16" rx="6" ry="7" />
      <ellipse cx="12" cy="15" rx="4" ry="5.5" fill="var(--color-bg-base, #0f1117)" />
      <circle cx="10" cy="6" r="1" fill="var(--color-bg-base, #0f1117)" />
      <circle cx="14" cy="6" r="1" fill="var(--color-bg-base, #0f1117)" />
      <ellipse cx="12" cy="8.5" rx="1.5" ry="1" fill="var(--color-bg-base, #0f1117)" />
      <ellipse cx="7" cy="17" rx="2" ry="3.5" />
      <ellipse cx="17" cy="17" rx="2" ry="3.5" />
    </svg>
  );
}

export function WindowsIcon({ size = 12, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-label="Windows"
    >
      {/* Windows 4-square logo */}
      <rect x="2" y="2" width="9" height="9" rx="1" />
      <rect x="13" y="2" width="9" height="9" rx="1" />
      <rect x="2" y="13" width="9" height="9" rx="1" />
      <rect x="13" y="13" width="9" height="9" rx="1" />
    </svg>
  );
}

export function VncIcon({ size = 12, className = "" }: IconProps) {
  return <MonitorDot size={size} className={className} />;
}

export function FtpIcon({ size = 12, className = "" }: IconProps) {
  return <FolderInput size={size} className={className} />;
}

export function SftpIcon({ size = 12, className = "" }: IconProps) {
  return <FolderLock size={size} className={className} />;
}
