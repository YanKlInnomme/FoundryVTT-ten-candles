import { RitualCommandError } from "../domain/errors.mjs";
import { assertCommandPermission } from "../domain/permissions.mjs";
import { applyRitualCommand } from "../domain/ritual-commands.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { AuthorityService } from "./authority-service.mjs";
import { ConflictEffectService } from "./conflict-effect-service.mjs";
import { ConflictRollService } from "./conflict-roll-service.mjs";
import { localizeError } from "./localization-service.mjs";

const CHANNEL = `system.${SYSTEM_ID}`;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Single-writer command transport: request -> GM queue -> rules -> Actor update
 * -> document effects -> result/events on all clients. The elected GM runs the
 * same path locally. A result message is not a second state replication channel;
 * Foundry replicates the actual document updates.
 */
export class SocketService {
  static #initialized = false;
  static #pending = new Map();
  static #queues = new Map();

  static initialize() {
    if (this.#initialized) return;
    game.socket.on(CHANNEL, (message, senderUserId) => this.#onMessage(message, senderUserId));
    this.#initialized = true;
  }

  static async request(actor, name, payload = {}) {
    if (actor.type !== "session") throw new Error("Ritual commands require a ritual Actor.");
    const authority = AuthorityService.user;
    if (!authority) {
      ui.notifications.warn(game.i18n.localize("TENCANDLES.Network.NoActiveGm"));
      return { ok: false, error: { code: "NO_ACTIVE_GM" } };
    }

    const command = {
      id: foundry.utils.randomID(),
      name,
      ritualId: actor.id,
      expectedRevision: actor.system.revision,
      issuedBy: game.user.id,
      issuedAt: Date.now(),
      payload
    };

    if (AuthorityService.isCurrentUser) return this.#enqueue(command);

    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        this.#pending.delete(command.id);
        ui.notifications.warn(game.i18n.localize("TENCANDLES.Network.CommandTimeout"));
        resolve({ ok: false, error: { code: "COMMAND_TIMEOUT" } });
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(command.id, { resolve, timeout, authorityUserId: authority.id });
      game.socket.emit(CHANNEL, {
        type: "command.request",
        authorityUserId: authority.id,
        command
      });
    });
  }

  static async proposePortrait(actor, file) {
    if (game.user.isGM || actor.type !== "survivor" || !actor.isOwner || !(file instanceof File)) return false;
    await this.validatePortraitFile(file);
    const authority = AuthorityService.user;
    if (!authority) throw new Error(game.i18n.localize("TENCANDLES.Network.NoActiveGm"));
    const dataUrl = await this.#preparePortrait(file);
    game.socket.emit(CHANNEL, {
      type: "portrait.proposal",
      authorityUserId: authority.id,
      requestId: foundry.utils.randomID(),
      actorId: actor.id,
      requestedBy: game.user.id,
      fileName: file.name,
      dataUrl
    });
    ui.notifications.info(game.i18n.localize("TENCANDLES.Survivor.PortraitProposalSent"));
    return true;
  }

