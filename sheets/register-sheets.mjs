import { CardSheet } from "./card-sheet.mjs";
import { RitualSheet } from "./ritual-sheet.mjs";
import { SurvivorSheet } from "./survivor-sheet.mjs";
import { ThemSheet } from "./them-sheet.mjs";
import { ModuleSheet } from "./module-sheet.mjs";

export function registerSheets() {
  // Register configuration/character sheets by document type. RitualTable is
  // opened explicitly rather than registered as the session Actor's sheet.
  const DocumentSheetConfig = foundry.applications.apps.DocumentSheetConfig;

  DocumentSheetConfig.registerSheet(foundry.documents.Actor, "ten-candles", RitualSheet, {
    types: ["session"],
    makeDefault: true,
    label: "TENCANDLES.Sheets.Session"
  });
  DocumentSheetConfig.registerSheet(foundry.documents.Actor, "ten-candles", SurvivorSheet, {
    types: ["survivor"],
    makeDefault: true,
    label: "TENCANDLES.Sheets.Survivor"
  });
  DocumentSheetConfig.registerSheet(foundry.documents.Actor, "ten-candles", ThemSheet, {
    types: ["them"],
    makeDefault: true,
    label: "TENCANDLES.Sheets.Them"
  });
  DocumentSheetConfig.registerSheet(foundry.documents.Item, "ten-candles", CardSheet, {
    types: ["trait", "moment", "brink"],
    makeDefault: true,
    label: "TENCANDLES.Sheets.Card"
  });
  DocumentSheetConfig.registerSheet(foundry.documents.Item, "ten-candles", ModuleSheet, {
    types: ["module"], makeDefault: true, label: "TENCANDLES.Sheets.Module"
  });
}
