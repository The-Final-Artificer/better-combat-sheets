import { MOD } from "./main.js";

// v1 apps expose a jQuery element, v2 apps a plain HTMLElement
const el = app => (app?.element?.nodeType === 1 ? app.element : app?.element?.[0]) ?? null;

// only v2 has a minimized getter; v1 keeps _minimized (null while animating)
const isMin = app => app.minimized ?? (app._minimized === true);

// tabs read better with actor names; token names go in the tooltip
const labelOf = ent => ent.actor?.name || ent.cbts[0]?.name || ent.cbts[0]?.token?.name || "?";
const tipOf = ent => {
  const label = labelOf(ent);
  const tok = ent.cbts[0]?.name;
  return tok && tok !== label ? `${label} (${tok})` : label;
};

const PILL_W = 168;
const PILL_MIN_W = 70;
const GAP = 4;

// The tabs are Foundry's own minimized windows. One sheet is maximized (the
// active tab), visited sheets are minimized into rows of pills above it, and
// combatants whose sheet was never opened get a lightweight ghost tab instead,
// so a 30-NPC brawl costs nothing until a sheet is actually looked at.
export class SheetGroup {
  combat = null;
  entries = [];      // {key: actor uuid, actor, cbts: Combatant[], app}
  activeKey = null;
  rect = null;
  ptrDown = false;
  #applying = false;
  #showing = false;
  #closingAll = false;
  #layoutQueued = false;
  #btnAll = null;
  #actPill = null;
  #ghosts = new Map();
  #pendingShows = [];
  #showTimer = null;
  #layoutInfo = null;
  #rectSaveT = null;

  constructor() {
    // the rect is remembered per world: systems size their sheets differently
    const stored = game.settings.get(MOD, "winRect");
    this.rect = stored?.[game.world.id] ?? (stored?.left != null ? stored : null);
  }

  sync() {
    this.combat = game.combat ?? null;
    const incPCs = game.settings.get(MOD, "includePCs");

    // one tab per unique actor, in initiative order
    const want = [];
    const byKey = new Map();
    for (const c of this.combat?.turns ?? []) {
      const actor = c.actor;
      if (!actor?.sheet) continue;
      if (!incPCs && actor.hasPlayerOwner) continue;
      const dupe = byKey.get(actor.uuid);
      if (dupe) { dupe.cbts.push(c); continue; }
      const ent = { key: actor.uuid, actor, cbts: [c], app: null, userClosed: false };
      byKey.set(ent.key, ent);
      want.push(ent);
    }

    const old = new Map(this.entries.map(e => [e.key, e]));
    this.entries = want.map(w => {
      const e = old.get(w.key);
      if (!e) return w;
      old.delete(w.key);
      e.cbts = w.cbts;
      return e;
    });
    for (const e of old.values()) this.#closeApp(e.app);   // left the combat

    // pull in sheets that were already open
    for (const e of this.entries) {
      if (!e.app && e.actor.sheet?.rendered) this.#adopt(e, e.actor.sheet);
    }
    this.#reconcile();
  }

  clear() {
    const apps = this.entries.map(e => e.app).filter(a => a?.rendered);
    this.entries = [];
    this.activeKey = null;
    this.combat = null;
    for (const a of apps) this.#closeApp(a);
    this.#layoutPills();
  }

  onCombatDeleted(combat) {
    if (combat === this.combat) this.clear();
    else this.sync();
  }

  activate(key) {
    const ent = this.entries.find(e => e.key === key);
    if (!ent) return;
    ent.userClosed = false;
    if (ent.app?.rendered) this.#show(ent);
    else ent.actor.sheet?.render(true);   // adoption finishes in onSheetRender
  }

  async closeAll() {
    this.#closingAll = true;
    try {
      for (const e of this.entries) this.#closeApp(e.app);
    } finally {
      this.#closingAll = false;
    }
    this.activeKey = null;
    this.#layoutPills();
  }

  onTurn(combat) {
    this.#layoutPills();
    if (!combat?.started) return;
    if (!game.settings.get(MOD, "autoSwitch")) return;
    const cur = combat.combatant;
    if (!cur) return;
    const ent = this.entries.find(e => e.cbts.some(c => c.id === cur.id));
    if (ent) this.activate(ent.key);
  }

