export function Sprite({
  id,
  name,
  size = 48,
  className = "",
  eager = false,
}: {
  id: string | null;
  name: string;
  size?: 24 | 40 | 48 | 96;
  className?: string;
  eager?: boolean;
}) {
  if (!id) {
    return (
      <span
        className={`sprite-fallback ${className}`}
        style={{ width: size, height: size }}
        aria-label={name}
        role="img"
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className={`sprite ${className}`}
      src={`/sprites/${id}.png`}
      alt={name}
      width={size}
      height={size}
      decoding="async"
      loading={eager ? "eager" : "lazy"}
    />
  );
}
