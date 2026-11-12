import { ID } from "./model.js";

export const READINESS_CHANNEL = `module.${ID}`;
export const READY_START_DELAY_MS = 1200;
export const READY_RESPONSE_TIMEOUT_MS = 15000;
export const WIDGET_DISCOVERY_MS = 1000;
export const WIDGET_HEARTBEAT_MS = 5000;

export function sendReadiness(message) {
  // User activity is transient and its server channel is always registered. A newly
  // enabled module socket is unavailable until Foundry itself has been restarted.
  game.user.broadcastActivity({ [ID]: message }, { volatile:false });
}

// Only the active GM publishes a start. Client messages acknowledge one clock generation.
export class PlaybackReadiness {
  constructor({ publish, changed = () => {}, now = () => Date.now(), user = () => game.user,
    users = () => game.users.filter(u => u.active), leader = () => game.users.activeGM?.id,
    send = sendReadiness, discoveryMs = WIDGET_DISCOVERY_MS }) {
    Object.assign(this, { publish, changed, now, user, users, leader, send, discoveryMs });
    this.entries = new Map(); this.widgets = new Map(); this.widgetActive = false;
    this.widgetId = `${now()}-${Math.random().toString(36).slice(2)}`;
    this.presenceSentAt = -Infinity; this.discoveryUntil = 0;
  }
  activate() {
    if (this.widgetActive) return;
    this.widgetActive = true;
    this.discoveryUntil = this.now() + this.discoveryMs;
    this.announceWidget(true);
    this.send({type:"widget-query",userId:this.user().id});
  }
  deactivate() {
    if (!this.widgetActive) return;
    this.widgetActive = false;
    this.send({type:"widget-unloaded",userId:this.user().id,widgetId:this.widgetId});
    this.widgets.clear(); this.entries.clear(); this.changed();
  }
  announceWidget(force = false) {
    if (!this.widgetActive || (!force && this.now()-this.presenceSentAt < WIDGET_HEARTBEAT_MS)) return;
    this.presenceSentAt = this.now();
    const message = {type:"widget-ready",userId:this.user().id,widgetId:this.widgetId};
    this.receive(message); this.send(message);
  }
  members() { return this.users().filter(u => this.widgets.has(u.id)); }
  rememberWidget(message) {
    const previous = this.widgets.get(message.userId);
    const widgetId = message.widgetId ?? "legacy";
    if (previous === widgetId) return;
    this.widgets.set(message.userId,widgetId);
    for (const entry of this.entries.values()) entry.statuses.delete(message.userId);
    this.changed();
  }
  key(doc) { return `${doc.parent.id}:${doc.id}`; }
  valid(entry) { return entry.doc.playing && entry.doc.path === entry.clock.path && entry.doc.getFlag(ID,"clock")?.id === entry.clock.id && entry.doc.getFlag(ID,"clock")?.waiting === true; }
  track(doc, clock) {
    const key = this.key(doc);
    let entry = this.entries.get(key);
    if (!entry || entry.clock.id !== clock.id) {
      entry = { key, doc, clock, statuses:new Map(), sentAt:-Infinity, createdAt:this.now(), unresponsive:"" };
      this.entries.set(key, entry);
    }
    return entry;
  }
  report(doc, clock, status, error = "") {
    if (!clock.waiting) return;
    const entry = this.track(doc, clock);
    const changed = entry.local?.status !== status || entry.local?.error !== error;
    if (changed) this.changed();
    entry.local = { status, error };
    this.announce(entry, changed);
  }
  announce(entry, force = false) {
    if (!entry.local || !this.valid(entry) || (!force && this.now() - entry.sentAt < 1000)) return;
    const message = { type:"audio-ready", playlistId:entry.doc.parent.id, trackId:entry.doc.id, clockId:entry.clock.id, userId:this.user().id, widgetId:this.widgetId, ...entry.local };
    entry.sentAt = this.now();
    this.receive(message); // Server broadcasts go to the other clients only.
    this.send(message);
  }
  receive(message) {
    if (!this.users().some(u => u.id === message?.userId)) return;
    if (message.type === "widget-query") { this.announceWidget(true); return; }
    if (message.type === "widget-ready") { this.rememberWidget(message); return; }
    if (message.type === "widget-unloaded") {
      if (this.widgets.get(message.userId) !== message.widgetId) return;
      this.widgets.delete(message.userId);
      for (const entry of this.entries.values()) entry.statuses.delete(message.userId);
      this.tick(); this.changed(); return;
    }
    if (!this.user().isGM || this.leader() !== this.user().id || message?.type !== "audio-ready") return;
    const entry = this.entries.get(`${message.playlistId}:${message.trackId}`);
    if (!entry || !this.valid(entry) || message.clockId !== entry.clock.id || !this.users().some(u => u.id === message.userId)) return;
    if (!["loading","ready","locked","error"].includes(message.status)) return;
    const widgetId = this.widgets.get(message.userId);
    if (widgetId && message.widgetId && widgetId !== message.widgetId) return;
    // A valid track acknowledgement also proves the widget has finished loading.
    if (!widgetId) this.rememberWidget(message);
    const status = {status:message.status,error:String(message.error ?? "").slice(0,300)};
    if (JSON.stringify(entry.statuses.get(message.userId)) !== JSON.stringify(status)) {
      entry.statuses.set(message.userId,status); this.changed();
    }
    this.start(entry);
  }
  complete(entry) {
    const members = this.members();
    return this.valid(entry) && this.now() >= this.discoveryUntil && members.some(u => u.id === this.user().id)
      && members.every(u => entry.statuses.get(u.id)?.status === "ready");
  }
  start(entry) {
    if (!this.user().isGM || this.leader() !== this.user().id || entry.committing || !this.complete(entry)) return;
    entry.committing = true;
    void Promise.resolve().then(() => this.publish(entry.doc, entry.clock, () => this.complete(entry)))
      .catch(error => { entry.error = error.message; this.changed(); })
      .finally(() => { entry.committing = false; });
  }
  userConnected(user) {
    this.widgets.delete(user.id);
    for (const entry of this.entries.values()) entry.statuses.delete(user.id);
    this.announceWidget(true);
    this.tick(); this.changed();
  }
  tick() {
    this.announceWidget();
    for (const [key, entry] of this.entries) {
      if (!this.valid(entry)) { this.entries.delete(key); continue; }
      this.announce(entry); this.start(entry);
      const unresponsive = this.unresponsive(entry).map(u => u.id).join(",");
      if (entry.unresponsive !== unresponsive) { entry.unresponsive = unresponsive; this.changed(); }
    }
  }
  unresponsive(entry) {
    return this.now() - entry.createdAt < READY_RESPONSE_TIMEOUT_MS ? [] : this.members().filter(u => !entry.statuses.has(u.id));
  }
  get status() {
    const entry = [...this.entries.values()].find(entry => this.valid(entry));
    if (!entry) return null;
    const members = this.members(), pending = members.filter(u => entry.statuses.get(u.id)?.status !== "ready");
    const gm = this.user().isGM && this.leader() === this.user().id;
    const missing = gm ? this.unresponsive(entry) : [];
    const error = entry.error || (gm ? pending.map(u => {
      const status = entry.statuses.get(u.id);
      return status?.status === "error" ? `${u.name}: ${status.error}` : status?.status === "locked" ? `${u.name}: нужно разрешить звук щелчком по странице` : "";
    }).filter(Boolean).join("; ") || (missing.length ? `Нет ответа от: ${missing.map(u => u.name).join(", ")}. Обновите страницу этих участников (Ctrl+F5), затем разрешите звук щелчком по странице.` : "") : entry.local?.status === "locked" ? "Щёлкните по странице, чтобы разрешить звук." : entry.local?.error);
    const label = gm ? `Готовы ${members.length-pending.length}/${members.length}` : entry.local?.status === "ready" ? "Ждём остальных" : "Загрузка звука";
    return { waiting:true, label, error:Boolean(error), message:error || (gm && pending.length ? `Ожидаем загрузки: ${pending.map(u => u.name).join(", ")}` : "Ожидаем готовности всех участников перед общим стартом.") };
  }
}
