// Deal real embedded Items between Actors once, before stack ordering. This is
// GM-only document preparation, separate from the pure session command engine.
// distributedAt records completion; the multi-document deal is not atomic.
export class DistributionService {
  static async distribute(ritual, gmBrinkText) {
    if (!game.user.isGM) throw new Error("Only a GM may distribute the ritual cards.");
    if (ritual.system.creation.distributedAt) throw new Error("The ritual cards have already been distributed.");
    const survivors = ritual.system.survivorActorIds.map((id) => game.actors.get(id)).filter((actor) => actor?.type === "survivor");
    if (survivors.length < 2) throw new Error("At least two seated Survivors are required.");
    let them = game.actors.get(ritual.system.themActorId) ?? game.actors.find((actor) => actor.type === "them");
    if (!them) {
      them = await CONFIG.Actor.documentClass.create({
        name: game.i18n.localize("TENCANDLES.Actor.Them"),
        type: "them",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
        system: { sessionActorId: ritual.id }
      });
    }
    if (!gmBrinkText?.trim()) throw new Error("The GM must write the Brink for the Survivor on their left.");

    const sets = survivors.map((actor) => {
      const virtue = actor.items.find((item) => item.type === "trait" && item.system.kind === "virtue");
      const vice = actor.items.find((item) => item.type === "trait" && item.system.kind === "vice");
      const moment = actor.items.find((item) => item.type === "moment");
      const brink = actor.items.find((item) => item.type === "brink");
      if (!virtue || !vice || !moment || !brink) throw new Error(`${actor.name} must write a Virtue, Vice, Moment, and Brink before distribution.`);
      return { actor, virtue, vice, moment, brink };
    });

    const transfers = [];
    const addTransfer = (source, destination, overrides = {}) => transfers.push({ source, destination, overrides });
    sets.forEach((set, index) => {
      // Survivor order follows seating. Virtue and Vice travel in opposite
      // directions; the last player's Brink goes to Them, not around the ring.
      addTransfer(set.virtue, survivors[(index + 1) % survivors.length]);
      addTransfer(set.vice, survivors[(index - 1 + survivors.length) % survivors.length]);
      if (index < survivors.length - 1) addTransfer(set.brink, survivors[index + 1], { subject: "survivor" });
      else addTransfer(set.brink, them, { subject: "them" });
    });

    for (const { source, destination, overrides } of transfers) {
      // New parent means new embedded ID. Preserve authorship independently of
      // ownership so a received card still remembers who originally wrote it.
      const data = source.toObject();
      delete data._id;
      data.system = {
        ...data.system,
        ...overrides,
        authoredByUserId: data.system.authoredByUserId || source.parent.system.playerUserId || null,
        state: "draft"
      };
      await destination.createEmbeddedDocuments("Item", [data]);
    }

    for (const set of sets) {
      await set.actor.deleteEmbeddedDocuments("Item", [set.virtue.id, set.vice.id, set.brink.id]);
    }

    await survivors[0].createEmbeddedDocuments("Item", [{
      name: game.i18n.localize("TENCANDLES.Item.Brink"),
      type: "brink",
      system: { text: gmBrinkText.trim(), subject: "survivor", authoredByUserId: game.user.id }
    }]);

    for (const survivor of survivors) {
      const virtue = survivor.items.find((item) => item.type === "trait" && item.system.kind === "virtue");
      const vice = survivor.items.find((item) => item.type === "trait" && item.system.kind === "vice");
      const moment = survivor.items.find((item) => item.type === "moment");
      const brink = survivor.items.find((item) => item.type === "brink");
      await survivor.update({
        "system.stack.itemIds": [virtue.id, vice.id, moment.id, brink.id],
        "system.stack.activeItemId": null
      });
    }

    await ritual.update({
      "system.themActorId": them.id,
      "system.creation.distributedAt": Date.now(),
      "system.creation.distributionRevision": ritual.system.creation.distributionRevision + 1
    });
  }
}
