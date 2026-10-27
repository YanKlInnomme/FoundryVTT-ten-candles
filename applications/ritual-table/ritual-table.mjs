/**
 * Shared play surface backed by a Foundry Actor of type "session".
 * The Actor represents the whole game, not a character or a canvas token:
 * it supplies persistence, ownership, embedded Items and document update hooks.
 * RitualSheet is its configuration sheet; this standalone ApplicationV2 is the
 * immersive view. Closing the view does not end or delete the session.
 *
 * Ritual transitions go through RitualService and the authoritative GM.
 * Preparation also writes owned Survivor documents and GM setup data directly;
 * transient UI state (drafts, open panels, drag positions) stays on this client.
 */
import { AuthorityService } from "../../modules/services/authority-service.mjs";
import { RitualService } from "../../modules/services/ritual-service.mjs";
import { DistributionService } from "../../modules/services/distribution-service.mjs";
import { ConflictRollService } from "../../modules/services/conflict-roll-service.mjs";
import { RecordingService } from "../../modules/services/recording-service.mjs";
import { localizeError } from "../../modules/services/localization-service.mjs";
import { SYSTEM_ID } from "../../modules/constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SYSTEM_CHANNEL = `system.${SYSTEM_ID}`;

const PREPARATION_DRAFT_SELECTORS = [
  "[data-truth-input]",
  "[data-virtue-input]",
  "[data-vice-input]",
  "[data-concept-name]",
  "[data-concept-look]",
  "[data-concept-summary]",
  "[data-moment-input]",
  "[data-brink-input]",
  "[data-gm-brink]"
];

export class RitualTable extends HandlebarsApplicationMixin(ApplicationV2) {
  // One table per client makes the body-level immersive CSS safe to remove on
  // close. Supporting concurrent tables would require shared ownership of it.
  /** @type {RitualTable | null} */
  static #current = null;
  static #hooksRegistered = false;
  #conflictLauncherOpen = false;
  #modulePlacesOpen = false;
  #conflictDraft = null;
  #useHopeDice = false;
  #personalHandOpen = false;
  #charactersOpen = false;
  #debugPosition = null;
  #debugResizeObserver = null;
  #recordingClock = null;
  #recordingAnimation = null;
  #recordingAudioContext = null;
  #epilogueTimer = null;
  #epiloguePlayTimer = null;
  #epilogueAudio = null;
  #epilogueAudioContext = null;
  #epilogueSound = null;
  #actorExistenceClock = null;
  #preparationDrafts = new Map();
  #focusedPreparationDraft = null;
  #observedLitCandleTimes = new Map();

  static DEFAULT_OPTIONS = {
    id: "ten-candles-ritual-table",
    classes: ["ten-candles", "tc-ritual-table"],
    tag: "section",
    position: { width: 1180, height: 820 },
    window: { icon: "fa-solid fa-fire-flame-simple", resizable: true },
    // ApplicationV2 binds these static action handlers to the application
    // instance. @this annotations below document that intentional rebinding.
    actions: {
      activateRitual: RitualTable.#activateRitual,
      advancePreparation: RitualTable.#advancePreparation,
      extinguishCandle: RitualTable.#extinguishCandle,
      extinguishNextCandle: RitualTable.#extinguishNextCandle,
      submitTruth: RitualTable.#submitTruth,
      editTruth: RitualTable.#editTruth,
      closeTruthRound: RitualTable.#closeTruthRound,
      prepareSeats: RitualTable.#prepareSeats,
      takeSeat: RitualTable.#takeSeat,
      confirmSeat: RitualTable.#confirmSeat,
      changeSeat: RitualTable.#changeSeat,
      lockSeating: RitualTable.#lockSeating,
      submitTraits: RitualTable.#submitTraits,
      unlockTraits: RitualTable.#unlockTraits,
      submitConcept: RitualTable.#submitConcept,
      unlockConcept: RitualTable.#unlockConcept,
      submitMoment: RitualTable.#submitMoment,
      unlockMoment: RitualTable.#unlockMoment,
      submitBrink: RitualTable.#submitBrink,
      unlockBrink: RitualTable.#unlockBrink,
      saveGmBrink: RitualTable.#saveGmBrink,
      unlockGmBrink: RitualTable.#unlockGmBrink,
      openSurvivorSheet: RitualTable.#openSurvivorSheet,
      openCharacterSheet: RitualTable.#openCharacterSheet,
      openConflict: RitualTable.#openConflict,
      debugRecording: RitualTable.#debugRecording,
      debugPlayback: RitualTable.#debugPlayback,
      openMomentConflict: RitualTable.#openMomentConflict,
      rollPlayerConflict: RitualTable.#rollPlayerConflict,
      rollGmConflict: RitualTable.#rollGmConflict,
      cancelConflict: RitualTable.#cancelConflict,
      burnTrait: RitualTable.#burnTrait,
      embraceBrink: RitualTable.#embraceBrink,
      beginNarrationSeizure: RitualTable.#beginNarrationSeizure,
      useThemBrink: RitualTable.#useThemBrink,
      seizeNarration: RitualTable.#seizeNarration,
      sacrificeSurvivor: RitualTable.#sacrificeSurvivor,
      acceptConflict: RitualTable.#acceptConflict,
      finishConflictNarration: RitualTable.#finishConflictNarration,
      startRecording: RitualTable.#startRecording,
      stopRecording: RitualTable.#stopRecording,
      discardRecording: RitualTable.#discardRecording,
      submitRecording: RitualTable.#submitRecording,
      passRecording: RitualTable.#passRecording,
      requestRecordingRetake: RitualTable.#requestRecordingRetake,
      sealRecordings: RitualTable.#sealRecordings,
      skipRecordings: RitualTable.#skipRecordings,
      extinguishFinalCandle: RitualTable.#extinguishFinalCandle,
      confirmFinalFormula: RitualTable.#confirmFinalFormula,
      advanceEpilogueRecording: RitualTable.#advanceEpilogueRecording,
      playEpilogueRecording: RitualTable.#playEpilogueRecording,
      endRitual: RitualTable.#endRitual
    }
  };

  static PARTS = {
    table: { template: "systems/ten-candles/templates/ritual-table/table.hbs" }
  };

  constructor({ actor, ...options } = {}) {
    super(options);
    if (!actor || actor.type !== "session") throw new Error("RitualTable requires a ritual Actor.");
    this.actor = actor;
    for (const candle of actor.system.candles) {
      if (candle.state === "lit" && candle.litAt) this.#observedLitCandleTimes.set(candle.id, candle.litAt);
    }
  }

