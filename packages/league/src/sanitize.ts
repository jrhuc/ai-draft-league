export function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const secret of secrets) {
    if (secret && secret !== "none") redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.slice(0, 2000);
}
