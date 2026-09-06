export function replayPositionPath(
  seriesId: string,
  game: number,
  turn: number,
  seat: string,
): string {
  const search = new URLSearchParams({ game: String(game), turn: String(turn), seat });
  return `/matches/${seriesId}?${search}#turn-${turn}`;
}
