import { BaseActorSheet } from "./base-actor-sheet.mjs";
import { AuthorityService } from "../modules/services/authority-service.mjs";
import { RitualTable } from "../applications/ritual-table/ritual-table.mjs";

// Configuration view of the session Actor. RitualTable is a separate play view
// over the same document; opening it closes this sheet, not the underlying game.
export class RitualSheet extends BaseActorSheet {
  /**
   * ActorSheetV2 disables every form control when a user cannot edit the
   * document. Ritual participants still need to use command-backed controls
   * (such as the truth input), without gaining permission to update the Actor.
   */
  get isEditable() {
    return super.isEditable || this.#canParticipate(game.user);
  }

  static DEFAULT_OPTIONS = {
    classes: ["tc-ritual-sheet"],
    position: { width: 680, height: 720 },
    dragDrop: [{ dropSelector: "[data-module-drop]" }],
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      openRitualTable: RitualSheet.#openRitualTable,
      chooseModule: RitualSheet.#chooseModule,
      randomModule: RitualSheet.#randomModule,
      createPersonalModule: RitualSheet.#createPersonalModule,
      openActiveModule: RitualSheet.#openActiveModule
    }
  };

  static PARTS = {
    form: {
      template: "systems/ten-candles/templates/sheets/ritual-sheet.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { system } = this.actor;
    const moduleChoices = [
      ...game.items.filter((item) => item.type === "module").map((item) => ({ uuid: item.uuid, name: item.name, group: game.i18n.localize("TENCANDLES.Module.PersonalModules") }))
    ];
    for (const pack of game.packs.filter((candidate) => candidate.documentName === "Item" && ["ten-candles.modules-fr", "ten-candles.modules-en"].includes(candidate.collection))) {
      const index = await pack.getIndex({ fields: ["type"] });
      const group = game.i18n.localize(pack.collection === "ten-candles.modules-fr" ? "TENCANDLES.Module.FrenchModules" : "TENCANDLES.Module.EnglishModules");
      moduleChoices.push(...index.filter((entry) => entry.type === "module").map((entry) => ({ uuid: `Compendium.${pack.collection}.${entry._id}`, name: entry.name, group })));
    }
    const activeModule = this.actor.items.get(system.activeModuleItemId) ?? this.actor.items.find((item) => item.type === "module") ?? null;
    return {
      ...context,
      authorityName: AuthorityService.user?.name ?? game.i18n.localize("TENCANDLES.Network.NoActiveGmShort"),
      statusLabel: game.i18n.localize(`TENCANDLES.Status.${system.status}`),
      phaseLabel: game.i18n.localize(`TENCANDLES.Phase.${system.phase}`),
      litCandleCount: system.candles.filter((candle) => candle.state === "lit").length,
      candleEnvironmentChoices: ["gale", "convention", "livingRoom", "none"].map((value) => ({
        value,
        label: game.i18n.localize(`TENCANDLES.CandleClock.Environment.${value}.Name`),
        description: game.i18n.localize(`TENCANDLES.CandleClock.Environment.${value}.Description`),
        selected: system.candleEnvironment === value
      })),
      recordingPlaybackOrderChoices: ["death", "recording"].map((value) => ({
        value,
        label: game.i18n.localize(`TENCANDLES.Recording.PlaybackOrder.${value}`),
        selected: system.recording.playbackOrder === value
      })),
      moduleChoices,
      hasModuleChoices: moduleChoices.length > 0,
      activeModule,
      showModuleSection: Boolean(activeModule) || (game.user.isGM && this.actor.isOwner),
      showGmConfiguration: game.user.isGM,
      canConfigurePhysical: game.user.isGM && this.actor.isOwner && system.status === "draft",
      canConfigureModule: game.user.isGM && this.actor.isOwner
    };
  }

  async _onDrop(event) {
    event.preventDefault();
    if (!game.user.isGM || !this.actor.isOwner || !event.target.closest("[data-module-drop]")) return;
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data.type !== "Item") return;
    const source = await Item.implementation.fromDropData(data);
    if (source?.type !== "module") return ui.notifications.warn(game.i18n.localize("TENCANDLES.Module.InvalidDrop"));
    await this.#applyModule(source);
  }

  async #applyModule(source) {
    // Embed a snapshot of the chosen module in this session. Editing the game
    // copy must not alter the reusable world Item or compendium entry.
    const previous = this.actor.items.filter((item) => item.type === "module");
    if (previous.length) await this.actor.deleteEmbeddedDocuments("Item", previous.map((item) => item.id));
    const data = source.toObject();
    delete data._id;
    delete data.folder;
    const [embedded] = await this.actor.createEmbeddedDocuments("Item", [data]);
    await this.actor.update({ "system.activeModuleItemId": embedded.id });
    await this.render();
  }

  static async #openRitualTable() {
    const table = RitualTable.open(this.actor);
    await this.close();
    return table;
  }

  static async #randomModule() {
    if (!game.user.isGM || !this.actor.isOwner) return;
    const select = this.element?.querySelector?.("[data-module-choice]");
    const choices = Array.from(select?.options ?? []).filter((option) => option.value && !option.disabled);
    if (!choices.length) return;
    const roll = await new Roll(`1d${choices.length}`).evaluate();
    select.value = choices[roll.total - 1].value;
    select.focus();
  }

  static async #chooseModule() {
    const uuid = this.element?.querySelector?.("[data-module-choice]")?.value;
    const source = uuid ? await fromUuid(uuid) : null;
    if (source?.type !== "module") return ui.notifications.warn(game.i18n.localize("TENCANDLES.Module.ChooseRequired"));
    return this.#applyModule(source);
  }

  static async #createPersonalModule() {
    const item = await Item.create({ name: game.i18n.localize("TENCANDLES.Module.NewName"), type: "module", system: { language: game.i18n.lang === "fr" ? "fr" : "en" } }, { renderSheet: true });
    return item;
  }

  static #openActiveModule() {
    return (this.actor.items.get(this.actor.system.activeModuleItemId) ?? this.actor.items.find((item) => item.type === "module"))?.sheet?.render(true);
  }

  #canParticipate(user) {
    if (!user || !this.actor) return false;
    return user.isGM
      || this.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)
      || this.actor.system.survivorActorIds.some((actorId) => {
        const survivor = game.actors.get(actorId);
        return survivor?.system.playerUserId === user.id;
      });
  }

}
