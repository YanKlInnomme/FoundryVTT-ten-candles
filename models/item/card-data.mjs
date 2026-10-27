import { CARD_STATES } from "../../modules/constants.mjs";
import { idField, schemaVersionField, timestampField } from "../shared-fields.mjs";

// Shared card lifecycle used by Trait, Moment and Brink models. A burned card
// remains embedded for the graveyard/history instead of being deleted.
export class CardData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      schemaVersion: schemaVersionField(),
      text: new f.StringField({ required: true, nullable: false, initial: "" }),
      state: new f.StringField({
        required: true,
        nullable: false,
        initial: "draft",
        choices: CARD_STATES
      }),
      authoredByUserId: idField(),
      burnedAt: timestampField()
    };
  }
}
