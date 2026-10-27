// Rule transitions operate on plain data, without Foundry documents or DOM.
// SocketService authenticates the issuer; this engine validates the state,
// returns a new snapshot and describes cross-document work as domain events.
import { assertRitual } from "./errors.mjs";
import { assertRitualInvariants, countLitCandles } from "./invariants.mjs";
import { assertPhaseTransition, nextPreparationPhase } from "./state-machine.mjs";

const MAX_RECENT_COMMANDS = 50;

function cloneState(state) {
  return structuredClone(state);
}

function now(context) {
  return context.now ?? Date.now();
}

function random(context) {
  return context.random?.() ?? Math.random();
}

function lightRange(state, start, end, timestamp, context = {}) {
  // Sample the lifetime once at ignition. The injected RNG/clock makes tests
  // deterministic; remaining burn time is tracked separately from wall time.
  for (let index = start; index <= end; index += 1) {
    const candle = state.candles[index];
    assertRitual(candle.state === "unlit", "CANDLE_ALREADY_TOUCHED", `${candle.id} can no longer be lit.`);
    candle.state = "lit";
    candle.litAt = timestamp;
    candle.lifetimeMinutes = 180 + Math.floor(random(context) * 121);
    candle.elapsedBurnMinutes = 0;
    candle.expiresAt = null;
    candle.lastRiskCheckAt = timestamp;
  }
}

function rollDice(count, context) {
  return Array.from({ length: count }, () => 1 + Math.floor(random(context) * 6));
}

function assessConflict(state) {
  // Success and narration are separate outcomes. Hope succeeds on 5 or 6,
  // whereas only sixes compete with the GM for narration ownership.
  const conflict = state.conflict;
  const standardSuccesses = conflict.playerResults.filter((result) => result === 6).length;
  const hopeSuccesses = conflict.hopeResults.filter((result) => result >= 5).length;
  const hopeSixes = conflict.hopeResults.filter((result) => result === 6).length;
  const gmSixes = conflict.gmResults.filter((result) => result === 6).length;
  conflict.success = standardSuccesses + hopeSuccesses > 0;
  conflict.narrationOwner = conflict.success && standardSuccesses + hopeSixes > gmSixes ? "player" : "gm";
  const reactions = [];
  if (conflict.activeCardType === "trait" && !conflict.traitRerolled
    && !(state.scene.traitBurnedActorIds ?? []).includes(conflict.activeActorId)
    && conflict.playerResults.includes(1)) reactions.push("trait");
  if (conflict.activeCardType === "brink" && (!conflict.success || conflict.narrationOwner === "gm")) reactions.push("brink");
  if (conflict.success && conflict.narrationOwner === "gm") reactions.push("seize");
  if (conflict.dire && !conflict.success) reactions.push("sacrifice");
  if (conflict.themInvolved && conflict.themBrinkItemId && !conflict.gmBrinkUsed
    && conflict.gmDiceCount > 0 && conflict.narrationOwner === "player") reactions.push("themBrink");
  conflict.availableReactions = reactions;
}

function truthParticipantOrder(state, firstSpeakerUserId) {
  const seats = state.seating?.seats ?? [];
  const clockwise = [
    state.facilitatorUserId,
    ...seats.map((seat) => seat.userId)
  ].filter((userId, index, entries) => userId && entries.indexOf(userId) === index);
  if (!clockwise.length) return firstSpeakerUserId ? [firstSpeakerUserId] : [];
  // Worlds created before seating was introduced have no persisted participant
  // roster, so their conflict owner remains the best available source.
  if (!seats.length && firstSpeakerUserId && !clockwise.includes(firstSpeakerUserId)) {
    clockwise.unshift(firstSpeakerUserId);
  }
  // A Survivor can retain a stale playerUserId after its Foundry user has been
  // removed or replaced. Never inject that orphaned id into a truth round: no
  // connected client could take the turn and the ritual would be deadlocked.
  const firstIndex = clockwise.includes(firstSpeakerUserId)
    ? clockwise.indexOf(firstSpeakerUserId)
    : 0;
  return [...clockwise.slice(firstIndex), ...clockwise.slice(0, firstIndex)];
}

function beginTruthRound(state, firstSpeakerUserId, expectedCount) {
  const participantOrder = truthParticipantOrder(state, firstSpeakerUserId);
  return {
    expectedCount,
    spokenCount: 0,
    firstSpeakerUserId: participantOrder[0] ?? firstSpeakerUserId ?? null,
    currentSpeakerUserId: expectedCount > 1 ? (participantOrder[0] ?? firstSpeakerUserId ?? null) : null,
    participantOrder
  };
}

function markSurvivorDead(state, actorId) {
  state.deadSurvivorActorIds ??= [];
  if (actorId && !state.deadSurvivorActorIds.includes(actorId)) state.deadSurvivorActorIds.push(actorId);
}

function livingSurvivorIds(state) {
  const dead = new Set(state.deadSurvivorActorIds ?? []);
  return state.survivorActorIds.filter((actorId) => !dead.has(actorId));
}

function claimAllSurvivors(state, events, sceneNumber = state.scene.number) {
  const actorIds = livingSurvivorIds(state);
  actorIds.forEach((actorId) => markSurvivorDead(state, actorId));
  if (actorIds.length) events.push({ type: "survivors.claimedByDarkness", payload: { actorIds, sceneNumber } });
}

function prepareEpilogue(state, timestamp) {
  state.phase = "epilogue";
  state.truthRound = {
    expectedCount: 0,
    spokenCount: 0,
    firstSpeakerUserId: null,
    currentSpeakerUserId: null,
    participantOrder: []
  };
  state.scene.activePlayerUserId = null;
  state.epilogue = {
    stage: "awaitingFormula",
    currentRecordingIndex: -1,
    playbackActorIds: [],
    startedAt: timestamp,
    silenceStartedAt: null,
    finishedAt: null
  };
}