  onCombatantUpdate(cbt, changed) {
    this.#layoutPills();
    if (!("defeated" in changed)) return;
    if (!game.settings.get(MOD, "autoCloseDefeated")) return;
    const ent = this.entries.find(e => e.cbts.some(c => c.id === cbt.id));
    if (ent && ent.cbts.every(c => c.isDefeated)) this.#closeApp(ent.app);
  }

  onSheetRender(app) {
    const doc = app.actor ?? app.document ?? app.object;
    const ent = doc?.uuid ? this.entries.find(e => e.key === doc.uuid) : null;
    if (!ent) return;
    if (ent.app === app) return;   // re-renders change nothing about tab state
    this.#adopt(ent, app);
    ent.userClosed = false;
    el(app)?.style.setProperty("opacity", "0");   // stay hidden until placed
    // a burst of outside opens (a system opening every NPC sheet at once)
    // becomes one active tab and a row of pills, not thirty fights for focus
    this.#pendingShows.push(ent);
    clearTimeout(this.#showTimer);
    this.#showTimer = setTimeout(() => {
      const batch = this.#pendingShows.splice(0);
      const last = batch.pop();
      for (const e of batch) {
        if (e.app?.rendered && e !== last) this.#pillify(e);
      }
      if (last) this.#showWhenReady(last);
    }, 50);
  }

  onSheetClose(app) {
    if (app.rendered) return;   // a close() call that did not actually close
    const ent = this.entries.find(e => e.app === app);
    if (!ent) return;
    if (ent.key === this.activeKey) {
      this.#captureRect(app);
      this.activeKey = null;   // closing means close, not "show me the next one"
    }
    ent.app = null;
    ent.userClosed = true;   // closed means gone from the row, not a ghost
    this.#layoutPills();
  }

  onFront(app) {
    if (this.#showing || this.#closingAll) return;
    // core fronts a window on pointerdown, while the header may be starting a
    // drag with pointer capture; morphing the pill mid-press hands that drag to
    // the restored sheet. Pills activate on click instead, after release.
    if (isMin(app)) return;
    const ent = this.entries.find(e => e.app === app);
    if (!ent?.app?.rendered) return;
    if (ent.key === this.activeKey) return;
    this.#show(ent);
  }

  onMoved(app) {
    if (this.#showing) return;
    const ent = this.entries.find(e => e.app === app);
    if (!ent) return;
    if (!isMin(app)) {
      if (ent.key !== this.activeKey) return;
      // a drag or resize by hand becomes the shared size right away; module and
      // core moves are ignored here so stale restores cannot pollute the rect
      if (!this.#applying && this.ptrDown) {
        const p = app.position ?? {};
        if (p.left != null) {
          this.rect = { left: p.left, top: p.top, width: p.width, height: p.height };
          this.#saveRect();
        }
      }
      this.#layoutPills();   // row follows the active window
      return;
    }
    // with every sheet folded, dragging one pill drags the whole row
    const act = this.entries.find(e => e.key === this.activeKey && e.app?.rendered && !isMin(e.app));
    if (act) return;   // row is anchored to the open window; the pill snaps back
    const info = this.#layoutInfo;
    const i = info ? info.keys.indexOf(ent.key) : -1;
    if (i < 0) return;
    const p = app.position ?? {};
    if (p.left == null) return;
    const col = i % info.perRow;
    const row = Math.floor(i / info.perRow);
    this.rect = {
      ...(this.rect ?? {}),
      left: p.left - col * (info.pw + GAP),
      top: p.top + (row + 1) * (info.pillH + GAP) + 2
    };
    this.#saveRect();
    this.#layoutPills();
  }

  onMaximized(app) {
    const ent = this.entries.find(e => e.app === app);
    if (!ent || ent.key !== this.activeKey) return;
    this.#applyRect(app);   // core restores the pre-pill size; the shared rect wins
    this.#layoutPills();
  }

  onMinimized(app) {
    const ent = this.entries.find(e => e.app === app);
    if (!ent) return;
    if (ent.key === this.activeKey) {
      this.#captureRect(app);   // minimize keeps left and top, so the rect is still good here
      this.activeKey = null;
    }
    this.#layoutPills();
  }

  parkActive() {
    const ent = this.entries.find(e => e.key === this.activeKey && e.app?.rendered && !isMin(e.app));
    if (!ent) return;
    this.#captureRect(ent.app);
    this.activeKey = null;
    this.#park(ent);
    this.#layoutPills();
  }

  refreshSize() {
    const ent = this.entries.find(e => e.key === this.activeKey && e.app?.rendered && !isMin(e.app));
    if (ent) this.#applyRect(ent.app);
  }

  // re-zoom every open non-combat actor sheet when the slider or toggle moves
  rescaleAll() {
    const on = game.settings.get(MOD, "scaleOutside");
    const s = on ? Math.max((Number(game.settings.get(MOD, "sheetScale")) || 100) / 100, 0.1) : 1;
    const apply = app => {
      const doc = app.actor ?? app.document ?? app.object;
      if (!(doc instanceof Actor) || !app.rendered || isMin(app)) return;
      if (this.entries.some(e => e.app === app)) return;   // combat sheets go through applyRect
      try { app.setPosition({ scale: s }); } catch (err) {}
    };
    for (const app of foundry.applications.instances.values()) apply(app);
    for (const app of Object.values(ui.windows ?? {})) apply(app);
  }

  #adopt(ent, app) {
    ent.app = app;
    const node = el(app);
    if (!node) return;
    node.classList.add("csb-managed");
    // closing and reopening keeps the app instance but builds a fresh element,
    // so the listeners have to be tracked per element
    if (node.dataset.csbBound) return;
    node.dataset.csbBound = "1";
    // single click on a pill switches to it; swallow the native dblclick that follows
    node.addEventListener("pointerdown", ev => {
      if (isMin(app)) app.__csbPt = { x: ev.clientX, y: ev.clientY };
    }, true);
    node.addEventListener("click", ev => {
      if (!isMin(app)) return;
      if (ev.target.closest('[data-action="close"], a.close')) return;
      const pt = app.__csbPt;
      if (pt && Math.hypot(ev.clientX - pt.x, ev.clientY - pt.y) > 6) return;   // that was a drag
      ev.preventDefault();
      ev.stopPropagation();
      app.__csbTs = Date.now();
      this.activate(ent.key);
    }, true);
    node.addEventListener("dblclick", ev => {
      if (Date.now() - (app.__csbTs ?? 0) < 600) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }, true);
  }

  async #pillify(ent) {
    const app = ent.app;
    const node = el(app);
    if (!node) return;
    node.style.opacity = "0";
    if (app.rendered && !isMin(app)) {
      try { await app.minimize(); } catch (err) {}
    }
    if (!isMin(app)) {
      node.style.removeProperty("opacity");
      node.style.display = "none";   // sheet refused to minimize; keep it out of the way
      return;
    }
    this.#doLayout();   // slot the pill before it shows
    node.style.removeProperty("opacity");
  }

  // render hooks fire before the app reports rendered, so wait that out
  #showWhenReady(ent) {
    const app = ent.app;
    if (app?.rendered) return void this.#show(ent);
    let tries = 30;
    const tick = () => {
      if (ent.app !== app || !this.entries.includes(ent)) return;
      if (app.rendered) return void this.#show(ent);
      if (tries-- > 0) setTimeout(tick, 30);
    };
    setTimeout(tick, 0);
  }

  async #show(ent) {
    const app = ent.app;
    if (!app?.rendered) return;
    const prev = this.entries.find(e => e.key === this.activeKey && e !== ent);
    if (prev?.app?.rendered && !isMin(prev.app)) this.#captureRect(prev.app);
    this.activeKey = ent.key;
    const node = el(app);
    if (node) node.style.display = "";
    this.#showing = true;
    try { app.bringToFront(); } finally { this.#showing = false; }
    this.#layoutPills();   // update the row right away; v1 folds take a while
    // the swap paints no intermediate frames: the incoming sheet unfolds fully
    // hidden and appears finished; the outgoing one folds hidden behind it
    if (isMin(app) && node) {
      node.style.opacity = "0";
      this.#moveMin(app, this.rect);
      await app.maximize();
      this.#applyRect(app);
    } else if (node?.classList.contains("maximizing")) {
      node.style.opacity = "0";   // core began this restore itself (token double-click)
      await new Promise(r => setTimeout(r, 60));
      this.#applyRect(app);
    } else {
      this.#applyRect(app);
    }
    const title = node?.querySelector(".window-title");
    if (title?.dataset.csbOrig) {
      title.textContent = title.dataset.csbOrig;
      delete title.dataset.csbOrig;
    }
    node?.removeAttribute("data-tooltip");
    node?.style.removeProperty("opacity");
    if (prev?.app?.rendered && !isMin(prev.app)) this.#park(prev);
    this.#layoutPills();
    // a restore started by core (token double-click) animates on its own schedule
    setTimeout(() => {
      if (this.activeKey === ent.key && app.rendered && !isMin(app)) {
        this.#applyRect(app);
        this.#layoutPills();
      }
    }, 400);
  }

  // some v1 sheets wedge mid-close and ignore the X forever; force it and sweep
  #closeApp(app) {
    if (!app?.rendered) return;
    Promise.resolve(app.close({ animate: false, force: true }))
      .catch(() => {})
      .finally(() => {
        const node = el(app);
        if (node?.isConnected) node.remove();
      });
  }

  #park(ent) {
    const app = ent.app;
    if (!app?.rendered || isMin(app)) return;
    const node = el(app);
    node?.style.setProperty("opacity", "0");   // fold out of sight
    app.minimize().then(() => {
      this.#doLayout();                        // slot the pill before it reappears
      node?.style.removeProperty("opacity");
    }).catch(() => node?.style.removeProperty("opacity"));
  }

  #moveMin(app, rect) {
    if (!rect) return;
    const node = el(app);
    if (!node) return;
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    const p = app.position;
    if (p && typeof p === "object") {
      try { p.left = rect.left; p.top = rect.top; } catch (err) {}
    }
  }

  #reconcile() {
    let act = this.entries.find(e => e.key === this.activeKey && e.app?.rendered);
    if (!act) this.activeKey = null;
    // never more than one open window: extras fold into pills
    for (const e of this.entries) {
      if (!e.app?.rendered || isMin(e.app)) continue;
      if (!act) {
        act = e;
        this.activeKey = e.key;
        continue;
      }
      if (e !== act) this.#park(e);
    }
    if (act?.app?.rendered && !isMin(act.app) && !this.rect) this.#captureRect(act.app);
    this.#layoutPills();
  }

  #captureRect(app) {
    const p = app.position;
    if (!p || p.left == null) return;
    this.rect = { left: p.left, top: p.top, width: p.width, height: p.height };
    this.#saveRect();
  }

  #saveRect() {
    clearTimeout(this.#rectSaveT);
    this.#rectSaveT = setTimeout(() => {
      const stored = game.settings.get(MOD, "winRect");
      const all = (stored && typeof stored === "object" && stored.left == null) ? { ...stored } : {};
      all[game.world.id] = this.rect;
      game.settings.set(MOD, "winRect", all);
    }, 300);
  }

  #applyRect(app) {
    if (!this.rect) this.#captureRect(app);
    const r = this.rect ? { left: this.rect.left, top: this.rect.top } : {};
    const resizable = app.options?.resizable ?? app.options?.window?.resizable;
    const syncSize = game.system.id !== "vtm-v20" && game.settings.get(MOD, "syncSize");
    if (syncSize && resizable !== false) {
      if (this.rect?.width != null) r.width = this.rect.width;
      if (this.rect?.height != null) r.height = this.rect.height;
    }
    // the size slider zooms the whole sheet, content included
    r.scale = Math.max((Number(game.settings.get(MOD, "sheetScale")) || 100) / 100, 0.1);
    this.#applying = true;
    try { app.setPosition(r); } finally { this.#applying = false; }
  }

  #layoutPills() {
    if (this.#layoutQueued) return;
    this.#layoutQueued = true;
    const run = () => {
      if (!this.#layoutQueued) return;
      this.#layoutQueued = false;
      this.#doLayout();
    };
    // rAF starves while the window is hidden; never let layout wait on it
    requestAnimationFrame(run);
    setTimeout(run, 80);
  }

  #doLayout() {
    // no open sheet means no browser: closing everything clears the screen
    const anyOpen = this.entries.some(e => {
      const node = e.app?.rendered ? el(e.app) : null;
      return node && node.style.display !== "none";
    });
    if (!anyOpen) {
      for (const [k, g] of this.#ghosts) { g.remove(); this.#ghosts.delete(k); }
      this.#actPill?.remove();
      this.#actPill = null;
      this.#btnAll?.remove();
      this.#btnAll = null;
      return;
    }
    const act = this.entries.find(e => e.key === this.activeKey && e.app?.rendered && !isMin(e.app));
    let anchor;
    if (act) {
      // bounding box, not layout box: a zoomed sheet's visual size is what counts
      const b = el(act.app)?.getBoundingClientRect();
      const p = act.app.position ?? {};
      anchor = b?.width
        ? { left: b.left, top: b.top, width: b.width }
        : { left: p.left ?? 120, top: p.top ?? 180, width: p.width || 520 };
    } else if (this.rect) {
      anchor = { left: this.rect.left, top: this.rect.top, width: this.rect.width || 520 };
    } else {
      anchor = { left: 120, top: 180, width: 520 };
    }

    // ghosts stand in for sheets never opened; tabs the user closed stay gone
    const slotted = this.entries.filter(e => {
      if (!e.app?.rendered) return !e.userClosed;
      const node = el(e.app);
      return node && node.style.display !== "none";
    });

    let pillH = 34;
    const firstMin = slotted.find(e => e.app?.rendered && isMin(e.app));
    const minNode = firstMin ? el(firstMin.app) : null;
    if (minNode?.offsetHeight) pillH = Math.min(minNode.offsetHeight, 64);

    // fit the rows into the space above the window, shrinking tabs when crowded
    const count = slotted.length + 1;   // one extra slot for the close-all button
    let perRow = Math.max(1, Math.floor((anchor.width + GAP) / (PILL_W + GAP)));
    const maxRows = Math.max(1, Math.floor(Math.max(anchor.top - 2, pillH + GAP) / (pillH + GAP)));
    if (Math.ceil(count / perRow) > maxRows) perRow = Math.ceil(count / maxRows);
    const availW = Math.max(240, window.innerWidth - anchor.left - 8);
    let pw = PILL_W;
    if (perRow * (PILL_W + GAP) - GAP > availW) {
      pw = Math.max(PILL_MIN_W, Math.floor(availW / perRow) - GAP);
    }

    const slot = i => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      return {
        x: Math.max(0, anchor.left + col * (pw + GAP)),
        y: Math.max(0, anchor.top - (row + 1) * (pillH + GAP) - 2)
      };
    };

    this.#layoutInfo = { pw, pillH, perRow, keys: slotted.map(e => e.key) };

    let activeSlot = null;
    const liveGhosts = new Set();
    slotted.forEach((e, i) => {
      const pos = slot(i);
      if (e === act) {
        activeSlot = pos;
        return;
      }
      if (!e.app?.rendered) {
        this.#syncGhost(e, pos, pillH, pw);
        liveGhosts.add(e.key);
        return;
      }
      if (!isMin(e.app)) {
        // folding or unfolding out of sight (v1 animations take ~300ms): hold
        // the slot with a solid placeholder so the tab never blinks away
        const node = el(e.app);
        if (node && node.style.opacity === "0") {
          this.#syncGhost(e, pos, pillH, pw, true);
          liveGhosts.add(e.key);
        }
        return;
      }
      const node = el(e.app);
      node.style.left = `${pos.x}px`;
      node.style.top = `${pos.y}px`;
      node.style.width = `${pw}px`;
      node.style.setProperty("--minimized-width", `${pw}px`);
      node.style.transform = "none";   // pills keep one size whatever the zoom
      // pills show the actor name, not the sheet's long window title
      const t = node.querySelector(".window-title");
      if (t) {
        t.dataset.csbOrig ??= t.textContent;
        const lbl = labelOf(e);
        if (t.textContent !== lbl) t.textContent = lbl;
      }
      node.dataset.tooltip = tipOf(e);
      const p = e.app.position;
      if (p && typeof p === "object") {
        try { p.left = pos.x; p.top = pos.y; } catch (err) {}
      }
    });
    for (const [k, g] of this.#ghosts) {
      if (!liveGhosts.has(k)) { g.remove(); this.#ghosts.delete(k); }
    }

    this.#syncActivePill(act, activeSlot, pillH, pw);
    this.#refreshStates();
    this.#syncCloseAll(slotted.length, slot, pillH);
  }

  #syncGhost(ent, pos, pillH, pw, solid = false) {
    let g = this.#ghosts.get(ent.key);
    if (!g) {
      g = document.createElement("a");
      g.className = "csb-ghost-pill";
      g.append(document.createElement("span"));
      g.addEventListener("click", () => this.activate(ent.key));
      document.body.append(g);
      this.#ghosts.set(ent.key, g);
    }
    g.classList.toggle("csb-solid", solid);
    g.firstElementChild.textContent = labelOf(ent);
    g.dataset.tooltip = tipOf(ent);
    const cur = this.combat?.started ? this.combat.combatant : null;
    g.classList.toggle("csb-turn", !!cur && ent.cbts.some(x => x.id === cur.id));
    g.classList.toggle("csb-defeated", ent.cbts.every(x => x.isDefeated));
    g.style.left = `${pos.x}px`;
    g.style.top = `${pos.y}px`;
    g.style.height = `${pillH}px`;
    g.style.width = `${pw}px`;
  }

  // the active sheet is the open window, so its spot in the row is a stand-in tab
  #syncActivePill(act, pos, pillH, pw) {
    if (!act || !pos) {
      this.#actPill?.remove();
      this.#actPill = null;
      return;
    }
    if (!this.#actPill) {
      const b = document.createElement("a");
      b.className = "csb-active-pill";
      b.append(document.createElement("span"));
      b.addEventListener("click", () => {
        this.entries.find(x => x.key === this.activeKey)?.app?.bringToFront();
      });
      document.body.append(b);
      this.#actPill = b;
    }
    this.#actPill.firstElementChild.textContent = labelOf(act);
    this.#actPill.dataset.tooltip = tipOf(act);
    const cur = this.combat?.started ? this.combat.combatant : null;
    this.#actPill.classList.toggle("csb-turn", !!cur && act.cbts.some(x => x.id === cur.id));
    this.#actPill.classList.toggle("csb-defeated", act.cbts.every(x => x.isDefeated));
    this.#actPill.style.left = `${pos.x}px`;
    this.#actPill.style.top = `${pos.y}px`;
    this.#actPill.style.height = `${pillH}px`;
    this.#actPill.style.width = `${pw}px`;
  }

  #refreshStates() {
    const cur = this.combat?.started ? this.combat.combatant : null;
    for (const e of this.entries) {
      const node = e.app?.rendered ? el(e.app) : null;
      if (!node) continue;
      node.classList.add("csb-managed");
      node.classList.toggle("csb-turn", !!cur && e.cbts.some(c => c.id === cur.id));
      node.classList.toggle("csb-defeated", e.cbts.every(c => c.isDefeated));
    }
  }

  #syncCloseAll(count, slot, pillH) {
    if (!count) {
      this.#btnAll?.remove();
      this.#btnAll = null;
      return;
    }
    if (!this.#btnAll) {
      const b = document.createElement("a");
      b.className = "csb-close-all";
      b.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      b.dataset.tooltip = game.i18n.localize("CSB.CloseAll");
      b.addEventListener("click", () => this.closeAll());
      document.body.append(b);
      this.#btnAll = b;
    }
    const pos = slot(count);
    this.#btnAll.style.left = `${pos.x}px`;
    this.#btnAll.style.top = `${pos.y + Math.max(0, Math.floor((pillH - 26) / 2))}px`;
  }
}
