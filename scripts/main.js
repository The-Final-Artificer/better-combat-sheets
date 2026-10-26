import { SheetGroup } from "./group.js";

export const MOD = "better-combat-sheets";

let grp = null;

Hooks.once("init", () => {
  game.settings.register(MOD, "autoSwitch", {
    name: "CSB.Settings.AutoSwitch.Name",
    hint: "CSB.Settings.AutoSwitch.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MOD, "includePCs", {
    name: "CSB.Settings.IncludePCs.Name",
    hint: "CSB.Settings.IncludePCs.Hint",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: () => grp?.sync()
  });
  game.settings.register(MOD, "autoCloseDefeated", {
    name: "CSB.Settings.AutoCloseDefeated.Name",
    hint: "CSB.Settings.AutoCloseDefeated.Hint",
    scope: "client", config: true, type: Boolean, default: false
  });
  game.settings.register(MOD, "clickAway", {
    name: "CSB.Settings.ClickAway.Name",
    hint: "CSB.Settings.ClickAway.Hint",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MOD, "syncSize", {
    name: "CSB.Settings.SyncSize.Name",
    hint: "CSB.Settings.SyncSize.Hint",
    // V20 sizes its own sheets per mode, so the option is off and hidden there
    scope: "client", config: game.system.id !== "vtm-v20", type: Boolean, default: true
  });
  game.settings.register(MOD, "sheetScale", {
    name: "CSB.Settings.SheetScale.Name",
    hint: "CSB.Settings.SheetScale.Hint",
    scope: "client", config: true, type: Number,
    range: { min: 50, max: 200, step: 5 },
    default: 100,
    onChange: () => { grp?.refreshSize(); grp?.rescaleAll(); }
  });
  game.settings.register(MOD, "scaleOutside", {
    name: "CSB.Settings.ScaleOutside.Name",
    hint: "CSB.Settings.ScaleOutside.Hint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => grp?.rescaleAll()
  });
  // last browser window rect, remembered between sessions
  game.settings.register(MOD, "winRect", {
    scope: "client", config: false, type: Object, default: null
  });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  grp = new SheetGroup();

  Hooks.on("combatStart", combat => { grp.sync(); grp.onTurn(combat); });
  Hooks.on("combatTurnChange", combat => { if (combat === grp.combat) grp.onTurn(combat); });
  Hooks.on("updateCombat", (combat, changed) => { if ("active" in changed) grp.sync(); });
  Hooks.on("createCombat", () => grp.sync());
  Hooks.on("deleteCombat", combat => grp.onCombatDeleted(combat));
  Hooks.on("createCombatant", () => grp.sync());
  Hooks.on("deleteCombatant", () => grp.sync());
  Hooks.on("updateCombatant", (c, changed) => {
    if (c.parent !== grp.combat) return;
    if ("initiative" in changed) grp.sync();
    else grp.onCombatantUpdate(c, changed);
  });
  Hooks.on("updateActor", (actor, changed) => { if ("ownership" in changed) grp.sync(); });
  Hooks.on("canvasReady", () => grp.sync());

  // both sheet frameworks: v1 actor sheets and v2 document sheets
  Hooks.on("renderActorSheet", app => { scaleSheet(app); grp.onSheetRender(app); });
  Hooks.on("renderDocumentSheetV2", app => { scaleSheet(app); grp.onSheetRender(app); });
  Hooks.on("closeActorSheet", app => grp.onSheetClose(app));
  Hooks.on("closeDocumentSheetV2", app => grp.onSheetClose(app));

  // clicking into the scene folds the active sheet back into the tab row
  document.addEventListener("pointerdown", ev => {
    grp.ptrDown = true;
    if (!ev.target?.closest?.("#board")) return;
    if (!game.settings.get(MOD, "clickAway")) return;
    grp.parkActive();
  }, { capture: true, passive: true });
  document.addEventListener("pointerup", () => { grp.ptrDown = false; }, { capture: true, passive: true });

  patchWindows();
  grp.sync();
});

// The size slider zooms actor sheets through Foundry's native position.scale,
// so the whole sheet shrinks or grows, content included. Combat sheets follow
// the slider regardless; this covers sheets opened outside the browser.
function scaleSheet(app) {
  if (!game.settings.get(MOD, "scaleOutside")) return;
  const scale = (Number(game.settings.get(MOD, "sheetScale")) || 100) / 100;
  if (scale === 1) return;
  const doc = app.actor ?? app.document ?? app.object;
  if (!(doc instanceof Actor)) return;
  const node = app.element?.nodeType === 1 ? app.element : app.element?.[0];
  if (!node || node.dataset.csbScaled) return;
  node.dataset.csbScaled = "1";
  app.setPosition({ scale });
}

// Core routes every "show me this sheet" action through bringToFront (v2) or
// bringToTop (v1), drags land in setPosition, and header double-clicks in
// minimize. Observing those is what makes native windows behave like tabs.
function patchWindows() {
  const lw = game.modules.get("lib-wrapper")?.active;
  const defs = [
    ["foundry.applications.api.ApplicationV2", "bringToFront", app => grp?.onFront(app)],
    ["foundry.applications.api.ApplicationV2", "setPosition", app => grp?.onMoved(app)],
    ["foundry.applications.api.ApplicationV2", "minimize", (app, out) => Promise.resolve(out).then(() => grp?.onMinimized(app))],
    ["foundry.applications.api.ApplicationV2", "maximize", (app, out) => Promise.resolve(out).then(() => grp?.onMaximized(app), () => {})],
    ["foundry.applications.api.ApplicationV2", "close", (app, out) => Promise.resolve(out).then(() => { if (!app.rendered) grp?.onSheetClose(app); }, () => { if (!app.rendered) grp?.onSheetClose(app); })],
    ["foundry.appv1.api.Application", "bringToTop", app => grp?.onFront(app)],
    ["foundry.appv1.api.Application", "setPosition", app => grp?.onMoved(app)],
    ["foundry.appv1.api.Application", "minimize", (app, out) => Promise.resolve(out).then(() => grp?.onMinimized(app))],
    ["foundry.appv1.api.Application", "maximize", (app, out) => Promise.resolve(out).then(() => grp?.onMaximized(app), () => {})],
    ["foundry.appv1.api.Application", "close", (app, out) => Promise.resolve(out).then(() => { if (!app.rendered) grp?.onSheetClose(app); }, () => { if (!app.rendered) grp?.onSheetClose(app); })]
  ];
  for (const [path, fn, after] of defs) {
    const cls = foundry.utils.getProperty(globalThis, path);
    if (!cls?.prototype?.[fn]) continue;
    const safeAfter = (app, out) => {
      try { after(app, out); }
      catch (err) { console.error(`${MOD} | error reacting to ${fn}`, err); }
    };
    if (lw) {
      libWrapper.register(MOD, `${path}.prototype.${fn}`, function(wrapped, ...args) {
        const out = wrapped(...args);
        safeAfter(this, out);
        return out;
      }, "WRAPPER");
    } else {
      const orig = cls.prototype[fn];
      cls.prototype[fn] = function(...args) {
        const out = orig.apply(this, args);
        safeAfter(this, out);
        return out;
      };
    }
  }
}