function beginTruthsAfterConflict(state, command, context, events, cause, candleId = null) {
  const candle = candleId
    ? state.candles.find((candidate) => candidate.id === candleId && candidate.state === "lit")
    : state.candles.find((candidate) => candidate.state === "lit");
  assertRitual(candle, "NO_LIT_CANDLE", "No lit candle remains.");
  candle.state = "extinguished";
  candle.extinguishedAt = now(context);
  candle.extinguishedBy = command.issuedBy;
  candle.cause = cause;
  state.scene.endedAt = now(context);
  const litCount = countLitCandles(state);
  state.phase = litCount === 0 ? "epilogue" : "truths";
  if (state.phase === "epilogue") {
    claimAllSurvivors(state, events);
    prepareEpilogue(state, now(context));
  }
  if (state.phase === "truths") {
    const firstSpeakerUserId = cause === "narration-seized" || cause === "conflict-failure"
      ? state.conflict.activeUserId
      : state.facilitatorUserId;
    state.truthRound = beginTruthRound(state, firstSpeakerUserId, litCount);
    appendTruth(state, {
      id: `${command.id}-opening`, kind: "ritual-opening", text: "These things are true. The world is dark.",
      speakerUserId: state.facilitatorUserId, createdAt: now(context)
    });
  }
  events.push({ type: "candle.extinguished", payload: { candleId: candle.id, cause, litCount } });
}

function openConflict(state, command, _context, events) {
  assertRitual(["scene", "lastStand"].includes(state.phase), "NOT_IN_SCENE", "Conflicts can only begin during a scene.");
  assertRitual(state.conflict.status === "idle", "CONFLICT_ALREADY_OPEN", "Resolve the current conflict first.");
  assertRitual(command.payload.activeUserId && command.payload.activeActorId, "ACTIVE_SURVIVOR_REQUIRED", "Choose the active Survivor.");
  assertRitual(
    (!state.survivorActorIds.length || state.survivorActorIds.includes(command.payload.activeActorId))
      && !state.deadSurvivorActorIds?.includes(command.payload.activeActorId),
    "LIVING_SURVIVOR_REQUIRED",
    "Choose a living Survivor from this ritual."
  );
  const activeCard = command.payload.activeCard ?? {};
  const momentDeclared = Boolean(command.payload.momentDeclared && activeCard.type === "moment");
  assertRitual(
    !command.payload.themInvolved || (command.payload.themActorId && command.payload.themBrinkItemId),
    "THEM_BRINK_UNAVAILABLE",
    "They cannot be involved without an available Brink."
  );
  state.scene.activePlayerUserId = command.payload.activeUserId;
  state.conflict = {
    id: command.id,
    status: "open",
    question: command.payload.question?.trim() ?? "",
    resolutionText: "",
    activeUserId: command.payload.activeUserId,
    activeActorId: command.payload.activeActorId,
    dire: Boolean(command.payload.dire),
    momentDeclared,
    activeItemId: activeCard.id ?? null,
    activeCardType: activeCard.type ?? null,
    activeCardKind: activeCard.kind ?? null,
    themInvolved: Boolean(command.payload.themInvolved),
    themActorId: command.payload.themActorId ?? null,
    themBrinkItemId: command.payload.themBrinkItemId ?? null,
    gmBrinkUsed: false,
    commonDiceCount: state.dice.common,
    availableHopeDiceCount: Math.max(0, Number(command.payload.availableHopeDiceCount) || 0),
    hopeDiceCount: 0,
    gmDiceCount: state.dice.gm,
    playerRolled: false,
    gmRolled: state.dice.gm === 0,
    playerResults: [], hopeResults: [], gmResults: [], success: false, narrationOwner: null, choosingNarrationCandle: false,
    availableReactions: [], traitRerolled: false, brinkEmbraced: false, endsScene: false, chosenCandleId: null, sacrificeActorId: null
  };
  events.push({ type: "conflict.opened", payload: { question: state.conflict.question, activeUserId: state.conflict.activeUserId, dire: state.conflict.dire } });
}

function openMomentConflict(state, command, context, events) {
  assertRitual(command.payload.momentDeclared === true, "MOMENT_REQUIRED", "This action requires an active Moment.");
  command.payload.dire = false;
  command.payload.themInvolved = false;
  openConflict(state, command, context, events);
}

function completeConflictRoll(state, events) {
  if (!state.conflict.playerRolled || !state.conflict.gmRolled) return;
  state.conflict.status = "rolled";
  assessConflict(state);
  events.push({ type: "conflict.rolled", payload: { success: state.conflict.success, narrationOwner: state.conflict.narrationOwner } });
}

function rollPlayerConflict(state, command, context, events) {
  assertRitual(state.conflict.status === "open", "CONFLICT_NOT_READY", "This conflict cannot be rolled now.");
  assertRitual(!state.conflict.playerRolled, "PLAYER_ALREADY_ROLLED", "The active player has already rolled.");
  const requestedHopeDice = Math.max(0, Number(command.payload.hopeDiceCount) || 0);
  assertRitual(
    requestedHopeDice === 0 || requestedHopeDice === state.conflict.availableHopeDiceCount,
    "INVALID_HOPE_DICE",
    "Choose either none or all of the active Survivor's Hope dice."
  );
  state.conflict.hopeDiceCount = requestedHopeDice;
  state.conflict.playerResults = command.payload.rolls?.player ?? rollDice(state.conflict.commonDiceCount, context);
  state.conflict.hopeResults = command.payload.rolls?.hope ?? rollDice(state.conflict.hopeDiceCount, context);
  state.conflict.playerRolled = true;
  events.push({ type: "conflict.playerRolled", payload: { activeUserId: state.conflict.activeUserId, hopeDiceCount: requestedHopeDice } });
  completeConflictRoll(state, events);
}