  static initialize() {
    // Register global listeners once, but resolve #current on every callback:
    // reopening a different session must not keep updating the original table.
    if (this.#hooksRegistered) return;
    document.body.classList.toggle("tc-game-paused", Boolean(game.paused));
    Hooks.on("pauseGame", (paused) => {
      document.body.classList.toggle("tc-game-paused", Boolean(paused));
    });
    Hooks.on("updateActor", (actor) => {
      const table = this.#current;
      if (table && (actor.id === table.actor.id || actor.system?.sessionActorId === table.actor.id
        || table.actor.system.survivorActorIds.includes(actor.id) || actor.id === table.actor.system.themActorId)) {
        if (table.#hasUnsubmittedRecording()) return;
        void table.render({ parts: ["table"] });
      }
    });
    game.socket.on(SYSTEM_CHANNEL, (message, senderUserId) => {
      const table = this.#current;
      if (message?.type !== "epilogue.soundboard" || !table || message.ritualId !== table.actor.id) return;
      if (senderUserId !== AuthorityService.user?.id || message.senderUserId !== senderUserId) return;
      void table.#applySoundboardMessage(message);
    });
    Hooks.on("updateItem", (item) => {
      const table = this.#current;
      if (table && !table.#hasUnsubmittedRecording() && (item.parent?.id === table.actor.id || item.parent?.system?.sessionActorId === table.actor.id)) void table.render({ parts: ["table"] });
    });
    Hooks.on("createItem", (item) => {
      const table = this.#current;
      if (table && !table.#hasUnsubmittedRecording() && (item.parent?.id === table.actor.id || item.parent?.system?.sessionActorId === table.actor.id)) void table.render({ parts: ["table"] });
    });
    Hooks.on("deleteActor", (actor) => {
      if (actor.id === this.#current?.actor.id) void this.#current.close();
      else if (this.#current && !this.#current.#hasUnsubmittedRecording()) void this.#current.render({ parts: ["table"] });
    });
    this.#hooksRegistered = true;
  }

  static open(actor) {
    if (this.#current?.actor.id === actor.id) {
      void this.#current.render({ force: true });
      return this.#current;
    }
    if (this.#current) void this.#current.close();
    this.#current = new this({ actor });
    void this.#current.render({ force: true });
    return this.#current;
  }

  get title() {
    return `${this.actor.name} — ${game.i18n.localize("TENCANDLES.Table.Title")}`;
  }

  #hasUnsubmittedRecording() {
    // A document update must not replace the recorder DOM while audio is being
    // captured or awaits submission. The local recording service owns the media.
    if (this.actor.system.phase !== "recording") return false;
    const recording = RecordingService.getState(this.actor.id);
    return Boolean(recording.recording || recording.ready);
  }

  #isNewlyLit(candle) {
    // Remember the ignition timestamp per candle so unrelated Actor updates
    // cannot restart the lighting animation. Opening a table seeds this map.
    if (candle.state !== "lit" || !candle.litAt) return false;
    if (this.#observedLitCandleTimes.get(candle.id) === candle.litAt) return false;
    this.#observedLitCandleTimes.set(candle.id, candle.litAt);
    return true;
  }

  #setImmersiveMode(active) {
    // Presentation only: no browser Fullscreen API, canvas mutation or persisted
    // window resize. styles/ritual-table.css uses these body classes to cover the
    // viewport and hide selected Foundry controls, keeping the AV dock and
    // Consent Form X-card accessible. Port the lifecycle and CSS together.
    document.body.classList.toggle("tc-ritual-immersive", Boolean(active));
    document.body.classList.toggle("tc-ritual-epilogue", Boolean(active) && ["epilogue", "ended"].includes(this.actor.system.phase));
  }

  async minimize() {
    // Release immersive CSS after Foundry minimizes the window, so its normal
    // controls become usable again. maximize() restores the same presentation.
    await super.minimize();
    this.#setImmersiveMode(false);
  }

  async maximize() {
    await super.maximize();
    this.#setImmersiveMode(true);
  }

  async _onClose(options) {
    // Undo client-wide presentation and release observers/playback even though
    // the session Actor and its game state continue to exist independently.
    this.#debugResizeObserver?.disconnect();
    this.#stopEpiloguePlayback();
    if (this.#epilogueTimer) window.clearTimeout(this.#epilogueTimer);
    if (this.#actorExistenceClock) window.clearInterval(this.#actorExistenceClock);
    this.#actorExistenceClock = null;
    this.#setImmersiveMode(false);
    document.body.classList.remove("tc-ritual-epilogue");
    if (RitualTable.#current === this) RitualTable.#current = null;
    return super._onClose(options);
  }

  render(options = {}) {
    // Actor/Item hooks replace the table part frequently. Snapshot local choices
    // and unfinished inputs before replacement; _onRender restores them without
    // broadcasting private text or cursor positions through the session Actor.
    const activeElement = document.activeElement;
    const personalHand = this.element?.querySelector?.(".tc-personal-hand");
    if (personalHand) this.#personalHandOpen = personalHand.open;
    const characters = this.element?.querySelector?.("[data-table-characters]");
    if (characters) this.#charactersOpen = characters.open;
    this.#focusedPreparationDraft = null;
    for (const selector of PREPARATION_DRAFT_SELECTORS) {
      const field = this.element?.querySelector?.(selector);
      if (!field || field.disabled) continue;
      this.#preparationDrafts.set(selector, field.value);
      if (field === activeElement) {
        this.#focusedPreparationDraft = {
          selector,
          selectionStart: field.selectionStart,
          selectionEnd: field.selectionEnd
        };
      }
    }
    const launcher = this.element?.querySelector?.(".tc-conflict-panel.is-opening");
    if (launcher) {
      this.#conflictLauncherOpen = launcher.open;
    this.#conflictDraft = {
        actorId: launcher.querySelector("[data-conflict-actor]:checked")?.value ?? "",
      dire: Boolean(launcher.querySelector("[data-conflict-dire]")?.checked),
      them: Boolean(launcher.querySelector("[data-conflict-them]")?.checked)
      };
    }
    const hopeChoice = this.element?.querySelector?.("[data-conflict-hope]");
    if (hopeChoice) this.#useHopeDice = hopeChoice.checked;
    return super.render(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.#initializeDebugDragging();
    this.element?.querySelector("[data-module-places]")?.addEventListener("toggle", (event) => {
      this.#modulePlacesOpen = event.currentTarget.open;
    });
    this.#setImmersiveMode(!this.minimized);
    // This standalone application is not an ActorSheet registered in actor.apps;
    // also detect removal from the world when document hooks alone miss it.
    this.#actorExistenceClock ??= window.setInterval(() => {
      if (!game.actors.has(this.actor.id)) void this.close();
    }, 1_000);
    if (this.#recordingClock) window.clearInterval(this.#recordingClock);
    if (this.#recordingAnimation) window.cancelAnimationFrame(this.#recordingAnimation);
    if (this.#recordingAudioContext) void this.#recordingAudioContext.close();
    if (this.#epilogueAudioContext) void this.#epilogueAudioContext.close();
    if (this.#epilogueTimer) window.clearTimeout(this.#epilogueTimer);
    this.#epilogueTimer = null;
    this.#recordingAnimation = null;
    this.#recordingAudioContext = null;
    this.#epilogueAudioContext = null;
    this.#epilogueSound = null;
    const recordingDisplay = this.element?.querySelector?.("[data-recording-time]");
    if (recordingDisplay) {
      let elapsed = Number(recordingDisplay.dataset.elapsed ?? 0);
      const paintClock = () => {
        const seconds = Math.floor(elapsed / 1000);
        recordingDisplay.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      };
      paintClock();
      if (recordingDisplay.dataset.running === "true") {
        const started = Date.now() - elapsed;
        this.#recordingClock = window.setInterval(() => {
          if (!recordingDisplay.isConnected) return window.clearInterval(this.#recordingClock);
          elapsed = Date.now() - started;
          paintClock();
        }, 250);
      }
    }
    void this.#initializeRecordingVisualization();
    this.#initializeEpiloguePlayback();
    this.#initializeSoundboardControls();
    const hopeChoice = this.element?.querySelector?.("[data-conflict-hope]");
    if (hopeChoice) hopeChoice.checked = this.#useHopeDice;
    const personalHand = this.element?.querySelector?.(".tc-personal-hand");
    if (personalHand && (this.#personalHandOpen || personalHand.classList.contains("is-fallen"))) personalHand.open = true;
    for (const [selector, value] of this.#preparationDrafts) {
      const field = this.element?.querySelector?.(selector);
      // Locked fields remain visible to their author. Disabling them prevents
      // edits; it must not erase the private draft from the rendered control.
      if (field) field.value = value;
    }
    if (this.#focusedPreparationDraft) {
      const { selector, selectionStart, selectionEnd } = this.#focusedPreparationDraft;
      const field = this.element?.querySelector?.(selector);
      if (field && !field.disabled) {
        field.focus({ preventScroll: true });
        if (selectionStart !== null && selectionEnd !== null) field.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    this.element?.querySelector?.("[data-recording-file]")?.addEventListener("change", async (event) => {
      try {
        await RecordingService.useFile(this.actor.id, event.currentTarget.files?.[0]);
        void this.render({ parts: ["table"] });
      } catch (error) {
        event.currentTarget.value = "";
        ui.notifications.warn(localizeError(error));
      }
    });
    const launcher = this.element?.querySelector?.(".tc-conflict-panel.is-opening");
    if (!launcher) return;
    launcher.open = this.#conflictLauncherOpen;
    if (!this.#conflictDraft) return;
    const setValue = (selector, value) => {
      const input = launcher.querySelector(selector);
      if (input) input.value = value;
    };
    const setChecked = (selector, checked) => {
      const input = launcher.querySelector(selector);
      if (input) input.checked = checked;
    };
    const selectedActor = launcher.querySelector(`[data-conflict-actor][value="${CSS.escape(this.#conflictDraft.actorId)}"]`);
    if (selectedActor) selectedActor.checked = true;
    setChecked("[data-conflict-dire]", this.#conflictDraft.dire);
    setChecked("[data-conflict-them]", this.#conflictDraft.them);
  }

  #initializeDebugDragging() {
    // The panel is positioned inside the stage, not the viewport. Pointer capture
    // keeps dragging alive outside the handle; bounds and ResizeObserver keep it
    // reachable after resizing. The position lasts only for this table instance.
    this.#debugResizeObserver?.disconnect();
    const panel = this.element?.querySelector(".tc-debug-audio");
    const handle = panel?.querySelector("[data-debug-drag]");
    const stage = panel?.offsetParent;
    if (!handle || !stage) return;
    const move = (left, top) => {
      left = Math.max(0, Math.min(left, stage.clientWidth - panel.offsetWidth));
      top = Math.max(0, Math.min(top, stage.clientHeight - panel.offsetHeight));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
      this.#debugPosition = { left, top };
    };
    if (this.#debugPosition) move(this.#debugPosition.left, this.#debugPosition.top);
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    });
    const stop = () => { drag = null; };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
    handle.addEventListener("keydown", (event) => {
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!direction) return;
      event.preventDefault();
      const step = event.shiftKey ? 40 : 10;
      move(panel.offsetLeft + direction[0] * step, panel.offsetTop + direction[1] * step);
    });
    this.#debugResizeObserver = new ResizeObserver(() => {
      if (this.#debugPosition) move(this.#debugPosition.left, this.#debugPosition.top);
    });
    this.#debugResizeObserver.observe(stage);
    this.#debugResizeObserver.observe(panel);
  }

  #stopEpiloguePlayback() {
    if (this.#epiloguePlayTimer !== null) window.clearTimeout(this.#epiloguePlayTimer);
    this.#epiloguePlayTimer = null;
    this.#epilogueAudio?.pause();
    this.#epilogueAudio = null;
  }

  #initializeEpiloguePlayback() {
    // Each client plays locally; only the authoritative GM advances the shared
    // playback index on "ended", preventing one advance per connected player.
    this.#stopEpiloguePlayback();
    const audio = this.element?.querySelector?.("[data-epilogue-audio]");
    if (audio) {
      this.#epilogueAudio = audio;
      const station = audio.closest(".tc-epilogue-message");
      const play = () => {
        this.#epiloguePlayTimer = null;
        if (this.#epilogueAudio !== audio || !audio.isConnected) return;
        station?.classList.remove("is-blocked", "is-missing");
        void audio.play().catch(() => station?.classList.add("is-blocked"));
      };
      audio.addEventListener("ended", () => {
        if (this.#epilogueAudio !== audio || !audio.isConnected) return;
        if (AuthorityService.isCurrentUser) void RitualService.execute(this.actor, "epilogue.advanceRecording");
      }, { once: true });
      audio.addEventListener("error", () => station?.classList.add("is-missing"), { once: true });
      this.#epiloguePlayTimer = window.setTimeout(play, 250);
    }
    const silence = this.element?.querySelector?.("[data-epilogue-silence]");
    if (silence && !silence.querySelector("[data-action='endRitual']")) {
      const remainingMs = Math.max(0, Number(silence.dataset.remainingMs) || 0);
      this.#epilogueTimer = window.setTimeout(() => void this.render({ parts: ["table"] }), remainingMs + 50);
    }
  }

  #initializeSoundboardControls() {
    // Soundboard changes are ephemeral socket messages, not session revisions.
    // Apply locally as well because the sender need not receive its own emit.
    if (!AuthorityService.isCurrentUser) return;
    const send = (payload) => {
      const message = { type: "epilogue.soundboard", ritualId: this.actor.id, senderUserId: game.user.id, ...payload };
      void this.#applySoundboardMessage(message);
      game.socket.emit(SYSTEM_CHANNEL, message);
    };
    this.element?.querySelector?.("[data-soundboard-preset]")?.addEventListener("change", (event) => send({ action: "preset", value: event.currentTarget.value }));
    this.element?.querySelector?.("[data-soundboard-voice]")?.addEventListener("input", (event) => send({ action: "voice", value: Number(event.currentTarget.value) }));
    this.element?.querySelector?.("[data-soundboard-noise]")?.addEventListener("input", (event) => send({ action: "noise", value: Number(event.currentTarget.value) }));
    this.element?.querySelectorAll?.("[data-soundboard-effect]").forEach((button) => button.addEventListener("click", () => send({ action: "effect", value: button.dataset.soundboardEffect })));
  }

  async #ensureEpilogueSound() {
    // Process the HTML audio element through Web Audio for this playback only.
    // Filters, gain and generated noise never modify the stored recording file.
    if (this.#epilogueSound) return this.#epilogueSound;
    const audio = this.element?.querySelector?.("[data-epilogue-audio]");
    if (!audio) return null;
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass();
    const source = context.createMediaElementSource(audio);
    const filter = context.createBiquadFilter();
    const distortion = context.createWaveShaper();
    const voice = context.createGain();
    source.connect(filter).connect(distortion).connect(voice).connect(context.destination);
    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noiseData.length; index += 1) noiseData[index] = Math.random() * 2 - 1;
    const noiseSource = context.createBufferSource();
    const noiseFilter = context.createBiquadFilter();
    const noise = context.createGain();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 1_800;
    noiseFilter.Q.value = 0.45;
    noise.gain.value = 0;
    noiseSource.connect(noiseFilter).connect(noise).connect(context.destination);
    noiseSource.start();
    this.#epilogueAudioContext = context;
    this.#epilogueSound = { audio, context, filter, distortion, voice, noise };
    await context.resume().catch(() => {});
    return this.#epilogueSound;
  }

  static #distortionCurve(amount = 0) {
    const curve = new Float32Array(256);
    const k = Math.max(0, amount);
    for (let index = 0; index < curve.length; index += 1) {
      const x = index * 2 / (curve.length - 1) - 1;
      curve[index] = k ? ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x)) : x;
    }
    return curve;
  }

  async #applySoundboardMessage({ action, value }) {
    const sound = await this.#ensureEpilogueSound();
    if (!sound) return;
    const presets = {
      intact: { type: "lowpass", frequency: 20_000, q: 0.1, distortion: 0, noise: 0, rate: 1 },
      cassette: { type: "lowpass", frequency: 5_200, q: 0.7, distortion: 12, noise: 0.07, rate: 0.99 },
      radio: { type: "bandpass", frequency: 1_850, q: 0.8, distortion: 18, noise: 0.1, rate: 1 },
      degraded: { type: "lowpass", frequency: 2_400, q: 1, distortion: 35, noise: 0.17, rate: 0.975 },
      lost: { type: "bandpass", frequency: 1_250, q: 1.5, distortion: 52, noise: 0.26, rate: 0.95 }
    };
    if (action === "preset") {
      const preset = presets[value] ?? presets.intact;
      sound.filter.type = preset.type;
      sound.filter.frequency.setTargetAtTime(preset.frequency, sound.context.currentTime, 0.08);
      sound.filter.Q.setTargetAtTime(preset.q, sound.context.currentTime, 0.08);
      sound.distortion.curve = RitualTable.#distortionCurve(preset.distortion);
      sound.distortion.oversample = "2x";
      sound.noise.gain.setTargetAtTime(preset.noise, sound.context.currentTime, 0.08);
      sound.audio.playbackRate = preset.rate;
    } else if (action === "voice") sound.voice.gain.setTargetAtTime(Math.max(0, Math.min(1, Number(value))), sound.context.currentTime, 0.04);
    else if (action === "noise") sound.noise.gain.setTargetAtTime(Math.max(0, Math.min(0.5, Number(value))), sound.context.currentTime, 0.04);
    else if (action === "effect" && value === "reset") {
      await this.#applySoundboardMessage({ action: "preset", value: "intact" });
      sound.voice.gain.setTargetAtTime(1, sound.context.currentTime, 0.04);
    } else if (action === "effect" && value === "dropout") {
      const time = sound.context.currentTime;
      sound.voice.gain.cancelScheduledValues(time);
      sound.voice.gain.setValueAtTime(sound.voice.gain.value, time);
      sound.voice.gain.linearRampToValueAtTime(0, time + 0.08);
      sound.voice.gain.setValueAtTime(0, time + 0.55);
      sound.voice.gain.linearRampToValueAtTime(1, time + 0.72);
    } else if (action === "effect" && ["scratch", "interference"].includes(value)) {
      const time = sound.context.currentTime;
      const peak = value === "scratch" ? 0.42 : 0.3;
      sound.noise.gain.cancelScheduledValues(time);
      sound.noise.gain.setValueAtTime(sound.noise.gain.value, time);
      sound.noise.gain.linearRampToValueAtTime(peak, time + 0.03);
      sound.noise.gain.exponentialRampToValueAtTime(0.001, time + (value === "scratch" ? 0.42 : 0.85));
      if (value === "scratch") {
        sound.audio.playbackRate = 0.62;
        window.setTimeout(() => { if (sound.audio.isConnected) sound.audio.playbackRate = 1; }, 430);
      }
    }
  }

  async #initializeRecordingVisualization() {
    // Live capture draws from an analyser; preview uses cached amplitude peaks
    // or decodes the imported file once. This visualization is client-local and
    // must tolerate an async decode finishing after the table part was replaced.
    const canvas = this.element?.querySelector?.("[data-recording-waveform]");
    if (!canvas) return;
    const display = this.element.querySelector("[data-recording-time]");
    const audio = this.element.querySelector("[data-recording-audio]");
    const { stream, blob, waveform } = RecordingService.getVisualizationSource(this.actor.id);
    const setupCanvas = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(240, canvas.clientWidth);
      const height = Math.max(30, canvas.clientHeight);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const painter = canvas.getContext("2d");
      painter.setTransform(ratio, 0, 0, ratio, 0, 0);
      return { painter, width, height };
    };
    const paint = (values, progress = 0) => {
      const { painter, width, height } = setupCanvas();
      painter.clearRect(0, 0, width, height);
      const draw = (color, limit) => {
        painter.save();
        painter.beginPath();
        painter.rect(0, 0, width * limit, height);
        painter.clip();
        painter.strokeStyle = color;
        painter.lineWidth = 1.5;
        painter.beginPath();
        values.forEach((value, index) => {
          const x = (index / Math.max(1, values.length - 1)) * width;
          const amplitude = Math.max(0.025, Math.abs(value));
          painter.moveTo(x, height / 2 - amplitude * height * 0.46);
          painter.lineTo(x, height / 2 + amplitude * height * 0.46);
        });
        painter.stroke();
        painter.restore();
      };
      draw("rgb(37 49 32 / 45%)", 1);
      if (progress > 0) draw("#172414", progress);
    };
    const formatTime = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

    if (stream?.getAudioTracks?.().some((track) => track.readyState === "live")) {
      const AudioContext = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContext) return;
      this.#recordingAudioContext = new AudioContext();
      const source = this.#recordingAudioContext.createMediaStreamSource(stream);
      const analyser = this.#recordingAudioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const animate = () => {
        if (!canvas.isConnected) return;
        analyser.getByteTimeDomainData(samples);
        const values = Array.from(samples, (sample) => (sample - 128) / 128);
        paint(values, 1);
        RecordingService.appendWaveformSample(this.actor.id, Math.max(...values.map(Math.abs)));
        this.#recordingAnimation = window.requestAnimationFrame(animate);
      };
      animate();
      return;
    }

    if (!blob) {
      paint(new Array(80).fill(0), 0);
      return;
    }
    try {
      const expectedDuration = Math.max(0, Number(audio?.dataset.durationMs ?? 0) / 1000);
      const AudioContext = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContext) return;
      let peaks = waveform;
      if (!peaks.length) {
        this.#recordingAudioContext = new AudioContext();
        const buffer = await this.#recordingAudioContext.decodeAudioData(await blob.arrayBuffer());
        if (!canvas.isConnected) return;
        const channel = buffer.getChannelData(0);
        const columns = 160;
        const blockSize = Math.max(1, Math.floor(channel.length / columns));
        peaks = Array.from({ length: columns }, (_, index) => {
          let peak = 0;
          const end = Math.min(channel.length, (index + 1) * blockSize);
          for (let cursor = index * blockSize; cursor < end; cursor += 1) peak = Math.max(peak, Math.abs(channel[cursor]));
          return peak;
        });
      }
      const playButton = this.element.querySelector("[data-recording-play]");
      const progressInput = this.element.querySelector("[data-recording-progress]");
      const currentLabel = this.element.querySelector("[data-recording-current]");
      const totalLabel = this.element.querySelector("[data-recording-total]");
      const muteButton = this.element.querySelector("[data-recording-mute]");
      const volumeInput = this.element.querySelector("[data-recording-volume]");
      let decodedDuration = 0;
      if (!expectedDuration && blob) {
        const DurationContext = window.AudioContext ?? window.webkitAudioContext;
        if (DurationContext) {
          const durationContext = new DurationContext();
          try {
            decodedDuration = (await durationContext.decodeAudioData(await blob.arrayBuffer())).duration;
          } finally {
            void durationContext.close();
          }
        }
      }
      const knownDuration = () => expectedDuration || decodedDuration || (Number.isFinite(audio?.duration) ? audio.duration : 0);
      const syncPlayback = () => {
        const duration = knownDuration();
        const progress = duration ? audio.currentTime / duration : 0;
        paint(peaks, progress);
        if (display) display.textContent = formatTime(audio.currentTime);
        if (currentLabel) currentLabel.textContent = formatTime(audio.currentTime).replace(/^0/, "");
        if (totalLabel) totalLabel.textContent = formatTime(duration).replace(/^0/, "");
        if (progressInput) {
          progressInput.max = String(Math.max(1, Math.round(duration * 1000)));
          progressInput.value = String(Math.round(audio.currentTime * 1000));
        }
        if (playButton) playButton.textContent = audio.paused ? "▶" : "❚❚";
        if (muteButton) muteButton.textContent = audio.muted || audio.volume === 0 ? "🔇" : "🔊";
      };
      ["loadedmetadata", "durationchange", "timeupdate", "seeked", "play", "pause", "ended"].forEach((type) => audio?.addEventListener(type, syncPlayback));
      playButton?.addEventListener("click", () => { if (audio.paused) void audio.play(); else audio.pause(); });
      progressInput?.addEventListener("input", () => { audio.currentTime = Number(progressInput.value) / 1000; });
      muteButton?.addEventListener("click", () => { audio.muted = !audio.muted; syncPlayback(); });
      volumeInput?.addEventListener("input", () => {
        audio.volume = Number(volumeInput.value);
        audio.muted = audio.volume === 0;
        syncPlayback();
      });
      syncPlayback();
    } catch (error) {
      console.warn("Ten Candles | Could not draw the recording waveform.", error);
      paint(new Array(80).fill(0), 0);
    }
  }

  async _prepareContext(options) {
    // Derive view flags from the shared phase and this user's role. Template
    // visibility improves UX; command permission checks remain the authority.
    const context = await super._prepareContext(options);
    const { system } = this.actor;
    const isAuthority = AuthorityService.isCurrentUser;
    const canParticipate = this.#canParticipate(game.user);
    const spokenTarget = Math.max(0, system.truthRound.expectedCount - 1);
    const currentTruthSpeakerId = system.truthRound.currentSpeakerUserId;
    const currentTruthSpeakerName = game.users.get(currentTruthSpeakerId)?.name
      ?? game.i18n.localize("TENCANDLES.Table.UnknownSpeaker");
    const truthTurnOrder = system.truthRound.participantOrder.map((userId) => ({
      userId,
      name: game.users.get(userId)?.name ?? game.i18n.localize("TENCANDLES.Table.UnknownSpeaker"),
      current: userId === currentTruthSpeakerId
    }));
    const canSubmitTruth = system.phase === "truths"
      && system.truthRound.spokenCount < spokenTarget
      && canParticipate
      && currentTruthSpeakerId === game.user.id;
    const preparationPhases = ["traits", "moments", "brinks", "stacks", "concepts", "inventory"];
    const litCandleCount = system.candles.filter((candle) => candle.state === "lit").length;
    const darkness = 1 - (litCandleCount / 10);
    const personalSurvivor = game.user.isGM ? null : game.actors.find((actor) => actor.type === "survivor"
      && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    const personalCards = personalSurvivor
      ? personalSurvivor.system.stack.itemIds.map((id) => personalSurvivor.items.get(id)).filter(Boolean)
      : [];
    const seatedSurvivors = system.survivorActorIds.map((id) => game.actors.get(id)).filter((actor) => actor?.type === "survivor");
    const deadSurvivorIds = new Set([
      ...(system.deadSurvivorActorIds ?? []),
      ...seatedSurvivors.filter((survivor) => !survivor.system.alive).map((survivor) => survivor.id)
    ]);
    const livingSurvivors = seatedSurvivors.filter((survivor) => !deadSurvivorIds.has(survivor.id));
    const fallenSurvivors = seatedSurvivors.filter((survivor) => deadSurvivorIds.has(survivor.id));
    const conflict = system.conflict;
    const playbackPosition = new Map((system.epilogue?.playbackActorIds ?? []).map((actorId, index) => [actorId, index]));
    const playableRecordings = system.recording.entries
      .filter((entry) => entry.status === "ready")
      .sort((left, right) =>
        (playbackPosition.get(left.actorId) ?? Number.MAX_SAFE_INTEGER) - (playbackPosition.get(right.actorId) ?? Number.MAX_SAFE_INTEGER)
      );
    const epilogueEntry = system.epilogue?.stage === "playback"
      ? playableRecordings[system.epilogue.currentRecordingIndex] ?? null
      : null;
    const epilogueSilenceElapsed = system.epilogue?.silenceStartedAt ? Date.now() - system.epilogue.silenceStartedAt : 0;
    const activeMoments = system.phase === "scene" ? seatedSurvivors.flatMap((survivor) => {
      if (!survivor.system.alive) return [];
      const moment = survivor.items.get(survivor.system.stack.activeItemId);
      if (moment?.type !== "moment" || moment.system.state === "burned") return [];
      return [{
        actorName: survivor.name,
        playerName: game.users.get(survivor.system.playerUserId)?.name ?? survivor.name,
        text: moment.system.text,
        canAttempt: conflict.status === "idle" && survivor.system.playerUserId === game.user.id
      }];
    }) : [];
    const mySeat = system.seating.seats.find((seat) => seat.userId === game.user.id);
    const activeModule = this.actor.items.get(system.activeModuleItemId) ?? this.actor.items.find((item) => item.type === "module") ?? null;
    const myRetake = system.recording.entries.find((entry) => entry.userId === game.user.id && entry.status === "retake");
    const currentRecording = myRetake
      ?? system.recording.entries.find((entry) => entry.status === "pending")
      ?? system.recording.entries.find((entry) => entry.status === "retake")
      ?? null;
    const localRecording = RecordingService.getState(this.actor.id);
    const recordingSeconds = Math.max(0, Math.ceil((localRecording.durationMs ?? 0) / 1000));
    localRecording.durationLabel = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;
    const conflictActor = game.actors.get(conflict.activeActorId);
    const themActor = game.actors.get(system.themActorId) ?? game.actors.find((actor) => actor.type === "them");
    const availableThemBrink = themActor?.items.find((item) => item.type === "brink" && item.system.state !== "burned") ?? null;
    const isActiveConflictUser = conflict.activeUserId === game.user.id;
    const canSelectNarrationCandle = conflict.status === "rolled" && conflict.choosingNarrationCandle && isActiveConflictUser;
    const finalLitCandleId = system.phase === "lastStand"
      ? system.candles.find((candle) => candle.state === "lit")?.id ?? null
      : null;
    const sacrificeRecipients = livingSurvivors.filter((survivor) => survivor.id !== personalSurvivor?.id);
    const transferableHopeDice = personalSurvivor
      ? personalSurvivor.system.hopeDice + personalSurvivor.system.transferredHopeDice
      : 0;
    const personalSeatIndex = system.seating.seats.findIndex((seat) => seat.userId === game.user.id);
    const isBrinkForThem = personalSeatIndex >= 0 && personalSeatIndex === system.seating.seats.length - 1;
    const brinkRecipientName = personalSeatIndex < 0 ? "" : isBrinkForThem
      ? game.i18n.localize("TENCANDLES.Actor.Them")
      : game.users.get(system.seating.seats[personalSeatIndex + 1]?.userId)?.name ?? "";
    const authorityName = AuthorityService.user?.name ?? game.i18n.localize("TENCANDLES.Seating.GmSeat");
    const decorateDice = (results, kind) => results.map((value) => ({
      value, kind, isOne: value === 1, isSuccess: kind === "hope" ? value >= 5 : value === 6, isSix: value === 6
    }));

    return {
      ...context,
      actor: this.actor,
      system,
      activeModule,
      charactersOpen: this.#charactersOpen,
      tableCharacters: seatedSurvivors.map((survivor) => ({
        id: survivor.id,
        name: survivor.name,
        playerName: game.users.get(survivor.system.playerUserId)?.name ?? "",
        img: survivor.img,
        canOpen: game.user.isGM || (survivor.system.playerUserId === game.user.id && survivor.isOwner)
      })),
      tableThem: game.user.isGM && themActor ? { id: themActor.id, name: themActor.name, img: themActor.img } : null,
      // Reveal the roster to all players at the GM's phase transition, not as
      // each player confirms their own profile during character creation.
      showTableCharacters: game.user.isGM
        ? seatedSurvivors.length > 0 || Boolean(themActor)
        : seatedSurvivors.length > 0 && ["recording", "scene", "truths", "lastStand", "epilogue", "ended"].includes(system.phase),
      canDebugAudio: isAuthority && game.settings.get(SYSTEM_ID, "debugMode"),
      showModuleReference: Boolean(activeModule) && ["scene", "truths", "lastStand"].includes(system.phase),
      modulePlacesOpen: this.#modulePlacesOpen,
      candles: system.candles.map((candle, index) => ({
        candle,
        number: index + 1,
        index,
        lightDelayMs: (index % 3) * 700,
        newlyLit: this.#isNewlyLit(candle),
        selectedForNarration: candle.id === conflict.chosenCandleId
      })),
      recentTruths: system.truths.slice(-5),
      hasHiddenTruths: system.truths.length > 5,
      phaseLabel: game.i18n.localize(`TENCANDLES.Phase.${system.phase}`),
      litCandleCount,
      darkness,
      authorityName,
      isCurrentUserGm: game.user.isGM,
      isAuthority,
      canActivate: isAuthority && system.status === "draft" && system.phase === "setup" && Boolean(activeModule),
      canAdvancePreparation: isAuthority && system.status === "active" && preparationPhases.includes(system.phase)
        && (system.phase !== "traits" || seatedSurvivors.every((survivor) => survivor.system.ready.traits))
        && (system.phase !== "moments" || seatedSurvivors.every((survivor) => survivor.system.ready.moment))
        && (system.phase !== "brinks" || (system.creation.gmBrinkReady && seatedSurvivors.every((survivor) => survivor.system.ready.brink)))
        && (system.phase !== "stacks" || (Boolean(system.creation.distributedAt) && seatedSurvivors.every((survivor) => survivor.system.ready.stack && survivor.system.ready.concept && survivor.system.ready.inventory)))
        && (system.phase !== "concepts" || seatedSurvivors.every((survivor) => survivor.system.ready.concept)),
      canExtinguish: isAuthority && system.phase === "scene" && game.settings.get(SYSTEM_ID, "debugMode"),
      isTruthRound: system.phase === "truths",
      isLastStand: system.phase === "lastStand",
      isEpilogue: system.phase === "epilogue",
      isRitualEnded: system.phase === "ended",
      epilogueAwaitingFormula: system.phase === "epilogue" && system.epilogue.stage === "awaitingFormula",
      epiloguePlaying: system.phase === "epilogue" && system.epilogue.stage === "playback",
      epilogueSilent: system.phase === "epilogue" && system.epilogue.stage === "silence",
      epilogueEntry: epilogueEntry ? {
        ...epilogueEntry,
        playerName: game.users.get(epilogueEntry.userId)?.name ?? "",
        actorName: game.actors.get(epilogueEntry.actorId)?.name ?? "",
        hasAudio: Boolean(epilogueEntry.mediaPath),
        hasText: Boolean(epilogueEntry.textFallback?.trim())
      } : null,
      epiloguePosition: system.epilogue?.stage === "playback" ? system.epilogue.currentRecordingIndex + 1 : 0,
      epilogueCount: playableRecordings.length,
      canConfirmFinalFormula: isAuthority && system.phase === "epilogue" && system.epilogue.stage === "awaitingFormula",
      canAdvanceEpilogue: isAuthority && system.phase === "epilogue" && system.epilogue.stage === "playback",
      canControlEpilogueSound: isAuthority && system.phase === "epilogue" && system.epilogue.stage === "playback",
      canEndRitual: isAuthority && system.phase === "epilogue" && system.epilogue.stage === "silence" && epilogueSilenceElapsed >= 5_000,
      epilogueSilenceRemainingMs: Math.max(0, 5_000 - epilogueSilenceElapsed),
      livingSurvivors,
      fallenSurvivors,
      canExtinguishFinalCandle: isAuthority && system.phase === "lastStand" && seatedSurvivors.length > 0 && livingSurvivors.length === 0,
      currentTruthSpeakerName,
      truthTurnOrder,
      awaitingCollectiveTruth: system.phase === "truths" && system.truthRound.spokenCount === spokenTarget,
      canSubmitTruth,
      canCloseTruthRound: isAuthority && system.phase === "truths" && system.truthRound.spokenCount === spokenTarget,
      personalHand: personalSurvivor ? {
        survivor: personalSurvivor,
        fallen: !personalSurvivor.system.alive || deadSurvivorIds.has(personalSurvivor.id),
        activeCard: (() => {
          const card = personalSurvivor.items.get(personalSurvivor.system.stack.activeItemId) ?? personalCards[0] ?? null;
          return card?.system.state === "burned" ? null : card;
        })(),
        activeCardBurning: personalSurvivor.items.get(personalSurvivor.system.stack.activeItemId)?.system.state === "burning",
        cards: personalCards.filter((card) => card.system.state !== "burned" && card.id !== personalSurvivor.system.stack.activeItemId).map((card) => ({
          document: card,
          state: card.system.state,
          stateLabel: game.i18n.localize(`TENCANDLES.Card.State.${card.system.state}`)
        })),
        graveyard: personalCards.filter((card) => card.system.state === "burned").map((card) => ({
          document: card,
          stateLabel: game.i18n.localize("TENCANDLES.Card.State.burned")
        })),
        hasBurnedCards: personalCards.some((card) => card.system.state === "burned"),
        virtue: personalSurvivor.items.find((item) => item.type === "trait" && item.system.kind === "virtue"),
        vice: personalSurvivor.items.find((item) => item.type === "trait" && item.system.kind === "vice"),
        moment: personalSurvivor.items.find((item) => item.type === "moment"),
        brink: personalSurvivor.items.find((item) => item.type === "brink")
      } : null,
      isTraitsPhase: system.phase === "traits",
      traitsLocked: Boolean(personalSurvivor?.system.ready.traits),
      isModulePhase: system.phase === "setup" && system.seating.locked,
      isConceptsPhase: system.phase === "concepts",
      conceptLocked: Boolean(personalSurvivor?.system.ready.concept),
      isMomentsPhase: system.phase === "moments",
      momentLocked: Boolean(personalSurvivor?.system.ready.moment),
      isBrinksPhase: system.phase === "brinks",
      brinkLocked: Boolean(personalSurvivor?.system.ready.brink),
      brinkRecipientName,
      isBrinkForThem,
      isFinalizationPhase: system.phase === "stacks",
      isPersonalSurvivorFinalized: Boolean(personalSurvivor?.system.ready.concept && personalSurvivor?.system.ready.inventory),
      isRecordingPhase: system.phase === "recording",
      recordingEntries: system.recording.entries.map((entry) => ({
        ...entry,
        playerName: game.users.get(entry.userId)?.name ?? entry.userId,
        actorName: game.actors.get(entry.actorId)?.name ?? game.i18n.localize("TENCANDLES.Actor.Survivor"),
        statusLabel: game.i18n.localize(`TENCANDLES.Recording.Status.${entry.status}`),
        current: ["pending", "retake"].includes(entry.status) && entry.userId === currentRecording?.userId,
        canRequestRetake: entry.status === "ready" && entry.userId === game.user.id
      })),
      recordingCurrentName: game.users.get(currentRecording?.userId)?.name ?? "",
      isMyRecordingTurn: currentRecording?.userId === game.user.id,
      localRecording,
      shouldOpenPersonalHand: isActiveConflictUser && conflict.status === "rolled"
        && (conflict.availableReactions.includes("trait")
          || conflict.availableReactions.includes("brink")
          || conflict.momentDeclared),
      canSealRecordings: isAuthority && system.phase === "recording" && system.recording.entries.length > 0 && system.recording.entries.every((entry) => ["ready", "skipped"].includes(entry.status)),
      canSkipRecordings: isAuthority && system.phase === "recording",
      showPreparationProgress: isAuthority && ["traits", "moments", "brinks", "stacks", "concepts"].includes(system.phase),
      preparationProgressLabel: game.i18n.localize(`TENCANDLES.Creation.${system.phase === "traits" ? "TraitsProgress" : system.phase === "moments" ? "MomentsProgress" : system.phase === "brinks" ? "BrinksProgress" : system.phase === "stacks" ? "FinalizationProgress" : "ConceptsProgress"}`),
      preparationParticipants: [...seatedSurvivors.map((survivor) => ({
        survivor,
        playerName: game.users.get(survivor.system.playerUserId)?.name ?? survivor.name,
        ready: system.phase === "traits" ? survivor.system.ready.traits
          : system.phase === "moments" ? survivor.system.ready.moment
          : system.phase === "brinks" ? survivor.system.ready.brink
          : system.phase === "stacks" ? survivor.system.ready.stack && survivor.system.ready.concept && survivor.system.ready.inventory
          : system.phase === "concepts" ? survivor.system.ready.concept : false
      })), ...(system.phase === "brinks" ? [{ playerName: authorityName, ready: system.creation.gmBrinkReady }] : [])],
      isSeatingVestibule: system.phase === "setup" && !system.seating.locked,
      moduleRequiredForInvitation: isAuthority && system.seating.seats.length === 0 && !activeModule,
      canPrepareSeats: isAuthority && system.seating.seats.length === 0 && Boolean(activeModule),
      invitationChoices: game.users.filter((user) => !user.isGM).map((user) => ({ user, invited: this.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) })),
      canLockSeating: isAuthority && system.seating.seats.length > 0 && system.seating.seats.every((seat) => seat.userId && seat.ready),
      hasMySeat: Boolean(mySeat),
      mySeatReady: Boolean(mySeat?.ready),
      seating: system.seating.seats.map((seat) => {
        const user = game.users.get(seat.userId);
        return {
          ...seat,
          angle: ((seat.position + 1) / (system.seating.seats.length + 1)) * 360,
          user,
          isMine: !game.user.isGM && seat.userId === game.user.id,
          canTake: Boolean(!game.user.isGM && system.seating.invitedUserIds.includes(game.user.id) && !seat.userId)
        };
      }),
      showSeatingReference: system.seating.locked && ["setup", "traits", "moments", "brinks", "stacks", "concepts", "inventory", "recording"].includes(system.phase),
      showDistribution: isAuthority && system.seating.locked && system.phase === "brinks",
      canSaveGmBrink: system.phase === "brinks",
      gmBrinkLocked: Boolean(system.creation.gmBrinkReady),
      gmBrinkRecipientName: game.users.get(system.seating.seats[0]?.userId)?.name ?? game.i18n.localize("TENCANDLES.Common.None"),
      canConfigureSeating: isAuthority,
      distributionComplete: Boolean(system.creation.distributedAt),
      hasAvailableThemBrink: Boolean(availableThemBrink),
      conflict: {
        ...conflict,
        hasHopeDice: conflict.availableHopeDiceCount > 0,
        gmHasDice: conflict.gmDiceCount > 0,
        gmRollComplete: conflict.gmDiceCount > 0 && conflict.gmRolled,
        waitingForPlayer: !conflict.playerRolled,
        waitingForGm: !conflict.gmRolled,
        activeActorName: conflictActor?.name ?? "",
        burnedTrait: conflict.traitRerolled ? (() => {
          const card = conflictActor?.items.get(conflict.activeItemId);
          return {
            actorName: conflictActor?.name ?? "",
            cardName: game.i18n.localize(`TENCANDLES.Item.${conflict.activeCardKind === "vice" ? "Vice" : "Virtue"}`),
            text: card?.system.text ?? card?.name ?? ""
          };
        })() : null,
        playerDice: decorateDice(conflict.playerResults, "standard"),
        hopeDice: decorateDice(conflict.hopeResults, "hope"),
        gmDice: decorateDice(conflict.gmResults, "gm"),
        narrationName: conflict.narrationOwner === "player"
          ? game.actors.get(conflict.sacrificeActorId)?.name ?? conflictActor?.name ?? game.i18n.localize("TENCANDLES.Fields.Player")
          : authorityName,
        canBurnTrait: isActiveConflictUser && conflict.availableReactions.includes("trait"),
        canEmbraceBrink: isActiveConflictUser && conflict.availableReactions.includes("brink"),
        brinkHeldAfterReroll: Boolean(conflict.brinkEmbraced && conflict.success),
        canUseThemBrink: isAuthority && conflict.availableReactions.includes("themBrink"),
        canSeizeNarration: isActiveConflictUser && conflict.availableReactions.includes("seize"),
        narrationCandleChoices: system.candles.flatMap((candle, index) => candle.state === "lit" ? [{
          id: candle.id,
          number: index + 1,
          selected: candle.id === conflict.chosenCandleId
        }] : []),
        canSeizeFinalNarration: isActiveConflictUser && conflict.availableReactions.includes("seize") && Boolean(finalLitCandleId),
        finalLitCandleId,
        canSacrifice: Boolean(personalSurvivor?.system.alive && conflict.availableReactions.includes("sacrifice")),
        canPassHope: transferableHopeDice > 0 && sacrificeRecipients.length > 0,
        canAccept: conflict.status === "rolled" && isActiveConflictUser,
        awaitingPlayerDecision: conflict.status === "rolled" && !isActiveConflictUser,
        canFinishNarration: conflict.status === "narrating" && (conflict.narrationOwner === "gm" ? isAuthority : isActiveConflictUser),
        awaitingNarration: conflict.status === "narrating"
      },
      conflictIdle: conflict.status === "idle",
      conflictOpen: conflict.status === "open",
      conflictRolled: conflict.status === "rolled",
      conflictNarrating: conflict.status === "narrating",
      canOpenConflict: isAuthority && ["scene", "lastStand"].includes(system.phase) && conflict.status === "idle" && livingSurvivors.length > 0,
      canRollPlayerConflict: conflict.activeUserId === game.user.id && conflict.status === "open" && !conflict.playerRolled,
      canRollGmConflict: isAuthority && conflict.status === "open" && conflict.playerRolled && !conflict.gmRolled,
      canCancelConflict: isAuthority && conflict.status === "open",
      canSelectNarrationCandle,
      choosingNarrationCandle: conflict.status === "rolled" && conflict.choosingNarrationCandle,
      narrationChooserName: conflictActor?.name ?? game.users.get(conflict.activeUserId)?.name ?? game.i18n.localize("TENCANDLES.Actor.Survivor"),
      isNarrationChooser: isActiveConflictUser,
      activeMoments,
      hasActiveMoments: activeMoments.length > 0,
      conflictSurvivors: livingSurvivors.map((survivor, index) => {
        const activeItem = survivor.items.get(survivor.system.stack.activeItemId);
        return {
          actor: survivor,
          selected: index === 0,
          userId: survivor.system.playerUserId,
          playerName: game.users.get(survivor.system.playerUserId)?.name ?? survivor.name,
          hopeDice: survivor.system.hopeDice + survivor.system.transferredHopeDice,
          activeCard: activeItem ? { id: activeItem.id, type: activeItem.type, kind: activeItem.system.kind ?? null } : null
        };
      }),
      sacrificeRecipients
    };
  }

  #canParticipate(user) {
    if (!user) return false;
    return user.isGM
      || this.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)
      || this.actor.system.survivorActorIds.some((actorId) => game.actors.get(actorId)?.system.playerUserId === user.id);
  }

