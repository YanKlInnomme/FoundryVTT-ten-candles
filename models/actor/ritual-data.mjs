import { RITUAL_PHASES } from "../../modules/constants.mjs";
import { idField, schemaVersionField, stringArrayField, timestampField } from "../shared-fields.mjs";

function initialCandles() {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `candle-${String(index + 1).padStart(2, "0")}`,
    position: index,
    state: "unlit",
    litAt: null,
    lifetimeMinutes: null,
    elapsedBurnMinutes: 0,
    expiresAt: null,
    lastRiskCheckAt: null,
    extinguishedAt: null,
    extinguishedBy: null,
    cause: null
  }));
}

/**
 * Persistent state of the shared game, stored on an Actor of type "session".
 * Survivor/Them IDs link to separate Actors; modules are embedded Items.
 * The revision and recent command IDs coordinate writes from multiple clients.
 * Keep browser resources and view state out of this serializable schema.
 */
export class RitualData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    const nullableString = () => new f.StringField({ required: true, nullable: true, initial: null });

    const candle = new f.SchemaField({
      id: new f.StringField({ required: true, nullable: false, blank: false }),
      position: new f.NumberField({ required: true, nullable: false, integer: true, min: 0, max: 9 }),
      state: new f.StringField({
        required: true,
        nullable: false,
        initial: "unlit",
        choices: ["unlit", "lit", "extinguished"]
      }),
      litAt: timestampField(),
      lifetimeMinutes: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 180, max: 300 }),
      // Active minutes, not wall time since litAt: pauses and offline time must
      // not consume wax. CandleClockService reanchors lastRiskCheckAt on resume.
      elapsedBurnMinutes: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
      expiresAt: timestampField(),
      lastRiskCheckAt: timestampField(),
      extinguishedAt: timestampField(),
      extinguishedBy: nullableString(),
      cause: nullableString()
    });

    const truth = new f.SchemaField({
      id: new f.StringField({ required: true, nullable: false, blank: false }),
      sceneNumber: new f.NumberField({ required: true, nullable: false, integer: true, min: 0 }),
      sequence: new f.NumberField({ required: true, nullable: false, integer: true, min: 0 }),
      kind: new f.StringField({
        required: true,
        nullable: false,
        choices: ["spoken", "ritual-opening", "ritual-closing"]
      }),
      text: new f.StringField({ required: true, nullable: false, initial: "" }),
      speakerUserId: nullableString(),
      createdAt: new f.NumberField({ required: true, nullable: false, integer: true, min: 0 })
    });
    const seat = new f.SchemaField({
      position: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 19 }),
      userId: idField(),
      survivorActorId: idField(),
      ready: new f.BooleanField({ required: true, nullable: false, initial: false })
    });

    const recordingEntry = new f.SchemaField({
      userId: new f.StringField({ required: true, nullable: false, blank: false }),
      actorId: new f.StringField({ required: true, nullable: false, blank: false }),
      mediaPath: nullableString(),
      textFallback: new f.StringField({ required: true, nullable: false, initial: "" }),
      durationMs: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 0 }),
      recordedAt: timestampField(),
      source: new f.StringField({ required: true, nullable: true, initial: null, choices: ["microphone", "upload"] }),
      status: new f.StringField({
        required: true,
        nullable: false,
        initial: "pending",
        choices: ["pending", "ready", "retake", "skipped", "failed"]
      })
    });

    const dieResults = () => new f.ArrayField(new f.NumberField({ required: true, nullable: false, integer: true, min: 1, max: 6 }), {
      required: true, nullable: false, initial: []
    });
    const conflict = new f.SchemaField({
      id: new f.StringField({ required: true, nullable: false, initial: "" }),
      status: new f.StringField({ required: true, nullable: false, initial: "idle", choices: ["idle", "open", "rolled", "narrating"] }),
      question: new f.StringField({ required: true, nullable: false, initial: "" }),
      resolutionText: new f.StringField({ required: true, nullable: false, initial: "" }),
      activeUserId: idField(),
      activeActorId: idField(),
      dire: new f.BooleanField({ required: true, nullable: false, initial: false }),
      momentDeclared: new f.BooleanField({ required: true, nullable: false, initial: false }),
      activeItemId: idField(),
      activeCardType: nullableString(),
      activeCardKind: nullableString(),
      themInvolved: new f.BooleanField({ required: true, nullable: false, initial: false }),
      themActorId: idField(),
      themBrinkItemId: idField(),
      gmBrinkUsed: new f.BooleanField({ required: true, nullable: false, initial: false }),
      commonDiceCount: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 }),
      availableHopeDiceCount: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
      hopeDiceCount: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
      gmDiceCount: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 }),
      playerRolled: new f.BooleanField({ required: true, nullable: false, initial: false }),
      gmRolled: new f.BooleanField({ required: true, nullable: false, initial: false }),
      playerResults: dieResults(),
      hopeResults: dieResults(),
      gmResults: dieResults(),
      success: new f.BooleanField({ required: true, nullable: false, initial: false }),
      narrationOwner: nullableString(),
      choosingNarrationCandle: new f.BooleanField({ required: true, nullable: false, initial: false }),
      availableReactions: stringArrayField(),
      traitRerolled: new f.BooleanField({ required: true, nullable: false, initial: false }),
      brinkEmbraced: new f.BooleanField({ required: true, nullable: false, initial: false }),
      endsScene: new f.BooleanField({ required: true, nullable: false, initial: false }),
      chosenCandleId: idField(),
      sacrificeActorId: idField()
    });

    return {
      schemaVersion: schemaVersionField(),
      status: new f.StringField({
        required: true,
        nullable: false,
        initial: "draft",
        choices: ["draft", "active", "ended"]
      }),
      phase: new f.StringField({
        required: true,
        nullable: false,
        initial: "setup",
        choices: RITUAL_PHASES
      }),
      paused: new f.BooleanField({ required: true, nullable: false, initial: false }),
      candleEnvironment: new f.StringField({
        required: true,
        nullable: false,
        initial: "livingRoom",
        choices: ["gale", "convention", "livingRoom", "none"]
      }),
      revision: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
      facilitatorUserId: idField(),
      survivorActorIds: stringArrayField(),
      deadSurvivorActorIds: stringArrayField(),
      themActorId: idField(),
      creation: new f.SchemaField({
        distributedAt: timestampField(),
        distributionRevision: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
        gmBrinkReady: new f.BooleanField({ required: true, nullable: false, initial: false })
      }),
      seating: new f.SchemaField({
        locked: new f.BooleanField({ required: true, nullable: false, initial: false }),
        invitedUserIds: stringArrayField(),
        seats: new f.ArrayField(seat, { required: true, nullable: false, initial: [] })
      }),
      activeModuleItemId: idField(),
      scene: new f.SchemaField({
        number: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 }),
        startedAt: timestampField(),
        endedAt: timestampField(),
        activePlayerUserId: idField(),
        traitBurnedActorIds: stringArrayField()
      }),
      candles: new f.ArrayField(candle, {
        required: true,
        nullable: false,
        initial: initialCandles
      }),
      dice: new f.SchemaField({
        common: new f.NumberField({ required: true, nullable: false, initial: 10, integer: true, min: 0, max: 10 }),
        gm: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 }),
        sidelinedThisScene: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 })
      }),
      conflict,
      truths: new f.ArrayField(truth, { required: true, nullable: false, initial: [] }),
      truthRound: new f.SchemaField({
        expectedCount: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 }),
        spokenCount: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0, max: 10 }),
        firstSpeakerUserId: idField(),
        currentSpeakerUserId: idField(),
        participantOrder: stringArrayField()
      }),
      recording: new f.SchemaField({
        mode: new f.StringField({
          required: true,
          nullable: false,
          initial: "audio",
          choices: ["audio", "text", "mixed", "disabled"]
        }),
        sealed: new f.BooleanField({ required: true, nullable: false, initial: false }),
        playbackOrder: new f.StringField({
          required: true,
          nullable: false,
          initial: "death",
          choices: ["death", "recording"]
        }),
        entries: new f.ArrayField(recordingEntry, { required: true, nullable: false, initial: [] })
      }),
      epilogue: new f.SchemaField({
        stage: new f.StringField({
          required: true,
          nullable: false,
          initial: "awaitingFormula",
          choices: ["awaitingFormula", "playback", "silence", "ended"]
        }),
        currentRecordingIndex: new f.NumberField({ required: true, nullable: false, initial: -1, integer: true, min: -1 }),
        playbackActorIds: stringArrayField(),
        startedAt: timestampField(),
        silenceStartedAt: timestampField(),
        finishedAt: timestampField()
      }),
      recentCommandIds: stringArrayField()
    };
  }

  static validateJoint(data) {
    super.validateJoint(data);
    if (data.candles.length !== 10) throw new Error("A ritual must contain exactly ten candles.");
    const ids = new Set(data.candles.map((candle) => candle.id));
    const positions = new Set(data.candles.map((candle) => candle.position));
    if (ids.size !== 10 || positions.size !== 10) throw new Error("Candle identifiers and positions must be unique.");
    if (data.dice.common + data.dice.gm > 10) throw new Error("Standard dice pools cannot exceed ten dice.");
  }
}