function rollGmConflict(state, command, context, events) {
  assertRitual(state.conflict.status === "open", "CONFLICT_NOT_READY", "This conflict cannot be rolled now.");
  assertRitual(state.conflict.playerRolled, "PLAYER_ROLL_REQUIRED", "Wait for the active player to roll first.");
  assertRitual(!state.conflict.gmRolled, "GM_ALREADY_ROLLED", "The GM has already rolled.");
  state.conflict.gmResults = command.payload.rolls?.gm ?? rollDice(state.conflict.gmDiceCount, context);
  state.conflict.gmRolled = true;
  events.push({ type: "conflict.gmRolled", payload: { gmDiceCount: state.conflict.gmDiceCount } });
  completeConflictRoll(state, events);
}

function cancelConflict(state, _command, _context, events) {
  assertRitual(state.conflict.status === "open", "CONFLICT_CANNOT_CANCEL", "Only an unrolled conflict can be cancelled.");
  events.push({ type: "conflict.cancelled", payload: { conflictId: state.conflict.id } });
  state.conflict.status = "idle";
  state.conflict.availableReactions = [];
  state.scene.activePlayerUserId = null;
}

function burnTrait(state, command, context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled" && conflict.availableReactions.includes("trait"), "TRAIT_UNAVAILABLE", "No active Trait can be burned now.");
  const rerolls = [...(command.payload.rerolls ?? rollDice(conflict.playerResults.filter((result) => result === 1).length, context))];
  conflict.playerResults = conflict.playerResults.map((result) => result === 1 ? rerolls.shift() : result);
  conflict.traitRerolled = true;
  state.scene.traitBurnedActorIds ??= [];
  state.scene.traitBurnedActorIds.push(conflict.activeActorId);
  assessConflict(state);
  events.push({ type: "card.burned", payload: { actorId: conflict.activeActorId, itemId: conflict.activeItemId, cardType: "trait", sceneNumber: state.scene.number } });
}

function embraceBrink(state, command, context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled" && conflict.availableReactions.includes("brink"), "BRINK_UNAVAILABLE", "The Brink cannot be embraced now.");
  conflict.playerResults = command.payload.rolls?.player ?? rollDice(conflict.commonDiceCount, context);
  conflict.hopeResults = command.payload.rolls?.hope ?? rollDice(conflict.hopeDiceCount, context);
  assessConflict(state);
  conflict.brinkEmbraced = true;
  if (!conflict.success) {
    conflict.availableReactions = [];
    conflict.endsScene = true;
    events.push({ type: "card.burned", payload: { actorId: conflict.activeActorId, itemId: conflict.activeItemId, cardType: "brink", sceneNumber: state.scene.number } });
    events.push({ type: "hope.lost", payload: { actorId: conflict.activeActorId } });
  }
  events.push({ type: "brink.embraced", payload: { success: conflict.success } });
}

function beginNarrationSeizure(state, _command, _context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled" && conflict.availableReactions.includes("seize"), "NARRATION_UNAVAILABLE", "Narration cannot be seized now.");
  conflict.choosingNarrationCandle = true;
  events.push({ type: "narration.candleSelectionStarted", payload: { activeUserId: conflict.activeUserId } });
}

function seizeNarration(state, command, context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled" && conflict.availableReactions.includes("seize") && conflict.choosingNarrationCandle, "NARRATION_UNAVAILABLE", "Narration candle selection is not active.");
  const candle = state.candles.find((candidate) => candidate.id === command.payload.candleId && candidate.state === "lit");
  assertRitual(candle, "CANDLE_NOT_LIT", "Choose one of the remaining lit candles.");
  conflict.narrationOwner = "player";
  conflict.endsScene = true;
  conflict.chosenCandleId = candle.id;
  conflict.choosingNarrationCandle = false;
  events.push({ type: "narration.seized", payload: { activeUserId: conflict.activeUserId, candleId: candle.id } });
  acceptConflict(state, { ...command, payload: { resolutionText: "" } }, context, events);
}

function useThemBrink(state, command, context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled" && conflict.availableReactions.includes("themBrink"), "THEM_BRINK_UNAVAILABLE", "Their Brink cannot be used now.");
  conflict.gmResults = command.payload.rerolls ?? rollDice(conflict.gmDiceCount, context);
  conflict.gmBrinkUsed = true;
  assessConflict(state);
  events.push({ type: "card.burned", payload: { actorId: conflict.themActorId, itemId: conflict.themBrinkItemId, cardType: "brink", sceneNumber: state.scene.number } });
  events.push({ type: "them.brinkUsed", payload: { success: conflict.success, narrationOwner: conflict.narrationOwner } });
}

function sacrificeSurvivor(state, command, _context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled" && conflict.availableReactions.includes("sacrifice"), "SACRIFICE_UNAVAILABLE", "This is not an unresolved dire conflict.");
  assertRitual(
    (!state.survivorActorIds.length || state.survivorActorIds.includes(command.payload.actorId))
      && !state.deadSurvivorActorIds?.includes(command.payload.actorId),
    "LIVING_SURVIVOR_REQUIRED",
    "Only a living Survivor from this ritual may make the sacrifice."
  );
  if (command.payload.recipientActorId) {
    assertRitual(
      command.payload.recipientActorId !== command.payload.actorId
        && (!state.survivorActorIds.length || state.survivorActorIds.includes(command.payload.recipientActorId))
        && !state.deadSurvivorActorIds?.includes(command.payload.recipientActorId),
      "INVALID_HOPE_RECIPIENT",
      "Hope may only pass to another living Survivor in this ritual."
    );
  }
  conflict.sacrificeActorId = command.payload.actorId;
  conflict.activeUserId = command.issuedBy;
  conflict.narrationOwner = "player";
  conflict.endsScene = true;
  conflict.availableReactions = [];
  markSurvivorDead(state, command.payload.actorId);
  events.push({ type: "survivor.sacrificed", payload: { actorId: command.payload.actorId, recipientActorId: command.payload.recipientActorId ?? null, sceneNumber: state.scene.number, narratedByUserId: command.issuedBy } });
}

