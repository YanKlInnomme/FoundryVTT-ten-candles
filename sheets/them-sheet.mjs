import { BaseActorSheet } from "./base-actor-sheet.mjs";

export class ThemSheet extends BaseActorSheet {
  static DEFAULT_OPTIONS = {
    classes: ["tc-them-sheet"],
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      editBrink: ThemSheet.#editBrink
    }
  };

  static PARTS = {
    form: {
      template: "systems/ten-candles/templates/sheets/them-sheet.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      brinks: this.actor.items.filter((item) => item.type === "brink")
    };
  }

  static #editBrink(_event, target) {
    return this.actor.items.get(target.closest("[data-item-id]")?.dataset.itemId)?.sheet.render({ force: true });
  }
}
