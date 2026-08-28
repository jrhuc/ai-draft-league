import { modelFamily, modelLabel, modelProvider } from "@/lib/format";

export function Mark({
  spec,
  size = 14,
  tone = false,
}: {
  spec: string;
  size?: number | string;
  tone?: boolean;
}) {
  const family = modelFamily(spec);
  const toneClass = tone ? " mark-tone" : "";
  if (!family) {
    const letter = (modelLabel(spec).match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
    return (
      <span
        className={`mark mark-mono${toneClass}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {letter}
      </span>
    );
  }
  return (
    <span
      className={`mark${toneClass}`}
      style={{ width: size, height: size, maskImage: `url(/logos/${family}.svg)` }}
      aria-hidden="true"
    />
  );
}

export function Model({ spec }: { spec: string }) {
  const provider = modelProvider(spec);
  return (
    <span className="model" title={spec}>
      {modelLabel(spec)}
      {provider ? <span style={{ color: "var(--t5)" }}>via {provider}</span> : null}
    </span>
  );
}