function acceptConflict(state, command, _context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "rolled", "CONFLICT_NOT_ROLLED", "Roll the conflict before accepting its outcome.");
  conflict.resolutionText = command.payload.resolutionText?.trim() ?? "";
  conflict.status = "narrating";
  conflict.availableReactions = [];
  events.push({ type: "conflict.outcomeAccepted", payload: { conflictId: conflict.id, narrationOwner: conflict.narrationOwner } });
}

function finishConflictNarration(state, command, context, events) {
  const conflict = state.conflict;
  assertRitual(conflict.status === "narrating", "CONFLICT_NOT_NARRATING", "Accept the outcome before ending the narration.");
  const summary = cloneState(conflict);
  if (conflict.success) {
    const lost = conflict.playerResults.filter((result) => result === 1).length;
    state.dice.common = Math.max(0, state.dice.common - lost);
    state.dice.sidelinedThisScene += lost;
    if (conflict.momentDeclared) {
      events.push({ type: "card.burned", payload: { actorId: conflict.activeActorId, itemId: conflict.activeItemId, cardType: "moment", sceneNumber: state.scene.number, outcome: "hope" } });
      events.push({ type: "hope.gained", payload: { actorId: conflict.activeActorId } });
    }
  } else if (conflict.momentDeclared) {
    events.push({ type: "card.burned", payload: { actorId: conflict.activeActorId, itemId: conflict.activeItemId, cardType: "moment", sceneNumber: state.scene.number, outcome: "lost" } });
  }
  if (!conflict.success && state.phase === "lastStand") {
    const fallenActorId = conflict.sacrificeActorId ?? conflict.activeActorId;
    if (!state.deadSurvivorActorIds?.includes(fallenActorId)) {
      markSurvivorDead(state, fallenActorId);
      events.push({
        type: "survivor.fallen",
        payload: { actorId: fallenActorId, sceneNumber: state.scene.number, narratedByUserId: command.issuedBy }
      });
    }
    events.push({
      type: "lastStand.deathResolved",
      payload: { actorId: fallenActorId, remainingActorIds: livingSurvivorIds(state) }
    });
  } else if (!conflict.success || conflict.endsScene) {
    beginTruthsAfterConflict(state, command, context, events, conflict.endsScene && conflict.success ? "narration-seized" : "conflict-failure", conflict.chosenCandleId);
  }
  events.push({ type: "conflict.resolved", payload: summary });
  state.conflict.status = "idle";
  state.conflict.availableReactions = [];
  state.scene.activePlayerUserId = null;
}

function appendTruth(state, truth) {
  state.truths.push({
    id: truth.id,
    sceneNumber: state.scene.number,
    sequence: state.truths.length,
    kind: truth.kind,
    text: truth.text,
    speakerUserId: truth.speakerUserId ?? null,
    createdAt: truth.createdAt
  });
}

function debugRecording(state, command, context, events) {
  const seats = state.seating.seats.filter((seat) => seat.userId && seat.survivorActorId);
  assertRitual(seats.length > 0, "NO_SURVIVORS", "Seat at least one Survivor before testing recordings.");
  state.recording.entries = seats.map((seat) => state.recording.entries.find((entry) => entry.userId === seat.userId && entry.actorId === seat.survivorActorId) ?? {
    userId: seat.userId, actorId: seat.survivorActorId, mediaPath: null, textFallback: "", durationMs: null, recordedAt: null, source: null, status: "pending"
  });
  state.recording.sealed = false;
  state.recording.entries = state.recording.entries.map((entry) => ({ ...entry, status: entry.mediaPath ? "retake" : "pending" }));
  state.status = "active";
  state.facilitatorUserId ??= command.issuedBy;
  state.phase = "recording";
  state.conflict.status = "idle";
  state.conflict.availableReactions = [];
  state.scene.activePlayerUserId = null;
  events.push({ type: "debug.recordingOpened", payload: {} });
}

function debugPlayback(state, command, context, events) {
  assertRitual(state.recording.entries.some((entry) => entry.mediaPath), "AUDIO_REQUIRED", "Record at least one message before testing playback.");
  state.status = "active";
  state.recording.entries = state.recording.entries.map((entry) => ({ ...entry, status: entry.mediaPath ? "ready" : "skipped" }));
  state.recording.sealed = true;
  state.conflict.status = "idle";
  state.conflict.availableReactions = [];
  for (const candle of state.candles) {
    if (candle.state !== "lit") continue;
    Object.assign(candle, { state: "extinguished", extinguishedAt: now(context), extinguishedBy: command.issuedBy, cause: "debug" });
  }
  prepareEpilogue(state, now(context));
  confirmFinalFormula(state, command, context, events);
}

function activateRitual(state, command, context, events) {
  assertRitual(state.status === "draft" && state.phase === "setup", "RITUAL_ALREADY_STARTED", "This ritual has already started.");
  assertRitual(state.seating.seats.length === 0 || state.seating.locked, "SEATING_NOT_LOCKED", "Everyone must confirm their seat before the ritual begins.");
  assertPhaseTransition("setup", "traits");
  state.status = "active";
  state.phase = "traits";
  state.facilitatorUserId ??= command.issuedBy;
  lightRange(state, 0, 2, now(context), context);
  events.push({ type: "session.activated", payload: { phase: state.phase } });
  events.push({ type: "candles.lit", payload: { candleIds: state.candles.slice(0, 3).map((candle) => candle.id) } });
}

function configureSeating(state, command, _context, events) {
  assertRitual(Boolean(state.activeModuleItemId), "MODULE_REQUIRED", "Choose a Module before inviting players.");
  assertRitual(state.status === "draft" && state.phase === "setup", "SEATING_CLOSED", "Seating is already closed.");
  const userIds = [...new Set(command.payload.userIds ?? [])];
  assertRitual(userIds.length >= 2, "NOT_ENOUGH_PLAYERS", "At least two players must be invited.");
  state.seating = { locked: false, invitedUserIds: userIds, seats: userIds.map((_, position) => ({ position, userId: null, survivorActorId: null, ready: false })) };
  events.push({ type: "seating.configured", payload: { seatCount: userIds.length } });
}