  static async validatePortraitFile(file) {
    if (!(file instanceof File) || file.size <= 0 || file.size > 10 * 1024 * 1024) {
      throw new Error(game.i18n.localize("TENCANDLES.Survivor.PortraitImageOnly"));
    }
    const extension = file.name.toLowerCase().match(/\.(jpe?g|png|webp)$/)?.[1] ?? "";
    const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!extension || (file.type && !allowedMimeTypes.has(file.type))) {
      throw new Error(game.i18n.localize("TENCANDLES.Survivor.PortraitImageOnly"));
    }
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    const signatureMatches = (extension === "jpg" || extension === "jpeg") ? isJpeg
      : extension === "png" ? isPng : isWebp;
    if (!signatureMatches) throw new Error(game.i18n.localize("TENCANDLES.Survivor.PortraitImageOnly"));
    return true;
  }

  static #onMessage(message, senderUserId) {
    if (!message || typeof message !== "object") return;

    if (message.type === "command.request") {
      // Trust the transport sender, not the identity supplied inside the payload.
      // Matching identities still need the command-level permission checks.
      if (!AuthorityService.isCurrentUser || message.authorityUserId !== game.user.id) return;
      if (message.command?.issuedBy !== senderUserId) return;
      void this.#enqueue(message.command);
      return;
    }

    if (message.type === "portrait.proposal") {
      if (!AuthorityService.isCurrentUser || message.authorityUserId !== game.user.id) return;
      if (message.requestedBy !== senderUserId) return;
      void this.#reviewPortrait(message);
      return;
    }

    if (message.type === "portrait.response") {
      if (senderUserId !== AuthorityService.user?.id) return;
      if (message.targetUserId !== game.user.id) return;
      ui.notifications[message.accepted ? "info" : "warn"](game.i18n.localize(
        message.accepted ? "TENCANDLES.Survivor.PortraitProposalAccepted" : "TENCANDLES.Survivor.PortraitProposalDeclined"
      ));
      return;
    }

    if (message.type === "command.result") {
      const pending = this.#pending.get(message.commandId);
      const authenticAuthority = senderUserId === message.processedBy
        && (pending ? senderUserId === pending.authorityUserId : senderUserId === AuthorityService.user?.id);
      if (!authenticAuthority) return;
      if (message.processedBy !== game.user.id) this.#publishEvents(message);
      if (!pending || message.targetUserId !== game.user.id) return;
      window.clearTimeout(pending.timeout);
      this.#pending.delete(message.commandId);
      pending.resolve(message.result);
    }
  }

  static #enqueue(command) {
    // Serialize per session Actor, allowing unrelated games to progress in
    // parallel. A rejected request must not poison the next queued request.
    const ritualId = command.ritualId;
    const previous = this.#queues.get(ritualId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(command));
    this.#queues.set(ritualId, current);
    current.finally(() => {
      if (this.#queues.get(ritualId) === current) this.#queues.delete(ritualId);
    });
    return current;
  }

  static async #process(command) {
    let result;
    const ritual = game.actors.get(command.ritualId);

    try {
      if (!AuthorityService.isCurrentUser) throw new RitualCommandError("AUTHORITY_CHANGED", "The authoritative GM changed before the command was processed.");
      if (!ritual || ritual.type !== "session") throw new RitualCommandError("RITUAL_NOT_FOUND", "The requested ritual no longer exists.");

      const user = game.users.get(command.issuedBy);
      assertCommandPermission({ command, user, ritual });
      await ConflictRollService.prepare(command, ritual);
      const applied = applyRitualCommand(ritual.system.toObject(), command);
      if (!applied.duplicate) {
        // Commit the shared state before touching cards, hope or chat. Effects
        // span several documents and are not an atomic Foundry transaction;
        // report an effect failure without replaying an already committed rule.
        await ritual.update({ system: applied.state });
        try {
          await ConflictEffectService.apply(ritual, applied.events);
        } catch (effectError) {
          console.error("Ten Candles | Conflict side effect failed after the ritual state was committed", effectError);
        }
      }
      result = {
        ok: true,
        duplicate: applied.duplicate,
        revision: applied.state.revision,
        events: applied.events
      };
    } catch (error) {
      if (!(error instanceof RitualCommandError)) {
        console.error("Ten Candles | Failed to process ritual command", command, error);
        error = new RitualCommandError("INTERNAL_ERROR", "The ritual command could not be processed.");
      }
      result = {
        ok: false,
        error: { code: error.code, message: error.message },
        events: []
      };
    }

    const message = {
      type: "command.result",
      commandId: command.id,
      ritualId: command.ritualId,
      targetUserId: command.issuedBy,
      processedBy: game.user.id,
      result
    };
    this.#publishEvents(message);
    game.socket.emit(CHANNEL, message);

    if (!result.ok) ui.notifications.warn(localizeError(result.error));
    return result;
  }

  static #publishEvents(message) {
    if (!message.result?.ok || !message.result.events?.length) return;
    const ritual = game.actors.get(message.ritualId) ?? null;
    Hooks.callAll("tenCandlesRitualEvents", ritual, message.result.events, {
      commandId: message.commandId,
      processedBy: message.processedBy
    });
  }

  static async #preparePortrait(file) {
    const image = await createImageBitmap(file);
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const sourceSize = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - sourceSize) / 2, (image.height - sourceSize) / 2, sourceSize, sourceSize, 0, 0, size, size);
    image.close?.();
    return canvas.toDataURL("image/jpeg", 0.86);
  }

  static async #reviewPortrait(message) {
    // Players without upload rights propose an image; only the GM's explicit
    // acceptance writes the world file and changes the Survivor portrait.
    const actor = game.actors.get(message.actorId);
    const user = game.users.get(message.requestedBy);
    const permitted = actor?.type === "survivor"
      && actor.system.playerUserId === user?.id
      && actor.testUserPermission(user, "OWNER")
      && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(message.dataUrl ?? "")
      && message.dataUrl.length < 1_500_000;
    if (!permitted) return;
    const accepted = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("TENCANDLES.Survivor.PortraitProposalTitle") },
      content: `<div class="tc-portrait-proposal"><p>${game.i18n.format("TENCANDLES.Survivor.PortraitProposalReview", { player: foundry.utils.escapeHTML(user.name), survivor: foundry.utils.escapeHTML(actor.name) })}</p><img src="${message.dataUrl}" alt=""></div>`,
      yes: { label: game.i18n.localize("TENCANDLES.Survivor.AcceptPortrait") },
      no: { label: game.i18n.localize("TENCANDLES.Survivor.DeclinePortrait") }
    });
    if (accepted) {
      const bytes = Uint8Array.from(atob(message.dataUrl.split(",")[1]), (character) => character.charCodeAt(0));
      const file = new File([bytes], `${game.world.id}-${actor.id}-${Date.now()}.jpg`, { type: "image/jpeg" });
      const FilePicker = foundry.applications.apps.FilePicker.implementation;
      const target = `worlds/${game.world.id}/ten-candles-portraits`;
      try { await FilePicker.createDirectory("data", target, { notify: false }); } catch (_error) { /* The directory probably already exists. */ }
      const response = await FilePicker.upload("data", target, file, {}, { notify: false });
      const path = response?.path ?? response?.url ?? `${target}/${encodeURIComponent(file.name)}`;
      await actor.update({ img: path });
    }
    game.socket.emit(CHANNEL, { type: "portrait.response", targetUserId: user.id, requestId: message.requestId, accepted });
  }
}
