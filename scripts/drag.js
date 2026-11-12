import { ID } from "./model.js";

const MIME = "application/x-yapw-track";

export class TrackDrag {
  constructor(widget) { this.widget = widget; this.active = false; }
  bind(root) {
    root.addEventListener("pointerdown", event => this.pointerDown(event));
    root.addEventListener("dragstart", event => this.start(event));
    root.addEventListener("dragover", event => this.over(event));
    root.addEventListener("drop", event => this.drop(event));
    root.addEventListener("dragend", () => this.finish());
    root.addEventListener("dragleave", event => {
      if (!root.contains(event.relatedTarget)) { this.clearMarks(); this.scroll = null; }
    });
  }
  pointerDown(event) {
    this.blocked = Boolean(event.target.closest("button, input, select"));
    const row = event.target.closest("[data-track]");
    if (!row || !game.user.isGM || this.blocked || event.button !== 0) return;
    // Pointer dragging also works across the detached mini-list and library windows.
    event.preventDefault();
    this.candidate = { row, x: event.clientX, y: event.clientY, payload: { module: ID, world: game.world.id, playlistId: row.dataset.playlist, trackId: row.dataset.track } };
    this.onMove = ev => this.pointerMove(ev);
    this.onEnd = ev => this.pointerEnd(ev);
    this.onCancel = () => this.finish();
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onEnd, {once:true});
    window.addEventListener("pointercancel", this.onCancel, {once:true});
    window.addEventListener("blur", this.onCancel, {once:true});
  }
  pointerMove(event) {
    if (!this.candidate) return;
    if (!this.active) {
      if (Math.hypot(event.clientX-this.candidate.x,event.clientY-this.candidate.y) < 5) return;
      this.active = true; this.payload = this.candidate.payload; this.sourceRow = this.candidate.row;
      this.sourceRow.classList.add("is-dragging");
      this.ghost = this.sourceRow.cloneNode(true);
      this.ghost.className = "yapw yapw-track yapw-drag-ghost";
      this.ghost.removeAttribute("data-track"); this.ghost.removeAttribute("data-playlist");
      this.ghost.setAttribute("aria-hidden","true"); this.ghost.setAttribute("draggable","false");
      this.ghost.style.width = Math.min(400,this.sourceRow.getBoundingClientRect().width) + "px";
      document.body.append(this.ghost);
    }
    event.preventDefault(); this.ghost.style.left = event.clientX+12+"px"; this.ghost.style.top = event.clientY+10+"px";
    const element = document.elementFromPoint(event.clientX,event.clientY);
    const target = element ? this.target({target:element,clientY:event.clientY}) : null;
    this.clearMarks(); if (target) target.element.classList.add(target.mark);
    this.scroll = {element:element?.closest(".yapw-scroll"),y:event.clientY};
    if (!this.scrollFrame) this.scrollFrame = requestAnimationFrame(() => this.autoScroll());
  }
  pointerEnd(event) {
    const payload = this.payload, element = document.elementFromPoint(event.clientX,event.clientY);
    const target = this.active && element ? this.target({target:element,clientY:event.clientY}) : null;
    this.finish();
    if (payload && target && game.user.isGM) void this.widget.perform(async () => {
      await this.widget.library.transferTrack(payload.playlistId,payload.trackId,target.playlistId,target.beforeId);
      this.widget.schedule();
    });
  }
  start(event) {
    const row = event.target.closest("[data-track]");
    if (!row) return;
    if (this.candidate || !game.user.isGM || this.blocked || !event.dataTransfer) { event.preventDefault(); return; }
    const payload = { module: ID, world: game.world.id, playlistId: row.dataset.playlist, trackId: row.dataset.track };
    event.dataTransfer.setData(MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
    this.active = true; this.payload = payload; this.sourceRow = row;
    row.classList.add("is-dragging");
  }
  accepts(event) { return game.user.isGM && Array.from(event.dataTransfer?.types ?? []).includes(MIME); }
  target(event) {
    const card = event.target.closest(".yapw-playlist-card[data-playlist]");
    if (card) return { playlistId: card.dataset.playlist, beforeId: null, element: card, mark: "yapw-drop-target" };
    const row = event.target.closest("[data-track]");
    if (row) {
      const playlistId = row.dataset.playlist, p = game.playlists.get(playlistId);
      const tracks = this.widget.library.tracks(p), index = tracks.findIndex(t => t.id === row.dataset.track);
      if (index < 0) return null;
      const rect = row.getBoundingClientRect(), after = event.clientY > rect.top + rect.height / 2;
      return { playlistId, beforeId: after ? tracks[index + 1]?.id ?? null : row.dataset.track, element: row, mark: after ? "yapw-drop-after" : "yapw-drop-before" };
    }
    const list = event.target.closest("[data-track-list][data-playlist]");
    return list ? { playlistId: list.dataset.playlist, beforeId: null, element: list, mark: "yapw-drop-target" } : null;
  }
  over(event) {
    if (!this.accepts(event)) return;
    const target = this.target(event);
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    this.clearMarks(); target.element.classList.add(target.mark);
    this.scroll = { element: event.target.closest(".yapw-scroll"), y: event.clientY };
    if (!this.scrollFrame) this.scrollFrame = requestAnimationFrame(() => this.autoScroll());
  }
  autoScroll() {
    this.scrollFrame = null;
    if (!this.active || !this.scroll?.element?.isConnected) return;
    const { element, y } = this.scroll, rect = element.getBoundingClientRect();
    const edge = Math.min(35, rect.height / 3);
    if (y < rect.top + edge) element.scrollTop -= 7;
    else if (y > rect.bottom - edge) element.scrollTop += 7;
    this.scrollFrame = requestAnimationFrame(() => this.autoScroll());
  }
  drop(event) {
    if (!this.accepts(event)) return;
    const target = this.target(event);
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    let payload;
    try { payload = JSON.parse(event.dataTransfer.getData(MIME)); } catch { this.finish(); return; }
    this.finish();
    if (payload.module !== ID || payload.world !== game.world.id || typeof payload.trackId !== "string" || typeof payload.playlistId !== "string") return;
    void this.widget.perform(async () => {
      await this.widget.library.transferTrack(payload.playlistId, payload.trackId, target.playlistId, target.beforeId);
      this.widget.schedule();
    });
  }
  clearMarks() {
    document.querySelectorAll(".yapw .yapw-drop-target, .yapw .yapw-drop-before, .yapw .yapw-drop-after").forEach(el => el.classList.remove("yapw-drop-target", "yapw-drop-before", "yapw-drop-after"));
  }
  finish() {
    if (this.onMove) window.removeEventListener("pointermove",this.onMove);
    if (this.onEnd) window.removeEventListener("pointerup",this.onEnd);
    if (this.onCancel) { window.removeEventListener("pointercancel",this.onCancel); window.removeEventListener("blur",this.onCancel); }
    this.candidate = null; this.ghost?.remove(); this.ghost = null;
    this.sourceRow?.classList.remove("is-dragging"); this.clearMarks();
    this.active = false; this.payload = null; this.sourceRow = null; this.scroll = null;
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null; this.widget.schedule();
  }
}
