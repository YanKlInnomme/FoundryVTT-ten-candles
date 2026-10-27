export function localizeError(error) {
  const code = error?.code;
  const specificKey = code ? `TENCANDLES.Errors.${code}` : null;
  if (specificKey && game.i18n.has?.(specificKey)) return game.i18n.localize(specificKey);
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  return game.i18n.localize("TENCANDLES.Common.ActionFailed");
}
