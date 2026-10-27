import { AuthorityService } from "./authority-service.mjs";

// Keep playerUserId, Actor ownership and User.character in agreement. The
// authority performs reconciliation; #updating prevents our own Actor.update
// from recursively triggering another assignment via updateActor.
export class AssignmentService {
  static #initialized = false;
  static #updating = new Set();

  static initialize() {
    if (this.#initialized) return;
    Hooks.on("updateActor", (actor, changes) => {
      if (actor.type !== "survivor" || !AuthorityService.isCurrentUser || this.#updating.has(actor.id)) return;
      const explicitPlayerId = changes.system?.playerUserId;
      const ownershipChanged = Object.hasOwn(changes, "ownership");
      if (explicitPlayerId !== undefined) {
        void this.assign(actor, explicitPlayerId || null);
        return;
      }
      if (!ownershipChanged) return;
      const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const promotedId = Object.entries(changes.ownership ?? {})
        .find(([userId, level]) => userId !== "default" && Number(level) === ownerLevel)?.[0];
      const owners = game.users.filter((user) => !user.isGM && actor.testUserPermission(user, ownerLevel));
      void this.assign(actor, promotedId ?? (owners.length === 1 ? owners[0].id : null));
    });
    Hooks.on("createActor", (actor) => {
      if (actor.type !== "survivor" || !AuthorityService.isCurrentUser) return;
      const playerId = actor.system.playerUserId;
      if (playerId) void this.assign(actor, playerId);
    });
    this.#initialized = true;
    void this.reconcileAll();
  }

  static async reconcileAll() {
    if (!AuthorityService.isCurrentUser) return;
    const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    for (const actor of game.actors.filter((candidate) => candidate.type === "survivor")) {
      const configured = game.users.get(actor.system.playerUserId);
      const owners = game.users.filter((user) => !user.isGM && actor.testUserPermission(user, ownerLevel));
      const playerId = configured && !configured.isGM ? configured.id : (owners.length === 1 ? owners[0].id : null);
      if (playerId || actor.system.playerUserId) await this.assign(actor, playerId);
    }
  }

  static async assign(actor, playerUserId) {
    if (!AuthorityService.isCurrentUser || this.#updating.has(actor.id)) return;
    const player = game.users.get(playerUserId);
    if (player?.isGM) throw new Error("A GM cannot be assigned as a Survivor's player.");
    this.#updating.add(actor.id);
    try {
      const previousPlayer = game.users.get(actor.system.playerUserId);
      const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      const noneLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
      const ownership = { ...actor.ownership };
      for (const user of game.users) {
        if (user.isGM) continue;
        ownership[user.id] = user.id === playerUserId ? ownerLevel : noneLevel;
      }
      const updates = { ownership };
      if (actor.system.playerUserId !== (playerUserId || null)) updates["system.playerUserId"] = playerUserId || null;
      await actor.update(updates);

      if (previousPlayer && previousPlayer.id !== playerUserId && previousPlayer.character?.id === actor.id) {
        await previousPlayer.update({ character: null });
      }
      if (player && player.character?.id !== actor.id) await player.update({ character: actor.id });
    } finally {
      this.#updating.delete(actor.id);
    }
  }
}
