import { idField, schemaVersionField } from "../shared-fields.mjs";

export class ThemData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      schemaVersion: schemaVersionField(),
      sessionActorId: idField(),
      notes: new f.StringField({ required: true, nullable: false, initial: "" })
    };
  }
}
