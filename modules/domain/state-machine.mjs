import { assertRitual } from "./errors.mjs";

// Allowed edges, not a chronological list: truths can lead back to a scene or
// forward to the finale. module/concepts/inventory retain older preparation
// paths; the current flow goes from stacks directly to recording.
export const PHASE_TRANSITIONS = Object.freeze({
  setup: ["traits"],
  traits: ["moments"],
  moments: ["brinks"],
  brinks: ["stacks"],
  stacks: ["recording"],
  concepts: ["inventory"],
  module: ["traits"],
  inventory: ["recording"],
  recording: ["scene"],
  scene: ["truths"],
  truths: ["scene", "lastStand", "epilogue"],
  lastStand: ["epilogue"],
  epilogue: ["ended"],
  ended: []
});

export function assertPhaseTransition(from, to) {
  assertRitual(
    PHASE_TRANSITIONS[from]?.includes(to),
    "INVALID_PHASE_TRANSITION",
    `Cannot move a ritual from ${from} to ${to}.`
  );
}

export function nextPreparationPhase(phase) {
  const transitions = PHASE_TRANSITIONS[phase] ?? [];
  assertRitual(
    transitions.length === 1 && !["scene", "truths", "lastStand", "epilogue"].includes(phase),
    "PHASE_REQUIRES_SPECIFIC_COMMAND",
    `Phase ${phase} cannot be advanced with the generic preparation command.`
  );
  return transitions[0];
}
