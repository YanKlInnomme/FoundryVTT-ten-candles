const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class BaseActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["ten-candles", "tc-sheet", "tc-actor-sheet"],
    position: {
      width: 560,
      height: 620
    },
    form: {
      submitOnChange: true,
      closeOnSubmit: false
    },
    window: { resizable: true }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      actor: this.actor,
      system: this.actor.system,
      // A specialized sheet may allow limited interactions to non-owners while
      // keeping document fields read-only. Never derive field editability from
      // that broader interaction permission.
      editable: this.actor.isOwner,
      candles: this.actor.type === "session"
        ? this.actor.system.candles.map((candle, index) => ({ candle, label: index + 1 }))
        : []
    };
  }
}
