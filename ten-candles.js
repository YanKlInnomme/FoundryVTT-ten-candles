// Foundry lifecycle wiring belongs here; rules and document effects live in
// separate modules so the command engine can also run in Node tests.
import { registerSheets } from "./sheets/register-sheets.mjs";
import { SYSTEM_ID } from "./modules/constants.mjs";
import { registerDataModels } from "./models/register-data-models.mjs";
import { addTenCandlesLinksToSettings, registerSettings } from "./modules/settings.mjs";
import { RecordingService } from "./modules/services/recording-service.mjs";
import { registerModuleAccessSettings, updateModuleProtection } from "./modules/services/compendium-access-service.mjs";

const recentCandleNotifications = new Map();
const CANDLE_NOTIFICATION_DEDUPLICATION_MS = 2_000;
import { AuthorityService } from "./modules/services/authority-service.mjs";
import { RitualService } from "./modules/services/ritual-service.mjs";
import { SocketService } from "./modules/services/socket-service.mjs";
import { RitualTable } from "./applications/ritual-table/ritual-table.mjs";
import { AssignmentService } from "./modules/services/assignment-service.mjs";
import { TenCandlesActor, migrateLegacyRitualArtwork } from "./documents/actor.mjs";
import { CandleClockService } from "./modules/services/candle-clock-service.mjs";

function openActiveRitualTable() {
  // Auto-open only an unambiguous session. With several active session Actors,
  // leave the choice to the user rather than taking over an unrelated game.
  const activeRituals = game.actors.filter((actor) => actor.type === "session"
    && actor.system.status === "active"
    && actor.system.phase !== "ended"
    && (game.user.isGM || actor.visible));
  if (activeRituals.length === 1) RitualTable.open(activeRituals[0]);
}

Hooks.once("init", () => {
  console.info("Ten Candles | Initializing the Foundry VTT v14 system");
  CONFIG.Actor.documentClass = TenCandlesActor;
  registerDataModels();
  registerSheets();
  registerSettings();
  registerModuleAccessSettings();

  // Stable entry points for macros and modules: command requests still pass
  // through authority and permission checks instead of writing session data.
  game.tenCandles = Object.freeze({
    apiVersion: 1,
    systemId: SYSTEM_ID,
    get authorityUserId() {
      return AuthorityService.userId;
    },
    requestCommand(actor, name, payload = {}) {
      return RitualService.execute(actor, name, payload);
    },
    openRitualTable(actor) {
      return RitualTable.open(actor);
    }
  });
});

Hooks.once("ready", () => {
  updateModuleProtection();
  RecordingService.initialize();
  SocketService.initialize();
  RitualTable.initialize();
  AssignmentService.initialize();
  CandleClockService.initialize();
  void migrateLegacyRitualArtwork();
  document.documentElement.classList.toggle(
    "ten-candles-reduce-motion",
    game.settings.get(SYSTEM_ID, "reduceMotion")
  );
  document.documentElement.classList.toggle(
    "ten-candles-high-legibility",
    game.settings.get(SYSTEM_ID, "highLegibility")
  );
  openActiveRitualTable();
  console.info("Ten Candles | System ready");
});

Hooks.on("renderSettings", addTenCandlesLinksToSettings);
Hooks.once("setup", updateModuleProtection);
Hooks.on("renderCompendiumDirectory", updateModuleProtection);

Hooks.on("tenCandlesRitualEvents", (_ritual, events) => {
  // Commands can publish extinction events in quick succession. Deduplicate
  // their notification category briefly to avoid flooding every client.
  for (const event of events) {
    if (event.type === "candles.lit" && game.settings.get(SYSTEM_ID, "debugMode")) {
      const candles = event.payload.candleIds.map((candleId) => {
        const candle = _ritual?.system.candles.find((entry) => entry.id === candleId);
        return candle ? {
          id: candle.id,
          state: candle.state,
          litAt: new Date(candle.litAt).toISOString(),
          lifetimeMinutes: candle.lifetimeMinutes,
          elapsedBurnMinutes: candle.elapsedBurnMinutes ?? 0,
          remainingMinutes: candle.lifetimeMinutes - (candle.elapsedBurnMinutes ?? 0),
          environment: _ritual.system.candleEnvironment
        } : { id: candleId, state: "unknown" };
      });
      console.groupCollapsed(`Ten Candles | ${candles.length} candle${candles.length === 1 ? "" : "s"} lit`);
      console.table(candles);
      console.groupEnd();
    }
    if (event.type !== "candle.expired") continue;
    const key = event.payload.duringPreparation
      ? "TENCANDLES.CandleClock.PreparationExtinction"
      : event.payload.final
      ? "TENCANDLES.CandleClock.FinalFlame"
      : event.payload.cause === "natural" ? "TENCANDLES.CandleClock.BurnedOut" : "TENCANDLES.CandleClock.Accident";
    const notifiedAt = recentCandleNotifications.get(key) ?? 0;
    if (Date.now() - notifiedAt < CANDLE_NOTIFICATION_DEDUPLICATION_MS) continue;
    recentCandleNotifications.set(key, Date.now());
    ui.notifications.warn(game.i18n.localize(key));
  }
});
