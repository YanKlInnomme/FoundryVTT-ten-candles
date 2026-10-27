import { CardData } from "./card-data.mjs";
import { stringArrayField, timestampField } from "../shared-fields.mjs";

export class BrinkData extends CardData {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      ...super.defineSchema(),
      context: new f.StringField({ required: true, nullable: false, initial: "" }),
      subject: new f.StringField({
        required: true,
        nullable: false,
        initial: "survivor",
        choices: ["survivor", "them"]
      }),
      knownByUserIds: stringArrayField(),
      revealedAt: timestampField()
    };
  }
}
