export const SYSTEM_ID = "ten-candles";

export const ACTOR_TYPES = Object.freeze({
  RITUAL: "session",
  SURVIVOR: "survivor",
  THEM: "them"
});

export const ITEM_TYPES = Object.freeze({
  TRAIT: "trait",
  MOMENT: "moment",
  BRINK: "brink"
});

export const RITUAL_PHASES = Object.freeze([
  "setup",
  "traits",
  "module",
  "concepts",
  "moments",
  "brinks",
  "stacks",
  "inventory",
  "recording",
  "scene",
  "truths",
  "lastStand",
  "epilogue",
  "ended"
]);

export const CARD_STATES = Object.freeze([
  "draft",
  "buried",
  "hidden",
  "active",
  "revealed",
  "burning",
  "burned"
]);
