import { AuthorityService } from "./authority-service.mjs";
import { RitualService } from "./ritual-service.mjs";
import { SYSTEM_ID } from "../constants.mjs";

// Independent accident probability per lit candle per active minute, expressed
// as a fraction (0.002 = 0.2%). These are gameplay calibration values, not measured
// physical constants. For N candle-minutes, P(at least one accident) = 1-(1-p)^N;
// the total exposure falls as candles go out. "none" disables accidents only.
export const CANDLE_RISK_PER_MINUTE = Object.freeze({
  gale: 0.025,
  convention: 0.008,
  livingRoom: 0.002,
  none: 0
});

const MINUTE_MS = 60_000;
const CONSENT_FORM_ID = "consent-form";

export class CandleClockService {
  static #intervalId = null;
  static #running = false;
  static #consentXCardPauses = new Set();

  static initialize() {
    if (this.#intervalId !== null) return;
    this.#intervalId = window.setInterval(() => void this.tick(), MINUTE_MS);
    Hooks.on("pauseGame", (paused) => {
      if (!paused) void this.reanchor();
    });
    Hooks.on("updateSetting", (setting) => {
      if (setting.key !== `${CONSENT_FORM_ID}.activeBreak`) return;
      if (!this.#consentBreakActive()) void this.reanchor();
    });
    Hooks.on("createChatMessage", (message) => {
      if (!this.#consentFormActive() || !message.author?.isGM) return;
      const pauseId = message.getFlag(CONSENT_FORM_ID, "pauseId");
      if (typeof pauseId !== "string" || !pauseId) return;
      if (message.getFlag(CONSENT_FORM_ID, "xCardSignal")) this.#consentXCardPauses.add(pauseId);
      if (message.getFlag(CONSENT_FORM_ID, "xCardEndSignal")) {
        this.#consentXCardPauses.delete(pauseId);
        if (!this.#consentPauseActive()) void this.reanchor();
      }
    });
    if (game.settings.get(SYSTEM_ID, "debugMode") && AuthorityService.isCurrentUser) {
      console.info("Ten Candles | Candle clock initialized", { intervalSeconds: MINUTE_MS / 1000, paused: game.paused });
    }
    void this.reanchor();
  }

  static #consentFormActive() {
    return Boolean(game.modules.get(CONSENT_FORM_ID)?.active);
  }

  static #consentBreakActive() {
    if (!this.#consentFormActive()) return false;
    return Boolean(game.settings.get(CONSENT_FORM_ID, "activeBreak")?.id);
  }

  static #consentPauseActive() {
    if (!this.#consentFormActive()) return false;
    return this.#consentBreakActive()
      || this.#consentXCardPauses.size > 0
      || Boolean(document.querySelector?.(".consent-x-card[data-pause-id]"));
  }

  static #pauseReason() {
    if (game.paused) return "Foundry pause";
    if (this.#consentBreakActive()) return "Consent Form table break";
    if (this.#consentXCardPauses.size || document.querySelector?.(".consent-x-card[data-pause-id]")) return "Consent Form X-Card";
    return null;
  }

  static async reanchor(now = Date.now()) {
    // Move the sampling origin without consuming wax or changing lifetime.
    // Used at startup and after breaks so inactive wall time is never caught up.
    if (!AuthorityService.isCurrentUser) return;
    let reanchored = 0;
    for (const ritual of game.actors.filter((actor) => actor.type === "session" && actor.system.status === "active")) {
      const candles = ritual.system.candles.map((candle) => candle.state === "lit"
        ? { ...candle, lastRiskCheckAt: now }
        : { ...candle });
      reanchored += candles.filter((candle) => candle.state === "lit").length;
      await ritual.update({ "system.candles": candles });
    }
    if (game.settings.get(SYSTEM_ID, "debugMode")) {
      console.info("Ten Candles | Candle clock reanchored", { candles: reanchored, at: new Date(now).toISOString() });
    }
  }

  static async tick(now = Date.now(), random = Math.random) {
    // Only the elected GM samples risk. The running guard also prevents a slow
    // document update from overlapping the next interval on that same client.
    if (!AuthorityService.isCurrentUser || this.#running) return;
    const pauseReason = this.#pauseReason();
    if (pauseReason) {
      if (game.settings.get(SYSTEM_ID, "debugMode")) {
        console.info(`Ten Candles | Candle clock suspended — ${pauseReason}`, { at: new Date(now).toISOString() });
      }
      return;
    }
    this.#running = true;
    try {
      for (const ritual of game.actors.filter((actor) => actor.type === "session" && actor.system.status === "active" && actor.system.phase !== "epilogue")) {
        const risk = CANDLE_RISK_PER_MINUTE[ritual.system.candleEnvironment] ?? CANDLE_RISK_PER_MINUTE.livingRoom;
        const candles = ritual.system.candles.map((candle) => ({ ...candle }));
        let changed = false;
        let accidental = null;
        let naturallyExpired = null;
        const debugRows = [];
        for (const candle of candles.filter((entry) => entry.state === "lit")) {
          const previousCheck = candle.lastRiskCheckAt ?? candle.litAt ?? now;
          const dueChecks = Math.max(0, Math.floor((now - previousCheck) / MINUTE_MS));
          // Catch up whole active minutes after timer throttling. Advance the
          // anchor by exact minute steps, keeping the unsampled partial minute.
          if (!dueChecks) continue;
          for (let minute = 1; minute <= dueChecks; minute += 1) {
            candle.elapsedBurnMinutes = (candle.elapsedBurnMinutes ?? 0) + 1;
            const checkedAt = previousCheck + (minute * MINUTE_MS);
            const roll = random();
            const natural = candle.elapsedBurnMinutes >= candle.lifetimeMinutes;
            const accident = !natural && risk > 0 && roll < risk;
            debugRows.push({
              candle: candle.id,
              minute: candle.elapsedBurnMinutes,
              lifetime: candle.lifetimeMinutes,
              roll: Number(roll.toFixed(6)),
              threshold: risk,
              result: natural ? "natural extinction" : accident ? "accident" : "still lit"
            });
            candle.lastRiskCheckAt = checkedAt;
            changed = true;
            if (natural) {
              naturallyExpired = candle;
              break;
            }
            if (accident) {
              accidental = candle;
              break;
            }
          }
          if (naturallyExpired || accidental) break;
        }
        if (game.settings.get(SYSTEM_ID, "debugMode") && debugRows.length) {
          console.groupCollapsed(`Ten Candles | Candle clock — ${ritual.name}`);
          console.table(debugRows);
          console.groupEnd();
        }
        if (changed) await ritual.update({ "system.candles": candles });
        if (naturallyExpired) {
          // Resolve at most one extinction per tick through the command engine:
          // it decides whether this ends a scene, interrupts preparation or
          // enters the finale. The clock itself only accounts for burn/risk.
          await RitualService.execute(ritual, "candle.expire", { candleId: naturallyExpired.id, cause: "natural", checkedAt: naturallyExpired.lastRiskCheckAt });
        } else if (accidental) {
          await RitualService.execute(ritual, "candle.expire", { candleId: accidental.id, cause: "accident", checkedAt: accidental.lastRiskCheckAt });
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
