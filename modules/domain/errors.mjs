export class RitualCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RitualCommandError";
    this.code = code;
  }
}

export function assertRitual(condition, code, message) {
  if (!condition) throw new RitualCommandError(code, message);
}
