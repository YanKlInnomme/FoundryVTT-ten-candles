import { schemaVersionField } from "../shared-fields.mjs";

// A scenario module is a Foundry Item type, not a Foundry add-on package.
// RitualSheet copies it into the session Actor for game-specific edits.
export class ModuleData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      schemaVersion: schemaVersionField(),
      introduction: new f.StringField({ required: true, nullable: false, initial: "" }),
      notablePlaces: new f.StringField({ required: true, nullable: false, initial: "" }),
      goal: new f.StringField({ required: true, nullable: false, initial: "" }),
      notes: new f.StringField({ required: true, nullable: false, initial: "" }),
      author: new f.StringField({ required: true, nullable: false, initial: "" }),
      language: new f.StringField({ required: true, nullable: false, initial: "fr", choices: ["fr", "en"] }),
      sourcePage: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 1 })
    };
  }
}
