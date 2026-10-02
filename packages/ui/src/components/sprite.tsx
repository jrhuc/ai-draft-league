export function Sprite({
  id,
  name,
  size = 48,
}: {
  id: string;
  name: string;
  size?: 24 | 40 | 48 | 96;
}) {
  return (
    <img
      className="sprite"
      src={`/sprites/${id}.png`}
      alt={name}
      width={size}
      height={size}
      decoding="async"
      loading="lazy"
    />
  );
}
