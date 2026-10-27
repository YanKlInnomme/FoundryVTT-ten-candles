import { idField, schemaVersionField, stringArrayField } from "../shared-fields.mjs";

export class SurvivorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      schemaVersion: schemaVersionField(),
      playerUserId: idField(),
      sessionActorId: idField(),
      concept: new f.SchemaField({
        look: new f.StringField({ required: true, nullable: false, initial: "" }),
        summary: new f.StringField({ required: true, nullable: false, initial: "" })
      }),
      alive: new f.BooleanField({ required: true, nullable: false, initial: true }),
      death: new f.SchemaField({
        sceneNumber: new f.NumberField({ required: true, nullable: true, initial: null, integer: true, min: 1, max: 10 }),
        narratedByUserId: idField(),
        summary: new f.StringField({ required: true, nullable: false, initial: "" })
      }),
      stack: new f.SchemaField({
        // Embedded Item collection order is not play order. Store an explicit
        // top-to-bottom list and move activeItemId forward as cards are burned.
        locked: new f.BooleanField({ required: true, nullable: false, initial: false }),
        itemIds: stringArrayField(),
        activeItemId: idField()
      }),
      hopeDice: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
      transferredHopeDice: new f.NumberField({ required: true, nullable: false, initial: 0, integer: true, min: 0 }),
      inventoryNote: new f.StringField({ required: true, nullable: false, initial: "" }),
      ready: new f.SchemaField({
        traits: new f.BooleanField({ required: true, nullable: false, initial: false }),
        concept: new f.BooleanField({ required: true, nullable: false, initial: false }),
        moment: new f.BooleanField({ required: true, nullable: false, initial: false }),
        brink: new f.BooleanField({ required: true, nullable: false, initial: false }),
        stack: new f.BooleanField({ required: true, nullable: false, initial: false }),
        inventory: new f.BooleanField({ required: true, nullable: false, initial: false }),
        recording: new f.BooleanField({ required: true, nullable: false, initial: false })
      })
    };
  }
}