function takeSeat(state, command, _context, events) {
  assertRitual(!state.seating.locked, "SEATING_LOCKED", "The seating arrangement is locked.");
  const { position, userId } = command.payload;
  assertRitual(state.seating.invitedUserIds.includes(userId), "PLAYER_NOT_INVITED", "This player is not invited to the table.");
  const destination = state.seating.seats.find((seat) => seat.position === position);
  assertRitual(destination && (!destination.userId || destination.userId === userId), "SEAT_OCCUPIED", "That chair is already occupied.");
  for (const seat of state.seating.seats) if (seat.userId === userId) Object.assign(seat, { userId: null, survivorActorId: null, ready: false });
  Object.assign(destination, { userId, survivorActorId: null, ready: false });
  events.push({ type: "seating.changed", payload: { position, userId } });
}

function confirmSeat(state, command, _context, events) {
  assertRitual(!state.seating.locked, "SEATING_LOCKED", "The seating arrangement is locked.");
  const seat = state.seating.seats.find((candidate) => candidate.userId === command.payload.userId);
  assertRitual(seat, "SURVIVOR_NOT_SEATED", "Choose a chair first.");
  seat.ready = Boolean(command.payload.ready);
  events.push({ type: "seating.ready", payload: { userId: seat.userId, ready: seat.ready } });
}

function lockSeating(state, _command, _context, events) {
  assertRitual(state.seating.seats.length > 0 && state.seating.seats.every((seat) => seat.userId && seat.ready), "SEATING_INCOMPLETE", "Every chair must be occupied and confirmed.");
  assertRitual(state.seating.seats.every((seat) => seat.survivorActorId), "SEATING_SURVIVORS_MISSING", "Every confirmed seat must have a Survivor before seating can be locked.");
  assertRitual(new Set(state.seating.seats.map((seat) => seat.survivorActorId)).size === state.seating.seats.length, "DUPLICATE_SEATED_SURVIVOR", "Each seat must have a different Survivor.");
  state.seating.locked = true;
  events.push({ type: "seating.locked", payload: { userIds: state.seating.seats.map((seat) => seat.userId) } });
}

function advancePreparation(state, _command, context, events) {
  // Readiness checks for the separate Survivor documents happen at the caller
  // boundary; this transition owns the session phase and recording turn list.
  assertRitual(state.status === "active", "RITUAL_NOT_ACTIVE", "The ritual is not active.");
  const previous = state.phase;
  assertRitual(previous !== "recording", "RECORDING_REQUIRES_SEAL", "Seal the messages, or explicitly skip them, before beginning the first scene.");
  const next = nextPreparationPhase(previous);
  state.phase = next;

  let newlyLit = [];
  if (next === "moments") {
    lightRange(state, 3, 5, now(context), context);
    newlyLit = state.candles.slice(3, 6).map((candle) => candle.id);
  }
  if (next === "brinks") {
    lightRange(state, 6, 8, now(context), context);
    newlyLit = state.candles.slice(6, 9).map((candle) => candle.id);
  }
  if (next === "recording") {
    lightRange(state, 9, 9, now(context), context);
    newlyLit = [state.candles[9].id];
    state.recording = {
      mode: "audio",
      sealed: false,
      playbackOrder: state.recording.playbackOrder ?? "death",
      entries: state.seating.seats.map((seat) => ({
        userId: seat.userId,
        actorId: seat.survivorActorId,
        mediaPath: null,
        textFallback: "",
        durationMs: null,
        recordedAt: null,
        source: null,
        status: "pending"
      }))
    };
  }
  if (next === "scene") {
    state.scene.number = 1;
    state.scene.startedAt = now(context);
    state.scene.endedAt = null;
    const litCount = countLitCandles(state);
    state.dice.common = litCount;
    state.dice.gm = 10 - litCount;
  }

  events.push({ type: "ritual.phaseChanged", payload: { from: previous, to: next } });
  if (newlyLit.length) events.push({ type: "candles.lit", payload: { candleIds: newlyLit } });
}

function submitRecording(state, command, context, events) {
  assertRitual(state.phase === "recording" && !state.recording.sealed, "RECORDING_CLOSED", "The recording circle is closed.");
  // A retake belongs to the player who requested it. Resolve that entry first:
  // using the first global pending entry could reject a valid replacement when
  // another participant is still waiting in the original recording round.
  const requestedRetake = state.recording.entries.find((entry) => entry.userId === command.issuedBy && entry.status === "retake");
  const current = requestedRetake ?? state.recording.entries.find((entry) => entry.status === "pending");
  assertRitual(current?.userId === command.issuedBy, "NOT_RECORDING_TURN", "Wait until the recorder reaches you.");
  assertRitual(command.payload.mediaPath, "AUDIO_REQUIRED", "Record or upload an audio message first.");
  Object.assign(current, {
    mediaPath: command.payload.mediaPath,
    durationMs: command.payload.durationMs ?? null,
    recordedAt: now(context),
    source: command.payload.source === "upload" ? "upload" : "microphone",
    status: "ready"
  });
  events.push({ type: "recording.submitted", payload: { userId: current.userId, actorId: current.actorId } });
}

function passRecording(state, command, context, events) {
  assertRitual(state.phase === "recording" && !state.recording.sealed, "RECORDING_CLOSED", "The recording circle is closed.");
  const requestedRetake = state.recording.entries.find((entry) => entry.userId === command.issuedBy && entry.status === "retake");
  const current = requestedRetake ?? state.recording.entries.find((entry) => entry.status === "pending");
  assertRitual(current?.userId === command.issuedBy, "NOT_RECORDING_TURN", "Wait until the recorder reaches you.");
  Object.assign(current, {
    mediaPath: null,
    textFallback: "",
    durationMs: null,
    recordedAt: now(context),
    source: null,
    status: "skipped"
  });
  events.push({ type: "recording.passed", payload: { userId: current.userId, actorId: current.actorId } });
}

