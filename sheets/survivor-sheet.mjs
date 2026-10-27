import { BaseActorSheet } from "./base-actor-sheet.mjs";
import { SocketService } from "../modules/services/socket-service.mjs";

function canEditStack(actor) {
  // Players arrange received cards only after distribution. GM card management
  // and player ordering are different permissions, even on an owned Actor.
  if (!actor.isOwner || actor.system.stack.locked) return false;
  if (game.user.isGM) return true;
  const ritual = game.actors.get(actor.system.sessionActorId);
  return Boolean(ritual?.system.creation?.distributedAt && ritual.system.phase === "stacks");
}

function canManageCards(actor) {
  return game.user.isGM && canEditStack(actor);
}

// Keep existing filenames stable when retiring a portrait: saved Actors may
// reference the other images by path. No. 7 is no longer distributed.
const SURVIVOR_PORTRAITS = [1, 2, 3, 4, 5, 6, 8].map((number) => ({
  id: `survivor-${String(number).padStart(2, "0")}`,
  path: `systems/ten-candles/assets/portraits/survivor-${String(number).padStart(2, "0")}.webp`
}));

export class SurvivorSheet extends BaseActorSheet {
  #scrollPositions = new Map();

  static DEFAULT_OPTIONS = {
    classes: ["tc-survivor-sheet"],
    position: { width: 1120, height: 760 },
    scrollY: [".tc-survivor-profile", ".tc-survivor-stack"],
    dragDrop: [{ dragSelector: ".tc-stack-card", dropSelector: "[data-drop-zone]" }],
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      createCard: SurvivorSheet.#createCard,
      editCard: SurvivorSheet.#editCard,
      removeCard: SurvivorSheet.#removeCard,
      moveCardUp: SurvivorSheet.#moveCardUp,
      moveCardDown: SurvivorSheet.#moveCardDown,
      lockStack: SurvivorSheet.#lockStack,
      unlockStack: SurvivorSheet.#unlockStack,
      confirmFinalization: SurvivorSheet.#confirmFinalization,
      unlockFinalization: SurvivorSheet.#unlockFinalization,
      choosePortrait: SurvivorSheet.#choosePortrait
    }
  };

  render(options = {}) {
    // Form submissions rerender both columns; preserve each scroll offset so
    // updating the profile does not jump the independently scrolled card stack.
    for (const element of this.element?.querySelectorAll?.("[data-scroll-key]") ?? []) {
      this.#scrollPositions.set(element.dataset.scrollKey, element.scrollTop);
    }
    return super.render(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const element of this.element?.querySelectorAll?.("[data-scroll-key]") ?? []) {
      const scrollTop = this.#scrollPositions.get(element.dataset.scrollKey);
      if (scrollTop !== undefined) element.scrollTop = scrollTop;
    }
  }

  async _onDrop(event) {
    event.preventDefault();
    if (!event.target.closest("[data-drop-zone]") || !canManageCards(this.actor)) return;
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data.type !== "Item") return;
    const source = await Item.implementation.fromDropData(data);
    if (!source || !["trait", "moment", "brink"].includes(source.type)) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Survivor.InvalidCardDrop"));
      return;
    }
    const duplicate = this.actor.items.some((item) => item.type === source.type
      && (source.type !== "trait" || item.system.kind === source.system.kind));
    if (duplicate) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Survivor.CardAlreadyExists"));
      return;
    }
    const [created] = await this.actor.createEmbeddedDocuments("Item", [source.toObject()]);
    await this.actor.update({ "system.stack.itemIds": [...this.actor.system.stack.itemIds, created.id] });
  }

  static PARTS = {
    form: {
      template: "systems/ten-candles/templates/sheets/survivor-sheet.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const orderedIds = this.actor.system.stack.itemIds;
    const ordered = orderedIds.map((id) => this.actor.items.get(id)).filter(Boolean);
    const unlisted = this.actor.items.filter((item) => !orderedIds.includes(item.id));
    const cards = [...ordered, ...unlisted];
    const hasCard = (preset) => cards.some((item) => item.type === (preset === "virtue" || preset === "vice" ? "trait" : preset)
      && (item.type !== "trait" || item.system.kind === preset));
    const cardPresets = ["virtue", "vice", "moment", "brink"]
      .filter((preset) => !hasCard(preset))
      .map((preset) => ({ preset, label: game.i18n.localize(`TENCANDLES.Item.${preset[0].toUpperCase()}${preset.slice(1)}`) }));
    const stackReady = cards.length === 4 && cards.at(-1)?.type === "brink";
    const linkedRitual = game.actors.get(this.actor.system.sessionActorId);
    const distributionComplete = !linkedRitual || Boolean(linkedRitual.system.creation?.distributedAt);
    const isFinalizationPhase = linkedRitual?.system.phase === "stacks";
    const finalizationReady = Boolean(this.actor.system.ready.concept && this.actor.system.ready.inventory);
    const canEditProfile = context.editable && (game.user.isGM || (isFinalizationPhase && !finalizationReady));
    const profileComplete = Boolean(this.actor.name.trim() && this.actor.system.concept.look.trim()
      && this.actor.system.concept.summary.trim() && this.actor.system.inventoryNote.trim());

    return {
      ...context,
      canAssignPlayer: game.user.isGM,
      playerChoices: game.users.map((user) => ({ id: user.id, name: user.name, selected: user.id === this.actor.system.playerUserId })),
      ritualChoices: game.actors.filter((actor) => actor.type === "session").map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.actor.system.sessionActorId
      })),
      cards: cards.map((item, index) => ({
        item,
        index,
        active: item.id === this.actor.system.stack.activeItemId,
        isTop: index === 0,
        isBottom: index === cards.length - 1,
        label: item.type === "trait" ? game.i18n.localize(`TENCANDLES.Item.${item.system.kind === "virtue" ? "Virtue" : "Vice"}`) : game.i18n.localize(`TENCANDLES.Item.${item.type === "moment" ? "Moment" : "Brink"}`),
        canMoveUp: !this.actor.system.stack.locked && index > 0 && item.type !== "brink",
        canMoveDown: !this.actor.system.stack.locked && index < cards.length - 1
          && (item.type === "brink" || cards[index + 1]?.type !== "brink")
      })),
      cardPresets,
      canBuildStack: context.editable && canEditStack(this.actor),
      canManageCards: context.editable && canManageCards(this.actor),
      stackEditingLocked: context.editable && !this.actor.system.stack.locked && !canEditStack(this.actor),
      canEditProfile,
      canChoosePortrait: context.editable && !game.user.isGM,
      canUseImagePicker: context.editable && game.user.isGM,
      profileEditingLocked: context.editable && !canEditProfile,
      finalizationReady,
      canConfirmFinalization: context.editable && isFinalizationPhase && this.actor.system.stack.locked && profileComplete && !finalizationReady,
      canUnlockFinalization: context.editable && isFinalizationPhase && finalizationReady,
      showFinalizationGuide: context.editable && isFinalizationPhase,
      profileComplete,
      canLockStack: context.editable && !this.actor.system.stack.locked && stackReady && distributionComplete,
      canUnlockStack: context.editable && isFinalizationPhase && this.actor.system.stack.locked && !finalizationReady,
      stackReady,
      distributionComplete,
      hasCards: cards.length > 0
    };
  }

  static async #createCard(_event, target) {
    if (!canManageCards(this.actor)) return;
    const preset = target.dataset.cardPreset;
    const definitions = {
      virtue: { type: "trait", name: game.i18n.localize("TENCANDLES.Item.Virtue"), system: { kind: "virtue" } },
      vice: { type: "trait", name: game.i18n.localize("TENCANDLES.Item.Vice"), system: { kind: "vice" } },
      moment: { type: "moment", name: game.i18n.localize("TENCANDLES.Item.Moment"), system: {} },
      brink: { type: "brink", name: game.i18n.localize("TENCANDLES.Item.Brink"), system: {} }
    };
    const definition = definitions[preset];
    if (!definition) return;
    const existing = this.actor.items.some((item) => item.type === definition.type
      && (definition.type !== "trait" || item.system.kind === preset));
    if (existing) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Survivor.CardAlreadyExists"));
      return;
    }
    const [item] = await this.actor.createEmbeddedDocuments("Item", [definition]);
    await this.actor.update({ "system.stack.itemIds": [...this.actor.system.stack.itemIds, item.id] });
  }

  static #editCard(_event, target) {
    if (!canManageCards(this.actor)) return;
    return this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.sheet.render({ force: true });
  }

  static async #removeCard(_event, target) {
    if (!canManageCards(this.actor)) return;
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.actor.items.get(id);
    if (!item) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("TENCANDLES.Survivor.RemoveCard") },
      content: `<p>${game.i18n.localize("TENCANDLES.Survivor.RemoveCardConfirm")}</p>`
    });
    if (!confirmed) return;
    await this.actor.deleteEmbeddedDocuments("Item", [id]);
    await this.actor.update({
      "system.stack.itemIds": this.actor.system.stack.itemIds.filter((itemId) => itemId !== id),
      "system.stack.activeItemId": this.actor.system.stack.activeItemId === id ? null : this.actor.system.stack.activeItemId
    });
  }

  static #moveCardUp(_event, target) {
    return this.#moveCard(target, -1);
  }

  static #moveCardDown(_event, target) {
    return this.#moveCard(target, 1);
  }

  #moveCard(target, direction) {
    if (!canEditStack(this.actor)) return;
    const id = target.closest("[data-item-id]")?.dataset.itemId;
    const ids = [...this.actor.system.stack.itemIds];
    for (const item of this.actor.items) if (!ids.includes(item.id)) ids.push(item.id);
    const index = ids.indexOf(id);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= ids.length) return;
    const moving = this.actor.items.get(id);
    const displaced = this.actor.items.get(ids[destination]);
    if ((moving?.type === "brink" && direction < 0) || (displaced?.type === "brink" && direction > 0)) return;
    [ids[index], ids[destination]] = [ids[destination], ids[index]];
    return this.actor.update({ "system.stack.itemIds": ids });
  }

  static async #lockStack() {
    if (!canEditStack(this.actor)) return;
    const ids = [...this.actor.system.stack.itemIds];
    for (const item of this.actor.items) if (!ids.includes(item.id)) ids.push(item.id);
    const cards = ids.map((id) => this.actor.items.get(id)).filter(Boolean);
    const hasStandardSet = cards.length === 4
      && cards.filter((item) => item.type === "trait" && item.system.kind === "virtue").length === 1
      && cards.filter((item) => item.type === "trait" && item.system.kind === "vice").length === 1
      && cards.filter((item) => item.type === "moment").length === 1
      && cards.filter((item) => item.type === "brink").length === 1;
    if (!hasStandardSet || cards.at(-1)?.type !== "brink") {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Survivor.InvalidStack"));
      return;
    }
    await this.actor.update({
      "system.stack.locked": true,
      "system.stack.itemIds": ids,
      "system.stack.activeItemId": ids[0],
      "system.ready.stack": true
    });
    await this.actor.updateEmbeddedDocuments("Item", ids.map((id, index) => ({
      _id: id,
      "system.state": index === 0 ? "active" : "buried"
    })));
  }

  static async #unlockStack() {
    const ritual = game.actors.get(this.actor.system.sessionActorId);
    const finalizationReady = this.actor.system.ready.concept && this.actor.system.ready.inventory;
    if (ritual?.system.phase !== "stacks" || !this.actor.system.stack.locked || finalizationReady) return;
    const ids = [...this.actor.system.stack.itemIds];
    await this.actor.update({
      "system.stack.locked": false,
      "system.stack.activeItemId": null,
      "system.ready.stack": false
    });
    if (ids.length) await this.actor.updateEmbeddedDocuments("Item", ids.map((id) => ({ _id: id, "system.state": "draft" })));
  }

  static async #confirmFinalization() {
    // A player's confirmation locks their profile, but does not advance the
    // shared phase. The GM advances only after all Survivors are ready.
    const ritual = game.actors.get(this.actor.system.sessionActorId);
    const complete = this.actor.name.trim() && this.actor.system.concept.look.trim()
      && this.actor.system.concept.summary.trim() && this.actor.system.inventoryNote.trim();
    if (ritual?.system.phase !== "stacks" || !this.actor.system.stack.locked || !complete) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Creation.FinalizationIncomplete"));
      return;
    }
    await this.actor.update({ "system.ready.concept": true, "system.ready.inventory": true });
    ui.notifications.info(game.i18n.localize("TENCANDLES.Creation.FinalizationConfirmed"));
    await this.close();
  }

  static #unlockFinalization() {
    const ritual = game.actors.get(this.actor.system.sessionActorId);
    if (ritual?.system.phase === "stacks") return this.actor.update({ "system.ready.concept": false, "system.ready.inventory": false });
  }

  static async #choosePortrait() {
    if (game.user.isGM || !this.actor.isOwner) return;
    const carouselId = `tc-portraits-${foundry.utils.randomID()}`;
    let selectedUpload = null;
    let proposalSubmitted = false;
    const choices = SURVIVOR_PORTRAITS.map((portrait, index) => `
      <label class="tc-portrait-choice">
        <input type="radio" name="portrait" value="${portrait.path}" ${this.actor.img === portrait.path || (!index && !SURVIVOR_PORTRAITS.some((entry) => entry.path === this.actor.img)) ? "checked" : ""}>
        <img src="${portrait.path}" alt="${game.i18n.format("TENCANDLES.Survivor.PortraitOption", { number: index + 1 })}">
      </label>`).join("");
    const dialog = foundry.applications.api.DialogV2.input({
      window: { title: game.i18n.localize("TENCANDLES.Survivor.PortraitGallery") },
      position: { width: 580 },
      content: `<p>${game.i18n.localize("TENCANDLES.Survivor.PortraitGalleryHint")}</p><div class="tc-portrait-carousel" data-portrait-carousel="${carouselId}"><button type="button" class="tc-portrait-carousel__arrow is-previous" aria-label="${game.i18n.localize("TENCANDLES.Survivor.PreviousPortraits")}"><i class="fa-solid fa-chevron-left"></i></button><div class="tc-portrait-gallery" tabindex="0">${choices}</div><button type="button" class="tc-portrait-carousel__arrow is-next" aria-label="${game.i18n.localize("TENCANDLES.Survivor.NextPortraits")}"><i class="fa-solid fa-chevron-right"></i></button></div><div class="tc-portrait-upload"><strong>${game.i18n.localize("TENCANDLES.Survivor.ProposePortrait")}</strong><p>${game.i18n.localize("TENCANDLES.Survivor.ProposePortraitHint")}</p><small>${game.i18n.localize("TENCANDLES.Survivor.PortraitFormats")}</small><div class="tc-portrait-file"><button type="button" class="tc-choose-portrait-file">${game.i18n.localize("TENCANDLES.Survivor.ChoosePortraitFile")}</button><span>${game.i18n.localize("TENCANDLES.Survivor.NoPortraitFile")}</span><input type="file" name="portraitUpload" accept="image/*,.jpg,.jpeg,.png,.webp" hidden></div><button type="button" class="tc-submit-portrait" disabled>${game.i18n.localize("TENCANDLES.Survivor.SubmitPortraitProposal")}</button></div>`,
      ok: { label: game.i18n.localize("TENCANDLES.Survivor.UsePortrait") }
    });
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const carousel = document.querySelector(`[data-portrait-carousel="${carouselId}"]`);
      const track = carousel?.querySelector(".tc-portrait-gallery");
      if (!track) return;
      carousel.querySelector(".is-previous")?.addEventListener("click", () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: "smooth" }));
      carousel.querySelector(".is-next")?.addEventListener("click", () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: "smooth" }));
      track.querySelector("input:checked")?.closest(".tc-portrait-choice")?.scrollIntoView({ inline: "center", block: "nearest" });
      const fileInput = carousel.closest("form")?.querySelector("[name=portraitUpload]");
      const submit = carousel.closest("form")?.querySelector(".tc-submit-portrait");
      const chooseFile = carousel.closest("form")?.querySelector(".tc-choose-portrait-file");
      const fileName = carousel.closest("form")?.querySelector(".tc-portrait-file span");
      const selectUpload = (file) => {
        selectedUpload = file ?? null;
        if (fileName) fileName.textContent = selectedUpload?.name ?? game.i18n.localize("TENCANDLES.Survivor.NoPortraitFile");
        if (submit) submit.disabled = !selectedUpload;
      };
      fileInput?.addEventListener("change", async () => {
        const file = fileInput.files?.[0] ?? null;
        try {
          await SocketService.validatePortraitFile(file);
          selectUpload(file);
        } catch (error) {
          fileInput.value = "";
          selectUpload(null);
          ui.notifications.warn(error.message);
        }
      });
      chooseFile?.addEventListener("click", () => fileInput?.click());
      submit?.addEventListener("click", async () => {
        if (!selectedUpload) return;
        submit.disabled = true;
        try {
          proposalSubmitted = await SocketService.proposePortrait(this.actor, selectedUpload);
          if (proposalSubmitted) carousel.closest(".application")?.querySelector("[data-action=close]")?.click();
        } catch (error) {
          ui.notifications.error(error.message);
          submit.disabled = false;
        }
      });
    }));
    const result = await dialog;
    if (proposalSubmitted) return;
    const portrait = result?.portrait;
    if (!SURVIVOR_PORTRAITS.some((entry) => entry.path === portrait)) return;
    await this.actor.update({ img: portrait });
  }
}
