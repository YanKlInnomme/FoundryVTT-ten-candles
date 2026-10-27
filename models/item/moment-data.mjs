import { CardData } from "./card-data.mjs";

export class MomentData extends CardData {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      ...super.defineSchema(),
      outcome: new f.StringField({
        required: true,
        nullable: true,
        initial: null,
        choices: ["hope", "lost"]
      }),
      resolvedAt: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 0 }),
      resolvedInScene: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 1, max: 10 })
    };
  }
}
