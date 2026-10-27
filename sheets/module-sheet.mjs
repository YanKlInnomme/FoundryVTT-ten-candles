const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class ModuleSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["ten-candles", "tc-sheet", "tc-module-sheet"],
    position: { width: 620, height: 680 },
    form: { submitOnChange: true, closeOnSubmit: false },
    window: { resizable: true }
  };

  static PARTS = { form: { template: "systems/ten-candles/templates/sheets/module-sheet.hbs" } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return { ...context, item: this.item, system: this.item.system, editable: this.isEditable };
  }
}
