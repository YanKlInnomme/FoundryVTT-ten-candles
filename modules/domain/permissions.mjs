import { assertRitual } from "./errors.mjs";
import { SYSTEM_ID } from "../constants.mjs";

const GM_COMMANDS = new Set([
  "debug.recording",
  "debug.playback",
  "session.activate",
  "session.advancePreparation",
  "candle.extinguish",
  "candle.expire",
  "lastStand.extinguishFinalCandle",
  "epilogue.confirmFormula",
  "epilogue.advanceRecording",
  "epilogue.end",
  "truth.closeRound",
  "truth.edit",
  "recording.seal",
  "recording.skip",
  "seating.configure",
  "seating.lock",
  "conflict.open",
  "conflict.rollGm",
  "conflict.cancel",
  "conflict.useThemBrink"
]);

const PARTICIPANT_COMMANDS = new Set([
  "truth.submit",
  "recording.submit",
  "recording.pass",
  "recording.requestRetake",
  "seating.take",
  "seating.confirm",
  "conflict.openMoment",
  "conflict.rollPlayer",
  "conflict.burnTrait",
  "conflict.embraceBrink",
  "conflict.beginNarrationSeizure",
  "conflict.seizeNarration",
  "conflict.sacrifice",
  "conflict.accept"
]);

export function assertCommandPermission({ command, user, ritual }) {
  // Run on the authoritative GM for local and socket requests alike. A visible
  // button or Actor ownership alone does not authorize a ritual transition;
  // some actions additionally belong to the active speaker/player/narrator.
  assertRitual(user, "UNKNOWN_USER", "The command issuer does not exist.");
  assertRitual(user.active, "INACTIVE_USER", "The command issuer is not connected.");

  if (command.name === "conflict.finishNarration") {
    const conflict = ritual.system.conflict;
    const ownsNarration = conflict?.narrationOwner === "gm"
      ? user.isGM
      : conflict?.narrationOwner === "player" && conflict.activeUserId === user.id;
    assertRitual(ownsNarration, "NARRATOR_ONLY", "Only the current narrator may finish this narration.");
    return true;
  }
  if (GM_COMMANDS.has(command.name)) {
    assertRitual(user.isGM, "GM_ONLY_COMMAND", "Only a GM may perform this ritual action.");
    if (command.name.startsWith("debug.")) {
      assertRitual(game.settings.get(SYSTEM_ID, "debugMode"), "DEBUG_ONLY_COMMAND", "Enable debug mode to use this shortcut.");
    }
    if (command.name === "candle.extinguish") {
      assertRitual(
        game.settings.get(SYSTEM_ID, "debugMode"),
        "DEBUG_ONLY_COMMAND",
        "Manual candle extinction is only available in debug mode."
      );
    }
    if (command.name === "conflict.open" && command.payload.themInvolved) {
      const themActor = game.actors.get(command.payload.themActorId);
      const themBrink = themActor?.items.get(command.payload.themBrinkItemId);
      assertRitual(
        themActor?.type === "them"
          && (ritual.system.themActorId === themActor.id || themActor.system.sessionActorId === ritual.id)
          && themBrink?.type === "brink"
          && themBrink.system.state !== "burned",
        "THEM_BRINK_UNAVAILABLE",
        "Their Brink has already been burned or is unavailable."
      );
    }
    return true;
  }

  if (PARTICIPANT_COMMANDS.has(command.name)) {
    if (command.name === "truth.submit") {
      assertRitual(
        ritual.system.truthRound?.currentSpeakerUserId === user.id,
        "NOT_YOUR_TRUTH_TURN",
        "Wait until the truth passes to you."
      );
    }
    if (command.name.startsWith("conflict.")) {
      if (command.name === "conflict.openMoment") {
        const actor = game.actors.get(command.payload.activeActorId);
        const activeItem = actor?.items.get(actor.system.stack.activeItemId);
        assertRitual(
          actor?.system.playerUserId === user.id
            && actor.system.sessionActorId === ritual.id
            && command.payload.activeUserId === user.id
            && activeItem?.type === "moment"
            && activeItem.id === command.payload.activeCard?.id,
          "OWN_ACTIVE_MOMENT_ONLY",
          "You may only attempt your own active Moment."
        );
        return true;
      }
      const activeUserId = ritual.system.conflict?.activeUserId;
      if (command.name === "conflict.accept") {
        assertRitual(activeUserId === user.id, "ACTIVE_PLAYER_ONLY", "Only the active player may accept this outcome.");
      } else if (command.name === "conflict.sacrifice") {
        const actor = game.actors.get(command.payload.actorId);
        assertRitual(user.isGM || actor?.system.playerUserId === user.id, "OWN_SURVIVOR_ONLY", "You may only sacrifice your own Survivor.");
        if (command.payload.recipientActorId) {
          const recipient = game.actors.get(command.payload.recipientActorId);
          const transferableHopeDice = (actor?.system.hopeDice ?? 0) + (actor?.system.transferredHopeDice ?? 0);
          assertRitual(transferableHopeDice > 0, "NO_HOPE_TO_PASS", "This Survivor has no Hope dice to pass.");
          assertRitual(
            recipient?.type === "survivor"
              && recipient.id !== actor?.id
              && recipient.system.sessionActorId === ritual.id
              && recipient.system.alive,
            "NO_HOPE_RECIPIENT",
            "Hope dice may only pass to another living Survivor at this table."
          );
        }
      } else {
        assertRitual(activeUserId === user.id, "ACTIVE_PLAYER_ONLY", "Only the active player may make this conflict decision.");
      }
      return true;
    }
    if (command.name.startsWith("seating.")) {
      assertRitual(!user.isGM && command.payload.userId === user.id, "PLAYER_SEAT_ONLY", "Only players may choose and confirm their own seat.");
      return true;
    }
    const isParticipant = user.isGM
      || ritual.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)
      || ritual.system.survivorActorIds.some((actorId) => {
      const actor = game.actors.get(actorId);
      return actor?.system.playerUserId === user.id;
    });
    assertRitual(isParticipant, "PARTICIPANT_ONLY_COMMAND", "Only a ritual participant may establish a truth.");
    return true;
  }

  assertRitual(false, "UNKNOWN_COMMAND_PERMISSION", `No permission policy exists for ${command.name}.`);
}