  static async #activateRitual() {
    if (game.paused) {
      await game.togglePause(false, { broadcast: true });
      ui.notifications.info(game.i18n.localize("TENCANDLES.Ritual.PauseRemoved"));
    }
    return RitualService.execute(this.actor, "session.activate");
  }

  /** @this {RitualTable} */
  static async #advancePreparation() {
    if (this.actor.system.phase === "brinks" && !this.actor.system.creation.distributedAt) {
      try {
        await DistributionService.distribute(this.actor, this.#preparationDrafts.get("[data-gm-brink]") ?? "");
      } catch (error) {
        ui.notifications.warn(localizeError(error));
        return;
      }
    }
    return RitualService.execute(this.actor, "session.advancePreparation");
  }

  static async #startRecording() {
    try {
      await RecordingService.start(this.actor.id);
      await this.render({ parts: ["table"] });
    } catch (error) {
      ui.notifications.warn(localizeError(error));
    }
  }

  static async #stopRecording() {
    try {
      await RecordingService.stop(this.actor.id);
      await this.render({ parts: ["table"] });
    } catch (error) {
      ui.notifications.warn(localizeError(error));
    }
  }

  static async #discardRecording() {
    RecordingService.discard(this.actor.id);
    await this.render({ parts: ["table"] });
  }

  static async #submitRecording() {
    // Upload first: the shared recording entry must reference a persistent file,
    // never a blob: URL that only this browser can resolve.
    try {
      const uploaded = await RecordingService.upload(this.actor.id, game.user.id);
      const result = await RitualService.execute(this.actor, "recording.submit", uploaded);
      if (result?.ok) {
        RecordingService.discard(this.actor.id);
        await this.render({ parts: ["table"] });
      }
    } catch (error) {
      ui.notifications.warn(localizeError(error));
    }
  }

  static async #passRecording() {
    if (!window.confirm(game.i18n.localize("TENCANDLES.Recording.PassWarning"))) return;
    const result = await RitualService.execute(this.actor, "recording.pass");
    if (result?.ok) {
      RecordingService.discard(this.actor.id);
      await this.render({ parts: ["table"] });
    }
    return result;
  }

  static async #requestRecordingRetake() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("TENCANDLES.Recording.RetakeTitle") },
      content: `<p>${game.i18n.localize("TENCANDLES.Recording.RetakeExplanation")}</p>`,
      yes: { label: game.i18n.localize("TENCANDLES.Recording.ConfirmRetake") },
      no: { label: game.i18n.localize("TENCANDLES.Recording.CancelRetake") }
    });
    if (!confirmed) return;
    return RitualService.execute(this.actor, "recording.requestRetake");
  }

  static #sealRecordings() { return RitualService.execute(this.actor, "recording.seal"); }

  static #skipRecordings() {
    if (!window.confirm(game.i18n.localize("TENCANDLES.Recording.SkipWarning"))) return;
    return RitualService.execute(this.actor, "recording.skip");
  }

  static #extinguishFinalCandle() {
    return RitualService.execute(this.actor, "lastStand.extinguishFinalCandle");
  }

  static #confirmFinalFormula() {
    return RitualService.execute(this.actor, "epilogue.confirmFormula");
  }

  static #advanceEpilogueRecording() {
    return RitualService.execute(this.actor, "epilogue.advanceRecording");
  }

  static #playEpilogueRecording() {
    return this.element?.querySelector?.("[data-epilogue-audio]")?.play();
  }

  static #endRitual() {
    return RitualService.execute(this.actor, "epilogue.end");
  }

  /** @this {RitualTable} */
  static #extinguishCandle(_event, target) {
    return this.#requestExtinction(target.dataset.candleId);
  }

  /** @this {RitualTable} */
  static async #openConflict(_event, target) {
    const panel = target.closest(".tc-conflict-panel");
    const actorId = panel.querySelector("[data-conflict-actor]:checked")?.value;
    const actor = game.actors.get(actorId);
    const item = actor?.items.get(actor.system.stack.activeItemId);
    const themActor = game.actors.get(this.actor.system.themActorId) ?? game.actors.find((candidate) => candidate.type === "them");
    const themBrink = themActor?.items.find((candidate) => candidate.type === "brink" && candidate.system.state !== "burned");
    const result = await RitualService.execute(this.actor, "conflict.open", {
      activeActorId: actor?.id,
      activeUserId: actor?.system.playerUserId,
      dire: panel.querySelector("[data-conflict-dire]")?.checked,
      momentDeclared: false,
      themInvolved: panel.querySelector("[data-conflict-them]")?.checked,
      themActorId: themActor?.id,
      themBrinkItemId: themBrink?.id,
      availableHopeDiceCount: actor ? actor.system.hopeDice + actor.system.transferredHopeDice : 0,
      activeCard: item ? { id: item.id, type: item.type, kind: item.system.kind ?? null } : null
    });
    if (result?.ok) {
      this.#conflictLauncherOpen = false;
      this.#conflictDraft = null;
      this.#useHopeDice = false;
    }
    return result;
  }

  static #openMomentConflict() {
    const survivor = game.actors.find((actor) => actor.type === "survivor"
      && actor.system.sessionActorId === this.actor.id
      && actor.system.playerUserId === game.user.id);
    const moment = survivor?.items.get(survivor.system.stack.activeItemId);
    if (!survivor || moment?.type !== "moment") {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Moment.NoActiveMoment"));
      return;
    }
    return RitualService.execute(this.actor, "conflict.openMoment", {
      activeUserId: game.user.id,
      activeActorId: survivor.id,
      activeCard: { id: moment.id, type: moment.type, kind: moment.system.kind ?? null },
      availableHopeDiceCount: survivor.system.hopeDice + survivor.system.transferredHopeDice,
      momentDeclared: true,
      dire: false,
      themInvolved: false
    });
  }

  static async #rollPlayerConflict(_event, target) {
    const useHopeDice = Boolean(target.closest(".tc-conflict-panel")?.querySelector("[data-conflict-hope]")?.checked);
    const conflict = this.actor.system.conflict;
    const hopeDiceCount = useHopeDice ? conflict.availableHopeDiceCount : 0;
    const rolls = {
      player: await ConflictRollService.rollForCurrentUser(conflict.commonDiceCount),
      hope: await ConflictRollService.rollForCurrentUser(hopeDiceCount)
    };
    return RitualService.execute(this.actor, "conflict.rollPlayer", { useHopeDice, hopeDiceCount, rolls });
  }

  static async #rollGmConflict() {
    const conflict = this.actor.system.conflict;
    const rolls = { gm: await ConflictRollService.rollForCurrentUser(conflict.gmDiceCount) };
    return RitualService.execute(this.actor, "conflict.rollGm", { rolls });
  }
  static #cancelConflict() { return RitualService.execute(this.actor, "conflict.cancel"); }
  static async #burnTrait() {
    const conflict = this.actor.system.conflict;
    const rerolls = await ConflictRollService.rollForCurrentUser(conflict.playerResults.filter((result) => result === 1).length);
    return RitualService.execute(this.actor, "conflict.burnTrait", { rerolls });
  }
  static async #embraceBrink() {
    const conflict = this.actor.system.conflict;
    const rolls = {
      player: await ConflictRollService.rollForCurrentUser(conflict.commonDiceCount),
      hope: await ConflictRollService.rollForCurrentUser(conflict.hopeDiceCount)
    };
    return RitualService.execute(this.actor, "conflict.embraceBrink", { rolls });
  }
  static #beginNarrationSeizure() { return RitualService.execute(this.actor, "conflict.beginNarrationSeizure"); }
  static async #useThemBrink() {
    const conflict = this.actor.system.conflict;
    const rerolls = await ConflictRollService.rollForCurrentUser(conflict.gmDiceCount);
    return RitualService.execute(this.actor, "conflict.useThemBrink", { rerolls });
  }
  static #seizeNarration(_event, target) { return RitualService.execute(this.actor, "conflict.seizeNarration", { candleId: target.dataset.candleId }); }
  static #acceptConflict() { return RitualService.execute(this.actor, "conflict.accept", { resolutionText: "" }); }
  static #debugRecording() { return RitualService.execute(this.actor, "debug.recording"); }
  static #debugPlayback() { return RitualService.execute(this.actor, "debug.playback"); }
  static #finishConflictNarration() { return RitualService.execute(this.actor, "conflict.finishNarration"); }

  static #sacrificeSurvivor(_event, target) {
    const actor = game.actors.find((candidate) => candidate.type === "survivor" && candidate.system.playerUserId === game.user.id && candidate.system.sessionActorId === this.actor.id);
    const recipientActorId = target.closest(".tc-conflict-panel")?.querySelector("[data-hope-recipient]")?.value || null;
    return RitualService.execute(this.actor, "conflict.sacrifice", { actorId: actor?.id, recipientActorId });
  }

  /** @this {RitualTable} */
  static #extinguishNextCandle() {
    const candle = this.actor.system.candles.find((candidate) => candidate.state === "lit");
    if (!candle) return;
    return this.#requestExtinction(candle.id);
  }

  #requestExtinction(candleId) {
    return RitualService.execute(this.actor, "candle.extinguish", {
      candleId,
      cause: "manual",
      firstSpeakerUserId: game.user.id,
      participantOrder: [game.user.id]
    });
  }

  static async #editTruth(_event, target) {
    if (!game.user.isGM) return;
    const truth = this.actor.system.truths.find((entry) => entry.id === target.dataset.truthId);
    if (truth?.kind !== "spoken") return;
    const text = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("TENCANDLES.Table.EditTruth") },
      content: `<textarea name="truthText" rows="5" required>${foundry.utils.escapeHTML(truth.text)}</textarea>`,
      ok: {
        label: game.i18n.localize("TENCANDLES.Table.SaveTruth"),
        callback: (_event, button) => button.form.elements.truthText.value
      },
      rejectClose: false
    });
    if (typeof text !== "string") return;
    if (!text.trim()) return ui.notifications.warn(game.i18n.localize("TENCANDLES.Ritual.TruthRequired"));
    return RitualService.execute(this.actor, "truth.edit", { truthId: truth.id, text });
  }

  /** @this {RitualTable} */
  static async #submitTruth(_event, target) {
    const input = target.closest(".tc-table-truth-entry")?.querySelector("[data-truth-input]");
    const text = input?.value?.trim();
    if (!text) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Ritual.TruthRequired"));
      return;
    }
    this.#preparationDrafts.set("[data-truth-input]", input.value);
    const result = await RitualService.execute(this.actor, "truth.submit", { text });
    if (result?.ok) {
      const current = this.element?.querySelector?.("[data-truth-input]");
      // A render may have replaced the input while the command was in flight.
      // Clear only the submitted draft, preserving any newly typed text.
      if (current?.value.trim() === text) current.value = "";
      if (this.#preparationDrafts.get("[data-truth-input]")?.trim() === text) {
        this.#preparationDrafts.delete("[data-truth-input]");
      }
    }
    return result;
  }

  static #closeTruthRound() {
    return RitualService.execute(this.actor, "truth.closeRound");
  }

  static async #prepareSeats(_event, target) {
    const activeModule = this.actor.items.get(this.actor.system.activeModuleItemId) ?? this.actor.items.find((item) => item.type === "module");
    if (!activeModule) return ui.notifications.warn(game.i18n.localize("TENCANDLES.Seating.ModuleRequired"));
    const panel = target.closest(".tc-seating-vestibule");
    const userIds = [...panel.querySelectorAll("[data-invited-user]:checked")].map((input) => input.value);
    if (userIds.length < 2) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Seating.NotEnoughInvited"));
      return;
    }
    const ownership = { ...this.actor.ownership };
    for (const user of game.users.filter((candidate) => !candidate.isGM)) {
      ownership[user.id] = userIds.includes(user.id) ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
    }
    await this.actor.update({ ownership });
    return RitualService.execute(this.actor, "seating.configure", { userIds });
  }

  static #takeSeat(_event, target) {
    return RitualService.execute(this.actor, "seating.take", { position: Number(target.dataset.position), userId: game.user.id });
  }

  static #confirmSeat() {
    return RitualService.execute(this.actor, "seating.confirm", { userId: game.user.id, ready: true });
  }

  static #changeSeat() {
    return RitualService.execute(this.actor, "seating.confirm", { userId: game.user.id, ready: false });
  }

  /** @this {RitualTable} */
  static async #lockSeating() {
    try {
      await this.#ensureSeatedSurvivors();
      return RitualService.execute(this.actor, "seating.lock");
    } catch (error) {
      ui.notifications.warn(localizeError(error));
      return { ok: false, error: { code: "SEATING_PREPARATION_FAILED", message: error.message } };
    }
  }

  async #ensureSeatedSurvivors() {
    // Seat order is the card-passing order. Reuse each player's eligible Actor
    // and persist the links before locking seating so later phases share it.
    const seats = this.actor.system.seating.seats.map((seat) => ({ ...seat }));
    const survivorIds = [];
    for (const seat of seats) {
      let survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.playerUserId === seat.userId
        && (!actor.system.sessionActorId || actor.system.sessionActorId === this.actor.id));
      if (!survivor) {
        const user = game.users.get(seat.userId);
        survivor = await CONFIG.Actor.documentClass.create({
          name: user.name,
          type: "survivor",
          ownership: { default: 0, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
          system: { playerUserId: user.id, sessionActorId: this.actor.id }
        });
      } else await survivor.update({ "system.playerUserId": seat.userId, "system.sessionActorId": this.actor.id });
      seat.survivorActorId = survivor.id;
      survivorIds.push(survivor.id);
    }
    await this.actor.update({ "system.seating.seats": seats, "system.survivorActorIds": survivorIds });
  }

  static async #submitTraits(_event, target) {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (!survivor || this.actor.system.phase !== "traits") return;
    const container = target.closest(".tc-trait-writing");
    const virtueText = container?.querySelector("[data-virtue-input]")?.value.trim();
    const viceText = container?.querySelector("[data-vice-input]")?.value.trim();
    if (!virtueText || !viceText) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Creation.BothTraitsRequired"));
      return;
    }
    const virtue = survivor.items.find((item) => item.type === "trait" && item.system.kind === "virtue");
    const vice = survivor.items.find((item) => item.type === "trait" && item.system.kind === "vice");
    if (virtue) await virtue.update({ "system.text": virtueText, "system.authoredByUserId": game.user.id });
    else await survivor.createEmbeddedDocuments("Item", [{ name: game.i18n.localize("TENCANDLES.Item.Virtue"), type: "trait", system: { kind: "virtue", text: virtueText, authoredByUserId: game.user.id } }]);
    if (vice) await vice.update({ "system.text": viceText, "system.authoredByUserId": game.user.id });
    else await survivor.createEmbeddedDocuments("Item", [{ name: game.i18n.localize("TENCANDLES.Item.Vice"), type: "trait", system: { kind: "vice", text: viceText, authoredByUserId: game.user.id } }]);
    await survivor.update({ "system.ready.traits": true });
  }

  static async #unlockTraits() {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (survivor && this.actor.system.phase === "traits") await survivor.update({ "system.ready.traits": false });
  }

  static async #submitConcept(_event, target) {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (!survivor || this.actor.system.phase !== "concepts") return;
    const container = target.closest(".tc-concept-writing");
    const name = container?.querySelector("[data-concept-name]")?.value.trim();
    const look = container?.querySelector("[data-concept-look]")?.value.trim();
    const summary = container?.querySelector("[data-concept-summary]")?.value.trim();
    if (!name || !look || !summary) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Creation.ConceptRequired"));
      return;
    }
    await survivor.update({ name, "system.concept.look": look, "system.concept.summary": summary, "system.ready.concept": true });
  }

  static async #unlockConcept() {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (survivor && this.actor.system.phase === "concepts") await survivor.update({ "system.ready.concept": false });
  }

  static async #submitMoment(_event, target) {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (!survivor || this.actor.system.phase !== "moments") return;
    const text = target.closest(".tc-moment-writing")?.querySelector("[data-moment-input]")?.value.trim();
    if (!text) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Creation.MomentRequired"));
      return;
    }
    const moment = survivor.items.find((item) => item.type === "moment");
    if (moment) await moment.update({ "system.text": text, "system.authoredByUserId": game.user.id });
    else await survivor.createEmbeddedDocuments("Item", [{
      name: game.i18n.localize("TENCANDLES.Item.Moment"),
      type: "moment",
      system: { text, authoredByUserId: game.user.id }
    }]);
    await survivor.update({ "system.ready.moment": true });
  }

  static async #unlockMoment() {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (survivor && this.actor.system.phase === "moments") await survivor.update({ "system.ready.moment": false });
  }

  static async #submitBrink(_event, target) {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (!survivor || this.actor.system.phase !== "brinks") return;
    const text = target.closest(".tc-brink-writing")?.querySelector("[data-brink-input]")?.value.trim();
    if (!text) return ui.notifications.warn(game.i18n.localize("TENCANDLES.Creation.BrinkRequired"));
    const seatIndex = this.actor.system.seating.seats.findIndex((seat) => seat.userId === game.user.id);
    const subject = seatIndex === this.actor.system.seating.seats.length - 1 ? "them" : "survivor";
    const brink = survivor.items.find((item) => item.type === "brink");
    if (brink) await brink.update({ "system.text": text, "system.subject": subject, "system.authoredByUserId": game.user.id });
    else await survivor.createEmbeddedDocuments("Item", [{ name: game.i18n.localize("TENCANDLES.Item.Brink"), type: "brink", system: { text, subject, authoredByUserId: game.user.id } }]);
    await survivor.update({ "system.ready.brink": true });
  }

  static async #unlockBrink() {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    if (survivor && this.actor.system.phase === "brinks") await survivor.update({ "system.ready.brink": false });
  }

  /** @this {RitualTable} */
  static async #saveGmBrink(_event, target) {
    const text = target.closest(".tc-gm-brink-panel")?.querySelector("[data-gm-brink]")?.value.trim();
    if (!text) return ui.notifications.warn(game.i18n.localize("TENCANDLES.Creation.GmBrinkRequired"));
    this.#preparationDrafts.set("[data-gm-brink]", text);
    await this.actor.update({ "system.creation.gmBrinkReady": true });
  }

  static #unlockGmBrink() {
    if (this.actor.system.phase === "brinks") return this.actor.update({ "system.creation.gmBrinkReady": false });
  }

  static #openSurvivorSheet() {
    const survivor = game.actors.find((actor) => actor.type === "survivor" && actor.system.sessionActorId === this.actor.id && actor.system.playerUserId === game.user.id);
    return survivor?.sheet.render({ force: true });
  }

  static #openCharacterSheet(_event, target) {
    // Recheck membership and ownership here: editing a data-actor-id in the DOM
    // must not turn the public portrait roster into access to another sheet.
    const actor = game.actors.get(target.dataset.actorId);
    if (!actor) return;
    const isSurvivor = actor.type === "survivor" && this.actor.system.survivorActorIds.includes(actor.id);
    const isThem = actor.type === "them" && (this.actor.system.themActorId
      ? actor.id === this.actor.system.themActorId
      : actor.id === game.actors.find((candidate) => candidate.type === "them")?.id);
    if (!isSurvivor && !isThem) return;
    if (!game.user.isGM && !(isSurvivor && actor.system.playerUserId === game.user.id && actor.isOwner)) return;
    return actor.sheet.render({ force: true });
  }

}

