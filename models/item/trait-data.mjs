import { CardData } from "./card-data.mjs";

export class TraitData extends CardData {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      ...super.defineSchema(),
      kind: new f.StringField({
        required: true,
        nullable: false,
        initial: "virtue",
        choices: ["virtue", "vice"]
      }),
      burnedInScene: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 1, max: 10 })
    };
  }
}