function requestRecordingRetake(state, command, _context, events) {
  assertRitual(state.phase === "recording" && !state.recording.sealed, "RECORDING_CLOSED", "The recording circle is closed.");
  const entry = state.recording.entries.find((candidate) => candidate.userId === command.issuedBy);
  assertRitual(entry?.status === "ready", "RECORDING_NOT_READY", "Only a completed message can be recorded again.");
  entry.status = "retake";
  events.push({ type: "recording.retakeRequested", payload: { userId: entry.userId, actorId: entry.actorId } });
}

function sealRecordings(state, command, context, events) {
  assertRitual(state.phase === "recording", "NOT_RECORDING_PHASE", "Messages can only be sealed before the first scene.");
  assertRitual(state.recording.entries.length > 0 && state.recording.entries.every((entry) => ["ready", "skipped"].includes(entry.status)), "RECORDINGS_INCOMPLETE", "Every player must record a message or pass before the ritual begins.");
  state.recording.sealed = true;
  state.recording.mode = "audio";
  assertPhaseTransition("recording", "scene");
  state.phase = "scene";
  state.scene.number = 1;
  state.scene.startedAt = now(context);
  state.scene.endedAt = null;
  const litCount = countLitCandles(state);
  state.dice.common = litCount;
  state.dice.gm = 10 - litCount;
  events.push({ type: "recording.sealed", payload: { skipped: false, count: state.recording.entries.filter((entry) => entry.status === "ready").length } });
}

function skipRecordings(state, command, context, events) {
  assertRitual(state.phase === "recording", "NOT_RECORDING_PHASE", "The recording phase is not active.");
  state.recording.mode = "disabled";
  state.recording.sealed = true;
  assertPhaseTransition("recording", "scene");
  state.phase = "scene";
  state.scene.number = 1;
  state.scene.startedAt = now(context);
  state.scene.endedAt = null;
  const litCount = countLitCandles(state);
  state.dice.common = litCount;
  state.dice.gm = 10 - litCount;
  events.push({ type: "recording.sealed", payload: { skipped: true, count: 0 } });
}

function extinguishCandle(state, command, context, events) {
  assertRitual(state.phase === "scene", "NOT_IN_SCENE", "Candles can only be extinguished during a normal scene with this command.");
  const candle = state.candles.find((candidate) => candidate.id === command.payload.candleId);
  assertRitual(candle, "UNKNOWN_CANDLE", `Unknown candle ${command.payload.candleId}.`);
  assertRitual(candle.state === "lit", "CANDLE_NOT_LIT", `${candle.id} is not lit.`);

  candle.state = "extinguished";
  candle.extinguishedAt = now(context);
  candle.extinguishedBy = command.issuedBy;
  candle.cause = command.payload.cause;
  state.scene.endedAt = now(context);
  if (state.conflict?.status !== "idle") {
    events.push({ type: "conflict.interrupted", payload: { conflictId: state.conflict.id } });
    state.conflict.status = "idle";
    state.conflict.availableReactions = [];
  }

  const litCount = countLitCandles(state);
  assertRitual(litCount >= 1, "FINAL_CANDLE_REQUIRES_EPILOGUE", "The final candle cannot be extinguished with the normal scene command.");
  assertPhaseTransition("scene", "truths");
  state.phase = "truths";
  state.truthRound = beginTruthRound(
    state,
    command.payload.firstSpeakerUserId ?? command.issuedBy ?? state.facilitatorUserId,
    litCount
  );
  appendTruth(state, {
    id: `${command.id}-opening`,
    kind: "ritual-opening",
    text: "These things are true. The world is dark.",
    speakerUserId: state.facilitatorUserId,
    createdAt: now(context)
  });
  events.push({ type: "candle.extinguished", payload: { candleId: candle.id, cause: candle.cause, litCount } });
  events.push({ type: "truthRound.started", payload: { expectedCount: litCount } });
}

function expireCandle(state, command, context, events) {
  // The clock can strike during creation as well as play. Preparation loses a
  // candle/die but stays in its current step; during a scene extinction cuts off
  // any conflict and opens truths, and losing the final flame starts epilogue.
  const preparationPhases = ["traits", "moments", "brinks", "stacks", "concepts", "inventory", "recording"];
  assertRitual([...preparationPhases, "scene", "truths", "lastStand"].includes(state.phase), "CANDLE_CLOCK_INACTIVE", "Candle clocks only affect an active ritual.");
  const candle = state.candles.find((candidate) => candidate.id === command.payload.candleId);
  assertRitual(candle?.state === "lit", "CANDLE_NOT_LIT", "This candle is no longer lit.");
  const timestamp = now(context);
  candle.state = "extinguished";
  candle.extinguishedAt = timestamp;
  candle.extinguishedBy = null;
  candle.cause = command.payload.cause === "natural" ? "natural" : "accident";
  candle.lastRiskCheckAt = command.payload.checkedAt ?? timestamp;
  const litCount = countLitCandles(state);

  if (preparationPhases.includes(state.phase)) {
    const extinguishedCount = state.candles.filter((entry) => entry.state === "extinguished").length;
    state.dice.common = 10 - extinguishedCount;
    state.dice.gm = extinguishedCount;
    events.push({
      type: "candle.expired",
      payload: { candleId: candle.id, cause: candle.cause, litCount, final: false, duringPreparation: true }
    });
    return;
  }

  if (litCount === 0) {
    if (state.conflict?.status !== "idle") {
      events.push({ type: "conflict.interrupted", payload: { conflictId: state.conflict.id } });
      state.conflict.status = "idle";
      state.conflict.availableReactions = [];
    }
    claimAllSurvivors(state, events);
    prepareEpilogue(state, timestamp);
    state.scene.endedAt = timestamp;
    events.push({ type: "candle.expired", payload: { candleId: candle.id, cause: candle.cause, litCount, final: true } });
    events.push({ type: "epilogue.ready", payload: { recordingCount: state.recording.entries.length, cause: candle.cause } });
    return;
  }

  if (state.phase === "scene") {
    state.scene.endedAt = timestamp;
    if (state.conflict?.status !== "idle") {
      events.push({ type: "conflict.interrupted", payload: { conflictId: state.conflict.id } });
      state.conflict.status = "idle";
      state.conflict.availableReactions = [];
    }
    state.phase = "truths";
    state.truthRound = beginTruthRound(state, state.facilitatorUserId, litCount);
    appendTruth(state, {
      id: `${command.id}-opening`,
      kind: "ritual-opening",
      text: "These things are true. The world is dark.",
      speakerUserId: state.facilitatorUserId,
      createdAt: timestamp
    });
  } else {
    state.truthRound.expectedCount = Math.max(state.truthRound.spokenCount + 1, state.truthRound.expectedCount - 1);
  }
  events.push({ type: "candle.expired", payload: { candleId: candle.id, cause: candle.cause, litCount, final: false } });
}

