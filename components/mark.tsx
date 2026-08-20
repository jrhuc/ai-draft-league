import { modelFamily, modelLabel, modelProvider } from "@/lib/format";

export function Mark({ spec, size = 14 }: { spec: string; size?: number }) {
  const family = modelFamily(spec);
  if (!family) {
    const letter = (modelLabel(spec).match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
    return (
      <span className="mark mark-mono" style={{ width: size, height: size }} aria-hidden="true">
        {letter}
      </span>
    );
  }
  return <img className="mark" src={`/logos/${family}.svg`} alt="" width={size} height={size} />;
}

export function Model({ spec }: { spec: string }) {
  const provider = modelProvider(spec);
  return (
    <span className="model" title={spec}>
      <Mark spec={spec} />
      {modelLabel(spec)}
      {provider ? <span style={{ color: "var(--t5)" }}>via {provider}</span> : null}
    </span>
  );
}
