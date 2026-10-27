import { assertRitual } from "./errors.mjs";

export function countLitCandles(state) {
  return state.candles.filter((candle) => candle.state === "lit").length;
}

export function assertRitualInvariants(state) {
  // Cross-field rules supplement the DataModel's per-field validation. Run them
  // before committing a command, when all of its changes can be checked together.
  assertRitual(Array.isArray(state.candles) && state.candles.length === 10, "INVALID_CANDLES", "A ritual requires ten candles.");
  assertRitual(new Set(state.candles.map((candle) => candle.id)).size === 10, "DUPLICATE_CANDLE_ID", "Candle identifiers must be unique.");
  assertRitual(new Set(state.candles.map((candle) => candle.position)).size === 10, "DUPLICATE_CANDLE_POSITION", "Candle positions must be unique.");
  assertRitual(state.dice.common >= 0 && state.dice.gm >= 0, "INVALID_DICE_POOL", "Dice pools cannot be negative.");
  assertRitual(state.dice.common + state.dice.gm <= 10, "INVALID_DICE_TOTAL", "Standard dice pools cannot exceed ten dice.");
  if (state.phase === "lastStand") {
    assertRitual(countLitCandles(state) === 1, "INVALID_LAST_STAND", "The Last Stand requires exactly one lit candle.");
  }
  return true;
}