function extinguishFinalCandle(state, command, context, events) {
  assertRitual(state.phase === "lastStand", "NOT_LAST_STAND", "The final candle can only be extinguished during the Last Stand.");
  assertRitual(livingSurvivorIds(state).length === 0, "SURVIVORS_REMAIN", "The final candle remains until every Survivor has fallen.");
  const candle = state.candles.find((candidate) => candidate.state === "lit");
  assertRitual(candle, "NO_LIT_CANDLE", "No final candle remains.");
  candle.state = "extinguished";
  candle.extinguishedAt = now(context);
  candle.extinguishedBy = command.issuedBy;
  candle.cause = "last-survivor-fallen";
  prepareEpilogue(state, now(context));
  state.scene.endedAt = now(context);
  state.conflict.status = "idle";
  state.conflict.availableReactions = [];
  events.push({ type: "candle.extinguished", payload: { candleId: candle.id, cause: candle.cause, litCount: 0, final: true } });
  events.push({ type: "epilogue.ready", payload: { recordingCount: state.recording.entries.length } });
}

function confirmFinalFormula(state, _command, context, events) {
  assertRitual(state.phase === "epilogue" && state.epilogue.stage === "awaitingFormula", "EPILOGUE_NOT_READY", "The final words cannot be spoken now.");
  const recordedEntries = state.recording.entries
    .filter((entry) => entry.status === "ready")
    .sort((left, right) => (left.recordedAt ?? Number.MAX_SAFE_INTEGER) - (right.recordedAt ?? Number.MAX_SAFE_INTEGER));
  const deathPosition = new Map((state.deadSurvivorActorIds ?? []).map((actorId, index) => [actorId, index]));
  const playableEntries = state.recording.playbackOrder === "recording"
    ? recordedEntries
    : [...recordedEntries].sort((left, right) =>
      (deathPosition.get(left.actorId) ?? Number.MAX_SAFE_INTEGER) - (deathPosition.get(right.actorId) ?? Number.MAX_SAFE_INTEGER)
    );
  if (playableEntries.length) {
    state.epilogue.stage = "playback";
    state.epilogue.currentRecordingIndex = 0;
    state.epilogue.playbackActorIds = playableEntries.map((entry) => entry.actorId);
    events.push({ type: "epilogue.playbackStarted", payload: { count: playableEntries.length } });
  } else {
    state.epilogue.stage = "silence";
    state.epilogue.currentRecordingIndex = -1;
    state.epilogue.silenceStartedAt = now(context);
    events.push({ type: "epilogue.silenceStarted", payload: { recordingCount: 0 } });
  }
}

function advanceEpilogueRecording(state, _command, context, events) {
  assertRitual(state.phase === "epilogue" && state.epilogue.stage === "playback", "EPILOGUE_NOT_PLAYING", "No final message is currently playing.");
  const playbackOrder = new Map((state.epilogue.playbackActorIds ?? []).map((actorId, index) => [actorId, index]));
  const playableEntries = state.recording.entries
    .filter((entry) => entry.status === "ready")
    .sort((left, right) =>
      (playbackOrder.get(left.actorId) ?? Number.MAX_SAFE_INTEGER) - (playbackOrder.get(right.actorId) ?? Number.MAX_SAFE_INTEGER)
    );
  const nextIndex = state.epilogue.currentRecordingIndex + 1;
  if (nextIndex < playableEntries.length) {
    state.epilogue.currentRecordingIndex = nextIndex;
    events.push({ type: "epilogue.recordingAdvanced", payload: { index: nextIndex } });
    return;
  }
  state.epilogue.stage = "silence";
  state.epilogue.currentRecordingIndex = -1;
  state.epilogue.silenceStartedAt = now(context);
  events.push({ type: "epilogue.silenceStarted", payload: { recordingCount: playableEntries.length } });
}

function endRitual(state, _command, context, events) {
  assertRitual(state.phase === "epilogue" && state.epilogue.stage === "silence", "EPILOGUE_NOT_SILENT", "Let the final silence settle first.");
  assertRitual(now(context) - state.epilogue.silenceStartedAt >= 5_000, "FINAL_SILENCE_REQUIRED", "Let the silence remain for a few more seconds.");
  assertPhaseTransition("epilogue", "ended");
  state.phase = "ended";
  state.status = "ended";
  state.epilogue.stage = "ended";
  state.epilogue.finishedAt = now(context);
  events.push({ type: "ritual.ended", payload: { finishedAt: state.epilogue.finishedAt } });
}

function editTruth(state, command, _context, events) {
  const truth = state.truths.find((entry) => entry.id === command.payload.truthId);
  assertRitual(truth?.kind === "spoken", "TRUTH_NOT_EDITABLE", "Only an established spoken truth may be edited.");
  assertRitual(typeof command.payload.text === "string" && command.payload.text.trim(), "EMPTY_TRUTH", "A truth cannot be empty.");
  truth.text = command.payload.text.trim();
  events.push({ type: "truth.edited", payload: { truthId: truth.id } });
}

