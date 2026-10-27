export const RITUAL_DEFAULT_IMAGE = "systems/ten-candles/assets/game.webp";
const LEGACY_RITUAL_IMAGES = new Set([CONST.DEFAULT_TOKEN, "icons/magic/light/light-candles-lit-white.webp"]);

// The "session" Actor is the persistent game container. Survivor and Them
// Actors still use normal character documents; all three share this class.
export class TenCandlesActor extends Actor {
  async _preUpdate(changed, options, user) {
    // Enforce the draft-only environment setting at the document boundary too;
    // disabling its form field alone would not cover macro-driven updates.
    if (this.type === "session" && this.system.status !== "draft" && foundry.utils.hasProperty(changed, "system.candleEnvironment")) {
      foundry.utils.deleteProperty(changed, "system.candleEnvironment");
    }
    return super._preUpdate(changed, options, user);
  }

  static getDefaultArtwork(actorData) {
    if (actorData?.type === "session") {
      return {
        img: RITUAL_DEFAULT_IMAGE,
        texture: { src: RITUAL_DEFAULT_IMAGE }
      };
    }
    return super.getDefaultArtwork(actorData);
  }
}

export async function migrateLegacyRitualArtwork() {
  // Replace only known defaults, preserving any artwork chosen by the GM.
  if (!game.user.isGM) return;
  const updates = game.actors
    .filter((actor) => actor.type === "session" && actor.isOwner && (!actor.img || LEGACY_RITUAL_IMAGES.has(actor.img)))
    .map((actor) => ({ _id: actor.id, img: RITUAL_DEFAULT_IMAGE }));
  if (updates.length) await Actor.updateDocuments(updates);
}
