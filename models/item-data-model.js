/**
 * Earlier generic Item model, retained but not registered by the v14 entry point.
 * Active per-type schemas are wired in register-data-models.mjs; change those
 * schemas when adding fields to current cards or modules.
 */
export class TenCandlesItemDataModel extends foundry.abstract.DataModel {
  /** @override */
  static defineSchema() {
    const fields = foundry.data.fields;
    
    const baseSchema = {
      description: new fields.StringField({required: false, initial: ""}),
      burned: new fields.BooleanField({required: true, initial: false})
    };

    return baseSchema;
  }

  /** @override */
  static migrateData(source) {
    if (typeof source.burned === "undefined") source.burned = false;
    if (typeof source.description === "undefined") source.description = "";
    return source;
  }
}
