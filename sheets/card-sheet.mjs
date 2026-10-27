const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class CardSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["ten-candles", "tc-sheet", "tc-card-sheet"],
    position: {
      width: 480,
      height: 440
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    },
    window: { resizable: true }
  };

  static PARTS = {
    form: {
      template: "systems/ten-candles/templates/sheets/card-sheet.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    let textPlaceholder = "TENCANDLES.Card.Placeholder.Moment";
    if (this.item.type === "trait") textPlaceholder = this.item.system.kind === "virtue"
      ? "TENCANDLES.Card.Placeholder.Virtue"
      : "TENCANDLES.Card.Placeholder.Vice";
    if (this.item.type === "brink") textPlaceholder = "TENCANDLES.Card.Placeholder.Brink";
    return {
      ...context,
      item: this.item,
      system: this.item.system,
      editable: this.isEditable,
      isTrait: this.item.type === "trait",
      isMoment: this.item.type === "moment",
      isBrink: this.item.type === "brink",
      isVirtue: this.item.type === "trait" && this.item.system.kind === "virtue",
      isVice: this.item.type === "trait" && this.item.system.kind === "vice",
      textPlaceholder: game.i18n.localize(textPlaceholder),
      contextPlaceholder: game.i18n.localize("TENCANDLES.Card.Placeholder.Context"),
      traitExamples: this.item.type === "trait"
        ? game.i18n.localize(`TENCANDLES.Creation.${this.item.system.kind === "virtue" ? "VirtueExamples" : "ViceExamples"}`)
        : null
    };
  }
}
