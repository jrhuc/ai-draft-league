import { useEffect, useState } from "react";
import { z } from "zod";
import { spriteKey } from "@/lib/format";

type Manifest = { sheet: string; icons: Record<string, number> };

let cached: Manifest | null = null;
let pending: Promise<Manifest | null> | null = null;

const manifestSchema = z.strictObject({
  sheet: z.string().regex(/^\/sprites\/[a-z0-9-]+\.png$/u),
  icons: z.record(z.string(), z.number().int().nonnegative()),
});

async function fetchManifest(): Promise<Manifest | null> {
  try {
    const response = await fetch("/itemicons.json");
    if (!response.ok) return null;
    const value: unknown = await response.json();
    const parsed = manifestSchema.safeParse(value);
    if (!parsed.success) return null;
    const manifest: Manifest = parsed.data;
    cached = manifest;
    return manifest;
  } catch {
    return null;
  }
}

function useItemIcons(): Manifest | null {
  const [manifest, setManifest] = useState(cached);
  useEffect(() => {
    if (manifest) return;
    let live = true;
    pending ??= fetchManifest();
    void pending.then((loaded) => {
      if (live && loaded) setManifest(loaded);
    });
    return () => {
      live = false;
    };
  }, [manifest]);
  return manifest;
}

/** 24x24 cells, 16 per row, matching the Showdown teambuilder item sheet. */
export function ItemIcon({ item }: { item: string }) {
  const manifest = useItemIcons();
  const num = manifest?.icons[spriteKey(item)];
  if (manifest === null || num === undefined) return null;
  return (
    <span
      className="item-icon"
      aria-hidden="true"
      style={{
        backgroundImage: `url(${manifest.sheet})`,
        backgroundPosition: `${-(num % 16) * 24}px ${-Math.floor(num / 16) * 24}px`,
      }}
    />
  );
}
