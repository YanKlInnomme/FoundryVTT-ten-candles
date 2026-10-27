// Apply Foundry document/chat consequences of already committed domain events.
// Keep these asynchronous effects out of the deterministic command engine.
export class ConflictEffectService {
  static async apply(ritual, events) {
    for (const event of events) {
      if (event.type === "card.burned") await this.#burnCard(event.payload);
      if (event.type === "hope.gained") await this.#changeHope(event.payload.actorId, 1);
      if (event.type === "hope.lost") await this.#clearHope(event.payload.actorId);
      if (event.type === "survivor.sacrificed") await this.#sacrifice(event.payload);
      if (event.type === "survivor.fallen") await this.#markDead(event.payload);
      if (event.type === "survivors.claimedByDarkness") {
        for (const actorId of event.payload.actorIds) await this.#markDead({ ...event.payload, actorId, narratedByUserId: null });
      }
      if (event.type === "conflict.resolved") await this.#postConflict(ritual, event.payload);
    }
  }

  static async #burnCard(payload) {
    const actor = game.actors.get(payload.actorId);
    const item = actor?.items.get(payload.itemId);
    if (!actor || !item) return;
    await item.update({ "system.state": "burning" });
    // Persist an intermediate state so every client can animate the same card.
    // Advance the stack only after it becomes burned, matching the visual exit.
    const burnDuration = game.settings.get("ten-candles", "reduceMotion") ? 180 : 4_800;
    await new Promise((resolve) => window.setTimeout(resolve, burnDuration));
    const itemUpdate = { "system.state": "burned", "system.burnedAt": Date.now() };
    if (item.type === "trait") itemUpdate["system.burnedInScene"] = payload.sceneNumber;
    if (item.type === "moment") {
      itemUpdate["system.outcome"] = payload.outcome ?? "lost";
      itemUpdate["system.resolvedAt"] = Date.now();
      itemUpdate["system.resolvedInScene"] = payload.sceneNumber;
    }
    await item.update(itemUpdate);
    if (actor.type !== "survivor") return;
    const ids = actor.system.stack.itemIds;
    const currentIndex = ids.indexOf(item.id);
    const next = ids.slice(currentIndex + 1).map((id) => actor.items.get(id)).find((candidate) => candidate?.system.state !== "burned");
    await actor.update({ "system.stack.activeItemId": next?.id ?? null });
  }

  static async #changeHope(actorId, amount) {
    const actor = game.actors.get(actorId);
    if (actor) await actor.update({ "system.hopeDice": Math.max(0, actor.system.hopeDice + amount) });
  }

  static async #clearHope(actorId) {
    const actor = game.actors.get(actorId);
    if (actor) await actor.update({ "system.hopeDice": 0, "system.transferredHopeDice": 0 });
  }

  static async #sacrifice(payload) {
    const actor = game.actors.get(payload.actorId);
    if (!actor) return;
    const transferable = actor.system.hopeDice + actor.system.transferredHopeDice;
    await actor.update({
      "system.alive": false,
      "system.death.sceneNumber": payload.sceneNumber,
      "system.death.narratedByUserId": payload.narratedByUserId,
      "system.hopeDice": 0,
      "system.transferredHopeDice": 0
    });
    const recipient = game.actors.get(payload.recipientActorId);
    if (recipient && transferable > 0) {
      await recipient.update({ "system.transferredHopeDice": recipient.system.transferredHopeDice + transferable });
    }
  }

  static async #markDead(payload) {
    const actor = game.actors.get(payload.actorId);
    if (!actor || !actor.system.alive) return;
    await actor.update({
      "system.alive": false,
      "system.death.sceneNumber": payload.sceneNumber,
      "system.death.narratedByUserId": payload.narratedByUserId ?? null,
      "system.hopeDice": 0,
      "system.transferredHopeDice": 0
    });
  }

  static async #postConflict(ritual, conflict) {
    const active = game.actors.get(conflict.activeActorId);
    const sacrifice = game.actors.get(conflict.sacrificeActorId);
    const escape = foundry.utils.escapeHTML;
    const playerDice = [...conflict.playerResults, ...conflict.hopeResults].join(", ") || "—";
    const gmDice = conflict.gmResults.join(", ") || "—";
    const result = game.i18n.localize(`TENCANDLES.Conflict.${conflict.success ? "Success" : "Failure"}`);
    const narrator = conflict.narrationOwner === "player"
      ? sacrifice?.name ?? active?.name ?? game.i18n.localize("TENCANDLES.Fields.Player")
      : game.i18n.localize("TENCANDLES.Seating.GmSeat");
    const title = conflict.question || game.i18n.format("TENCANDLES.Chat.ConflictTitle", {
      name: active?.name ?? game.i18n.localize("TENCANDLES.Actor.Survivor")
    });
    const resolution = conflict.resolutionText ? `<blockquote>${escape(conflict.resolutionText)}</blockquote>` : "";
    const summary = game.i18n.format("TENCANDLES.Chat.Summary", { result, narrator });
    const playerLine = game.i18n.format("TENCANDLES.Chat.PlayerDice", { dice: playerDice });
    const gmLine = game.i18n.format("TENCANDLES.Chat.GmDice", { dice: gmDice });
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: active ?? ritual }),
      content: `<article class="ten-candles conflict-summary"><h3>${escape(title)}</h3><p>${escape(summary)}</p>${resolution}<p>${escape(playerLine)}<br>${escape(gmLine)}</p></article>`
    });
  }
}