function submitTruth(state, command, context, events) {
  assertRitual(state.phase === "truths", "NOT_ESTABLISHING_TRUTHS", "Truths can only be submitted during a truth round.");
  assertRitual(command.payload.text?.trim(), "EMPTY_TRUTH", "A truth cannot be empty.");
  assertRitual(
    state.truthRound.spokenCount < state.truthRound.expectedCount - 1,
    "TRUTH_ROUND_FULL",
    "The remaining truth is reserved for the collective closing statement."
  );
  assertRitual(
    state.truthRound.currentSpeakerUserId === command.issuedBy,
    "NOT_YOUR_TRUTH_TURN",
    "Wait until the truth passes to you."
  );
  appendTruth(state, {
    id: command.id,
    kind: "spoken",
    text: command.payload.text.trim(),
    speakerUserId: command.issuedBy,
    createdAt: now(context)
  });
  state.truthRound.spokenCount += 1;
  const spokenTarget = state.truthRound.expectedCount - 1;
  const order = state.truthRound.participantOrder;
  state.truthRound.currentSpeakerUserId = state.truthRound.spokenCount < spokenTarget && order.length
    ? order[state.truthRound.spokenCount % order.length]
    : null;
  events.push({
    type: "truth.spoken",
    payload: {
      text: command.payload.text.trim(),
      speakerUserId: command.issuedBy,
      nextSpeakerUserId: state.truthRound.currentSpeakerUserId
    }
  });
}

function closeTruthRound(state, command, context, events) {
  assertRitual(state.phase === "truths", "NOT_ESTABLISHING_TRUTHS", "There is no truth round to close.");
  assertRitual(
    state.truthRound.spokenCount === state.truthRound.expectedCount - 1,
    "TRUTHS_REMAINING",
    "All available spoken truths must be established before the round closes."
  );
  appendTruth(state, {
    id: command.id,
    kind: "ritual-closing",
    text: "And we are alive.",
    speakerUserId: null,
    createdAt: now(context)
  });
  state.truthRound.spokenCount += 1;

  const litCount = countLitCandles(state);
  state.dice.common = litCount;
  state.dice.gm = 10 - litCount;
  state.dice.sidelinedThisScene = 0;

  const nextPhase = litCount === 0 ? "epilogue" : litCount === 1 ? "lastStand" : "scene";
  assertPhaseTransition("truths", nextPhase);
  state.phase = nextPhase;
  if (nextPhase === "scene") {
    state.scene.number += 1;
    state.scene.startedAt = now(context);
    state.scene.endedAt = null;
    state.scene.traitBurnedActorIds = [];
  }
  state.truthRound = {
    expectedCount: 0,
    spokenCount: 0,
    firstSpeakerUserId: null,
    currentSpeakerUserId: null,
    participantOrder: []
  };
  events.push({ type: "truthRound.closed", payload: { nextPhase, commonDice: litCount, gmDice: 10 - litCount } });
}

const handlers = Object.freeze({
  "seating.configure": configureSeating,
  "seating.take": takeSeat,
  "seating.confirm": confirmSeat,
  "seating.lock": lockSeating,
  "session.activate": activateRitual,
  "debug.recording": debugRecording,
  "debug.playback": debugPlayback,
  "session.advancePreparation": advancePreparation,
  "recording.submit": submitRecording,
  "recording.pass": passRecording,
  "recording.requestRetake": requestRecordingRetake,
  "recording.seal": sealRecordings,
  "recording.skip": skipRecordings,
  "candle.extinguish": extinguishCandle,
  "candle.expire": expireCandle,
  "lastStand.extinguishFinalCandle": extinguishFinalCandle,
  "epilogue.confirmFormula": confirmFinalFormula,
  "epilogue.advanceRecording": advanceEpilogueRecording,
  "epilogue.end": endRitual,
  "conflict.open": openConflict,
  "conflict.openMoment": openMomentConflict,
  "conflict.rollPlayer": rollPlayerConflict,
  "conflict.rollGm": rollGmConflict,
  "conflict.cancel": cancelConflict,
  "conflict.burnTrait": burnTrait,
  "conflict.embraceBrink": embraceBrink,
  "conflict.beginNarrationSeizure": beginNarrationSeizure,
  "conflict.seizeNarration": seizeNarration,
  "conflict.useThemBrink": useThemBrink,
  "conflict.sacrifice": sacrificeSurvivor,
  "conflict.accept": acceptConflict,
  "conflict.finishNarration": finishConflictNarration,
  "truth.submit": submitTruth,
  "truth.edit": editTruth,
  "truth.closeRound": closeTruthRound
});

export function applyRitualCommand(currentState, command, context = {}) {
  // Duplicate detection precedes the revision check: a delivered command can be
  // acknowledged again even after it advanced the revision. New stale commands
  // are rejected rather than silently rebased on a different scene or phase.
  assertRitual(command?.id, "MISSING_COMMAND_ID", "Commands require an id.");
  assertRitual(command?.issuedBy, "MISSING_ISSUER", "Commands require an issuer.");
  assertRitual(Number.isInteger(command?.expectedRevision), "MISSING_REVISION", "Commands require an expected revision.");

  if (currentState.recentCommandIds.includes(command.id)) {
    return { ok: true, duplicate: true, state: cloneState(currentState), events: [] };
  }
  assertRitual(command.expectedRevision === currentState.revision, "STALE_REVISION", "The ritual changed before this command was applied.");
  assertRitual(!currentState.paused, "RITUAL_PAUSED", "The ritual is paused.");

  const handler = handlers[command.name];
  assertRitual(handler, "UNKNOWN_COMMAND", `Unknown ritual command ${command.name}.`);

  const state = cloneState(currentState);
  // Failed handlers/invariants leave the caller's original snapshot untouched.
  const events = [];
  handler(state, command, context, events);
  state.revision += 1;
  state.recentCommandIds = [...state.recentCommandIds, command.id].slice(-MAX_RECENT_COMMANDS);
  assertRitualInvariants(state);
  return { ok: true, duplicate: false, state, events };
}


