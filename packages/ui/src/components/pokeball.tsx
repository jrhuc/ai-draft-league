import { useId } from "react";

export function PokeBall({ size = 20, className = "" }: { size?: number; className?: string }) {
  const clip = useId();
  return (
    <svg
      className={`pokeball ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <clipPath id={clip}>
        <circle cx="12" cy="12" r="10.4" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect width="24" height="12" fill="var(--ball-red)" />
        <rect y="12" width="24" height="12" fill="#fff" />
        <rect y="10.7" width="24" height="2.6" fill="var(--ball-dark)" />
      </g>
      <circle cx="12" cy="12" r="10.4" fill="none" stroke="var(--ball-dark)" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.1" fill="var(--ball-dark)" />
      <circle cx="12" cy="12" r="1.7" fill="#fff" />
    </svg>
  );
}
