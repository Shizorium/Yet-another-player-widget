import { ID, ROOT, STATUS, clamp, time, escapeHTML as e, audioPath, youtubeSource, clone } from "./model.js";
import { Library, uploadFile, readDuration } from "./library.js";
import { Downloads } from "./downloads.js";
import { miniView, fullView, currentPlaylistView, volumeView, icon } from "./view.js";
import { TrackDrag } from "./drag.js";
import { TrackPreview } from "./preview.js";
import { PlaybackSync, installPlaybackSync, stampPlayback, localLayerVolume, soundDuration } from "./sync.js";

let player;
function report(error) { console.error(`${ID} |`, error); ui.notifications.error(error.message || String(error)); }

export class PlayerWidget {
  constructor() {
    this.library = new Library(); this.downloads = new Downloads(this.library, () => this.schedule());
    this.audioSync = new PlaybackSync(this.library, () => this.schedule());
    this.preview = new TrackPreview(() => this.schedule(), muted => this.audioSync.setPreviewMuted(muted));
    this.selected = null; this.tab = "library"; this.query = ""; this.full = null; this.dialog = null; this.lastSignature = ""; this.uploadFiles = new Map(); this.uploadControllers = new Map();
    this.trackDrag = new TrackDrag(this); this.miniPlaylistOpen = false;
    this.miniBrowseAll = false; this.miniBrowseId = null; this.miniScrollPositions = new Map();
    this.miniExtraHeight = 0; this.layerVolumeTimers = new Map();
    this.mini = document.createElement("section"); this.mini.id = "yapw-mini"; this.mini.className = "yapw";
    this.mini.setAttribute("aria-label", "Музыкальный плеер"); document.body.append(this.mini);
    this.bind(this.mini);
    const savedLayout = game.settings.get(ID, "layout");
    const layout = savedLayout.version === 3 ? savedLayout : { ...savedLayout, version: 3, width: savedLayout.version === 2 ? savedLayout.width : 460, height: 78, scale: savedLayout.scale ?? 1 };
    this.mini.style.width = `${clamp(layout.width ?? 460, 180, 800)}px`;
    this.mini.style.height = `${clamp(layout.height ?? 78, 48, 140)}px`;
    this.mini.style.setProperty("--yapw-scale", clamp(layout.scale ?? 1, 0.8, 1.2));
    this.updateMiniAppearance();
    this.position(layout.left ?? 85, layout.top ?? 110);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.mini.hidden) return;
      if (this.sizeMini()) this.schedule();
      this.updateMarquees();
      this.keepOnScreen(); this.saveLayout();
    });
    this.resizeObserver.observe(this.mini);
    this.onResize = () => { this.closePlaylistMenu(); this.keepOnScreen(); this.fitLibrary(); }; window.addEventListener("resize", this.onResize);
    this.mini.addEventListener("pointerdown", event => this.drag(event));
    this.mini.addEventListener("dblclick", event => {
      if (event.target.closest("button, input, label")) return;
      event.preventDefault(); this.openFull();
    });
    document.addEventListener("pointerdown", event => {
      if (!event.target.closest("[data-volume-trigger]") && !this.volumePopup?.contains(event.target)) this.closeVolume();
      if (!this.playlistMenu?.contains(event.target)) this.closePlaylistMenu();
    });
    this.timer = setInterval(() => this.updateTime(), 250);
    this.downloadTimer = setInterval(() => void this.downloads.tick(), 2500);
    this.syncTimer = setInterval(() => this.audioSync.tick(), 1000);
    this.onAudioWake = () => { if(!document.hidden) {void Promise.resolve(game.audio.music?.resume?.()).catch(()=>{});this.audioSync.tick();} };
    document.addEventListener("visibilitychange",this.onAudioWake);
    window.addEventListener("online",this.onAudioWake);
    game.socket?.on("connect",this.onAudioWake);
    window.addEventListener("pagehide",()=>this.audioSync.readiness.deactivate());
    window.addEventListener("pageshow",()=>{ if(game.socket)this.audioSync.readiness.activate(); });
    document.addEventListener("pointerdown",()=>this.audioSync.tick(),{once:true});
    this.reconcileTimer = setInterval(() => {
      if (game.user.isGM && game.users.activeGM?.id === game.user.id) void this.library.reconcile().catch(report);
    }, 30000);
    this.refresh(); void this.downloads.tick();
  }
  async perform(callback) { try { return await callback(); } catch (error) { report(error); } }
  schedule() { clearTimeout(this.renderTimer); this.renderTimer = setTimeout(() => this.refresh(), 100); }
  updateMiniAppearance() {
    const transparency = game.settings.get(ID,"miniTransparency");
    const value = typeof transparency === "number" && Number.isFinite(transparency) ? clamp(transparency,0,100) : 80;
    this.mini.style.setProperty("--yapw-idle-opacity",String(1-value/100));
    this.mini.classList.toggle("is-auto-fade",game.settings.get(ID,"fadeMini") === true);
  }
  sizeMini() {
    const base = clamp(parseFloat(this.mini.style.height) - this.miniExtraHeight,48,140);
    const compact = this.mini.getBoundingClientRect().width < 300 || base < 72;
    const changed = this.mini.classList.contains("is-compact") !== compact;
    this.mini.classList.toggle("is-compact",compact);
    const extraHeight = this.library.layerEntries.length * (compact ? 48 : 72);
    if (extraHeight !== this.miniExtraHeight) {
      this.miniExtraHeight = extraHeight; this.mini.style.setProperty("--yapw-extra-height",`${extraHeight}px`);
      this.mini.style.height = `${base + extraHeight}px`;
      return true;
    }
    return changed;
  }
  updateMarquees() {
    for (const root of [this.mini,this.full].filter(Boolean)) for (const title of root.querySelectorAll(".yapw-mini-title")) {
      const text = title.querySelector("[data-title-text]");
      if (!text) continue;
      const overflow = Math.max(0,text.scrollWidth - title.clientWidth);
      title.classList.toggle("is-scrolling",overflow > 1);
      title.style.setProperty("--title-travel",`${-overflow}px`);
      title.style.setProperty("--title-duration",`${Math.max(5,overflow / 24 + 2)}s`);
    }
  }
  position(left, top) {
    this.mini.style.left = `${clamp(left, 0, Math.max(0, innerWidth - (this.mini.offsetWidth || 460)))}px`;
    this.mini.style.top = `${clamp(top, 0, Math.max(0, innerHeight - (this.mini.offsetHeight || 78)))}px`;
    if (this.fullDocked) this.dockLibrary();
    this.positionMiniPlaylist(); this.positionVolume();
  }
  keepOnScreen() { const r = this.mini.getBoundingClientRect(); if (r.width) this.position(r.left, r.top); }
  saveLayout() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      if (this.mini.hidden) return;
      const r = this.mini.getBoundingClientRect();
      void game.settings.set(ID, "layout", { ...game.settings.get(ID, "layout"), version: 3, left: r.left, top: r.top, width: r.width, height: r.height - this.miniExtraHeight });
    }, 400);
  }
  drag(event) {
    if (!event.target.closest("[data-drag]") || event.target.closest("button, input, label") || event.button !== 0) return;
    event.preventDefault();
    const r = this.mini.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top;
    const move = ev => this.position(ev.clientX - x, ev.clientY - y);
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); this.saveLayout(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true });
  }
  bind(root) {
    this.trackDrag.bind(root);
    root.addEventListener("contextmenu", event => {
      const card = event.target.closest(".yapw-playlist-card[data-playlist]");
      if (!game.user.isGM || !card) return;
      event.preventDefault(); event.stopPropagation();
      this.openPlaylistMenu(card.dataset.playlist, event.clientX, event.clientY);
    });
    root.addEventListener("keydown", event => {
      const card = event.target.closest(".yapw-playlist-card[data-playlist]");
      if (!game.user.isGM || !card || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      event.preventDefault(); event.stopPropagation();
      const rect = card.getBoundingClientRect(); this.openPlaylistMenu(card.dataset.playlist, rect.left, rect.bottom);
    });
    root.addEventListener("pointerover", event => {
      const trigger = event.target.closest("[data-volume-trigger]");
      if (trigger && !trigger.contains(event.relatedTarget)) this.openVolume(trigger);
    });
    root.addEventListener("pointerout", event => {
      const trigger = event.target.closest("[data-volume-trigger]");
      if (trigger && !trigger.contains(event.relatedTarget)) this.queueCloseVolume();
    });
    root.addEventListener("focusin", event => { if (!this.suppressVolumeFocus && event.target.matches("[data-volume-trigger]")) this.openVolume(event.target); });
    root.addEventListener("focusout", event => { if (event.target.matches("[data-volume-trigger]")) this.queueCloseVolume(); });
    root.addEventListener("pointerdown", event => {
      if (!event.target.matches("input[type=range]")) return;
      this.interacting = true;
      window.addEventListener("pointerup", () => { this.interacting = false; this.schedule(); }, {once:true});
      window.addEventListener("pointercancel", () => { this.interacting = false; this.schedule(); }, {once:true});
    });
    root.addEventListener("click", event => {
      const button = event.target.closest("[data-action]");
      if (button) { event.preventDefault(); void this.perform(() => this.action(button.dataset.action, button)); }
    });
    root.addEventListener("change", event => {
      if (event.target.matches("[data-seek]")) {
        const input = event.target, request = this.seekRequest = (this.seekRequest ?? 0) + 1;
        const slot = Number(input.closest("[data-playback-layer]")?.dataset.playbackLayer ?? 0);
        void this.perform(async () => { try { await this.library.seek(input.value,slot); } finally { if (this.seekRequest === request) this.seekingInput = null; this.updateTime(); } });
      }
      if(event.target.matches("[data-local-layer-volume]")) {
        const slot = Number(event.target.dataset.localLayerVolume);
        clearTimeout(this.layerVolumeTimers.get(`local-${slot}`));
        void this.perform(()=>this.audioSync.setLocalVolume(slot,Number(event.target.value)));
      }
      if (event.target.matches("[data-volume]")) { clearTimeout(this.volumeTimer); void this.perform(() => game.settings.set("core", "globalPlaylistVolume", Number(event.target.value))); }
    });
    root.addEventListener("input", event => {
      if (event.target.matches("[data-search]")) { this.query = event.target.value; this.schedule(); }
      if (event.target.matches("[data-seek]")) {
        this.seekingInput = event.target;
        const elapsed = event.target.closest(".yapw-timeline").querySelector("[data-elapsed]") ?? root.querySelector("[data-elapsed]");
        if (elapsed) elapsed.textContent = time(Number(event.target.value));
      }
      if (event.target.matches("[data-volume]")) {
        const value = clamp(event.target.value, 0, 1);
        root.querySelectorAll("[data-volume-value]").forEach(el => { el.textContent = `${Math.round(value * 100)}%`; });
        clearTimeout(this.volumeTimer); this.volumeTimer = setTimeout(() => void this.perform(() => game.settings.set("core", "globalPlaylistVolume", value)), 50);
      }
    });
    root.addEventListener("input", event => {
      if(event.target.matches("[data-local-layer-volume]")) {
        const slot = Number(event.target.dataset.localLayerVolume), value = clamp(event.target.value,0,1);
        root.querySelectorAll(`[data-local-layer-volume-value="${slot}"]`).forEach(el=>{el.textContent=`${Math.round(value*100)}%`;});
        event.target.style.setProperty("--progress",`${value*100}%`);
        clearTimeout(this.layerVolumeTimers.get(`local-${slot}`));
        this.layerVolumeTimers.set(`local-${slot}`,setTimeout(()=>void this.perform(()=>this.audioSync.setLocalVolume(slot,value)),50));
      }
    });
    root.addEventListener("error", event => { if (event.target.tagName === "IMG") event.target.hidden = true; }, true);
  }
  refresh() {
    if (this.uploadControllers.size) {
      const tracks = this.library.playlists.flatMap(p => p.getFlag(ID, "tracks") ?? []);
      for (const [id, controller] of this.uploadControllers) {
        const track = tracks.find(t => t.id === id);
        if (!track || ["cancelled", "cancelling"].includes(track.status)) controller.abort();
      }
    }
    if (this.trackDrag.active) return;
    if (this.interacting) { this.schedule(); return; }
    const sound = this.library.current;
    if (this.preview.active && (!game.user.isGM || !game.playlists.get(this.preview.active.playlistId)?.sounds.has(this.preview.active.trackId))) void this.preview.stop().catch(report);
    const sharedActive = this.library.active;
    if (this.playlistMenu && (!game.user.isGM || !this.library.playlists.some(p => p.id === this.menuPlaylistId))) this.closePlaylistMenu();
    if (!this.currentPlaylist || !game.user.isGM) this.closeMiniPlaylist(false);
    if(!game.user.isGM) this.closeFull();
    const entries = this.library.layerEntries;
    this.sizeMini();
    const signature = JSON.stringify([game.user.isGM, game.settings.get(ID,"layerPlayback"), this.audioSync.status, sound?.id, sound?.playing, sound?.name, sound?.getFlag(ID,"cover"), sound?.parent.id, this.currentPlaylist?.id, this.miniPlaylistOpen, entries.map(({slot,sound:s})=>[slot,s.parent.id,s.id,s.playing,s.name,s.getFlag(ID,"cover")])]);
    if (signature !== this.lastSignature) { this.mini.innerHTML = miniView(this.library, this); this.lastSignature = signature; }
    this.mini.hidden = !game.user.isGM && !sharedActive;
    if (!game.user.isGM && !sharedActive) { this.closeFull(); this.closeVolume(); this.dialog?.close(); }
    if (this.volumePopup) {
      const key = JSON.stringify([game.user.isGM, entries.map(entry => entry.slot)]);
      if (key !== this.volumeViewKey) { this.volumePopup.innerHTML = volumeView(this.library); this.volumeViewKey = key; }
      this.positionVolume();
    }
    this.refreshMiniPlaylist();
    if (this.full) {
      const focused = document.activeElement;
      const search = focused?.matches("[data-search]");
      const selection = search ? focused.selectionStart : null;
      const scroll = [...this.full.querySelectorAll(".yapw-scroll")].map(el => el.scrollTop);
      this.full.innerHTML = fullView(this);
      this.full.querySelectorAll(".yapw-scroll").forEach((el,i) => { el.scrollTop = scroll[i] ?? 0; });
      if (search) { const input = this.full.querySelector("[data-search]"); input.focus(); input.setSelectionRange(selection,selection); }
    }
    this.updateMarquees(); this.updateTime();
  }
  updateTime() {
    for (const root of [this.mini,this.full,this.volumePopup].filter(Boolean)) {
      for (const scope of root.querySelectorAll("[data-playback-layer]")) {
        const sound = this.library.soundAt(Number(scope.dataset.playbackLayer));
        const duration = soundDuration(sound);
        const position = sound?.playing ? this.audioSync.position(sound) ?? sound.pausedTime ?? 0 : sound?.pausedTime ?? 0;
        const current = Number.isFinite(position) ? position : 0;
        for (const input of scope.querySelectorAll("[data-seek]")) {
          if (!(this.interacting && document.activeElement === input) && this.seekingInput !== input) input.value = clamp(current,0,duration || 1);
          input.max = Number.isFinite(duration) ? duration : 1;
          input.disabled = !game.user.isGM || !duration;
          input.style.setProperty("--progress", `${duration ? clamp(Number(input.value) / duration * 100,0,100) : 0}%`);
        }
        scope.querySelectorAll("[data-elapsed]").forEach(el => { if (!scope.contains(this.seekingInput)) el.textContent = time(current); });
        scope.querySelectorAll("[data-duration]").forEach(el => { el.textContent = time(duration); });
        scope.querySelectorAll("[data-seek]").forEach(el => { el.title = `${time(current)} / ${time(duration)}`; });
        scope.querySelectorAll("[data-playback-progress]").forEach(el=>{
          const value = clamp(current,0,duration || 1);
          el.style.setProperty("--progress",`${duration ? value/duration*100 : 0}%`);
          el.setAttribute("aria-valuemax",String(duration ?? 1));el.setAttribute("aria-valuenow",String(value));
          el.setAttribute("aria-valuetext",`${time(current)} / ${time(duration)}`);el.title=`${time(current)} / ${time(duration)}`;
        });
      }
      root.querySelectorAll("[data-local-layer-volume]").forEach(input=>{
        const slot = Number(input.dataset.localLayerVolume);
        if(document.activeElement !== input) input.value = localLayerVolume(slot);
        input.style.setProperty("--progress",`${Number(input.value)*100}%`);
        root.querySelectorAll(`[data-local-layer-volume-value="${slot}"]`).forEach(el=>{el.textContent=`${Math.round(Number(input.value)*100)}%`;});
      });
      root.querySelectorAll("[data-volume]").forEach(input => { if (document.activeElement !== input) input.value = game.settings.get("core","globalPlaylistVolume") ?? 1; input.style.setProperty("--progress",`${Number(input.value)*100}%`); });
      root.querySelectorAll("[data-volume-value]").forEach(el => { el.textContent = `${Math.round(Number(root.querySelector("[data-volume]")?.value ?? 1) * 100)}%`; });
      root.querySelectorAll("[data-volume-trigger] i").forEach(el => { el.className = `fa-solid fa-${game.settings.get("core","globalPlaylistVolume") === 0 || localLayerVolume(0) === 0 ? "volume-xmark" : "volume-low"}`; });
    }
  }
  get currentPlaylist() {
    return this.library.current?.parent ?? this.library.playlists.find(p => p.id === this.selected) ?? this.library.playlists[0];
  }
  get popupPlaylist() {
    return this.miniBrowseId ? this.library.playlists.find(p => p.id === this.miniBrowseId) : this.currentPlaylist;
  }
  refreshMiniPlaylist() {
    if(!game.user.isGM) {this.closeMiniPlaylist(false);return;}
    if (!this.miniPlaylistOpen || !this.currentPlaylist) return;
    if (this.miniBrowseId && !this.popupPlaylist) { this.miniBrowseId = null; this.miniBrowseAll = true; }
    if (!this.miniPlaylist) {
      this.miniPlaylist = document.createElement("section"); this.miniPlaylist.className = "yapw yapw-mini-playlist";
      this.bind(this.miniPlaylist);
      document.body.append(this.miniPlaylist);
    }
    const oldList = this.miniPlaylist.querySelector(".yapw-scroll");
    if (oldList && this.popupViewKey) this.miniScrollPositions.set(this.popupViewKey,oldList.scrollTop);
    const key = this.miniBrowseAll ? "all" : `playlist:${this.popupPlaylist.id}`;
    const changedView = this.popupViewKey !== key, markup = currentPlaylistView(this);
    this.miniPlaylist.setAttribute("aria-label",this.miniBrowseAll ? "Все плейлисты" : `Треки плейлиста: ${this.popupPlaylist.name}`);
    if (markup !== this.popupMarkup) { this.miniPlaylist.innerHTML = markup; this.popupMarkup = markup; }
    this.positionMiniPlaylist();
    const list = this.miniPlaylist.querySelector(".yapw-scroll");
    list.scrollTop = this.miniScrollPositions.get(key) ?? 0;
    if (changedView && !this.miniScrollPositions.has(key) && !this.miniBrowseAll) {
      const current = list.querySelector(".is-current");
      if (current) list.scrollTop = current.offsetTop - list.offsetTop;
    }
    this.popupViewKey = key;
  }
  closeMiniPlaylist(refresh = true) {
    this.miniPlaylistOpen = false; this.miniPlaylist?.remove(); this.miniPlaylist = null; this.popupViewKey = null; this.popupMarkup = null;
    this.miniBrowseAll = false; this.miniBrowseId = null; this.miniScrollPositions.clear();
    if (refresh) this.refresh();
  }
  positionMiniPlaylist() {
    if (!this.miniPlaylist) return;
    const r = this.mini.getBoundingClientRect(), below = innerHeight - r.bottom - 12, above = r.top - 12;
    const useAbove = below < 140 && above > below;
    const width = Math.min(r.width,innerWidth);
    this.miniPlaylist.style.width = `${width}px`;
    this.miniPlaylist.style.maxHeight = `${Math.max(90, Math.min(260, useAbove ? above : below))}px`;
    this.miniPlaylist.style.left = `${clamp(r.left,0,Math.max(0,innerWidth-width))}px`;
    const height = this.miniPlaylist.getBoundingClientRect().height;
    this.miniPlaylist.style.top = `${useAbove ? Math.max(8,r.top-height-4) : r.bottom+4}px`;
  }
  openVolume(trigger) {
    clearTimeout(this.volumeCloseTimer);
    if (!this.volumePopup) {
      this.volumePopup = document.createElement("section"); this.volumePopup.className = "yapw yapw-volume-popup";
      this.volumePopup.setAttribute("role","dialog"); this.volumePopup.setAttribute("aria-label","Громкость");
      this.volumePopup.innerHTML = volumeView(this.library); this.volumeViewKey = JSON.stringify([game.user.isGM,this.library.layerEntries.map(entry => entry.slot)]); this.bind(this.volumePopup);
      this.volumePopup.addEventListener("pointerenter", () => clearTimeout(this.volumeCloseTimer));
      this.volumePopup.addEventListener("pointerleave", () => this.queueCloseVolume());
      this.volumePopup.addEventListener("focusout", () => this.queueCloseVolume());
      this.volumePopup.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); this.closeVolume(); this.suppressVolumeFocus = true; trigger?.focus(); this.suppressVolumeFocus = false; } });
      document.body.append(this.volumePopup);
    }
    this.positionVolume();
  }
  positionVolume() {
    const trigger = this.mini.querySelector("[data-volume-trigger]");
    if (!this.volumePopup || !trigger) return;
    const r = trigger.getBoundingClientRect(), popup = this.volumePopup.getBoundingClientRect();
    this.volumePopup.style.left = `${clamp(r.right-popup.width,8,Math.max(8,innerWidth-popup.width-8))}px`;
    this.volumePopup.style.top = `${Math.max(8,r.top > popup.height+8 ? r.top-popup.height-4 : Math.min(innerHeight-popup.height-8,r.bottom+4))}px`;
  }
  queueCloseVolume() {
    clearTimeout(this.volumeCloseTimer);
    this.volumeCloseTimer = setTimeout(() => {
      if (!this.volumePinned && !this.volumePopup?.contains(document.activeElement) && !document.activeElement?.matches("[data-volume-trigger]")) this.closeVolume();
    },150);
  }
  closeVolume() {
    clearTimeout(this.volumeCloseTimer); this.volumePopup?.remove(); this.volumePopup = null; this.volumePinned = false;
  }
  openPlaylistMenu(playlistId, x, y) {
    if (!game.user.isGM || !this.library.playlists.some(p => p.id === playlistId)) return;
    this.closePlaylistMenu(); this.closeVolume();
    const menu = document.createElement("div"); menu.className = "yapw yapw-playlist-menu";
    menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Действия с плейлистом"); menu.dataset.playlist = playlistId;
    menu.innerHTML = `<button type="button" role="menuitem" class="yapw-danger" data-action="remove-playlist">${icon("trash")} Удалить</button>`;
    this.bind(menu); this.playlistMenu = menu; this.menuPlaylistId = playlistId; document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${clamp(x, 8, Math.max(8, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${clamp(y, 8, Math.max(8, innerHeight - rect.height - 8))}px`;
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); this.closePlaylistMenu(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); menu.querySelector("button").focus(); }
    });
    menu.querySelector("button").focus();
  }
  closePlaylistMenu(restoreFocus = false) {
    const id = this.menuPlaylistId;
    this.playlistMenu?.remove(); this.playlistMenu = null; this.menuPlaylistId = null;
    if (restoreFocus) [...(this.full?.querySelectorAll(".yapw-playlist-card") ?? [])].find(card => card.dataset.playlist === id)?.focus();
  }
  async confirmRemovePlaylists(ids, all = false) {
    const targets = this.library.playlists.filter(p => ids.includes(p.id));
    if (!targets.length) return;
    const title = all ? "Удалить все плейлисты?" : "Удалить плейлист?";
    const message = all ? `Будут удалены все плейлисты этого плеера (${targets.length}) вместе с записями треков, включая плейлисты, скрытые поиском.` : `Плейлист «${e(targets[0].name)}» и его записи треков будут удалены из библиотеки.`;
    const dialog = await this.form(title, `<p>${message}</p><p class="yapw-help">Скачанные и загруженные файлы сохранятся на диске. Для восстановления списка понадобится резервная копия.</p>`, async () => {
      await this.library.removePlaylists(targets.map(p => p.id));
      if (!game.playlists.has(this.selected)) this.selected = null;
      this.refresh();
    }, all ? "Удалить все плейлисты" : "Удалить");
    const submit = dialog.querySelector('[type="submit"]'); submit.classList.remove("yapw-primary"); submit.classList.add("yapw-danger");
    dialog.querySelector("footer [data-cancel]").focus();
    return dialog;
  }
  openFull() {
    if (!game.user.isGM) return;
    if (!this.full) {
      this.previousFocus = document.activeElement;
      this.full = document.createElement("section"); this.full.id = "yapw-full"; this.full.className = "yapw";
      this.full.tabIndex = -1; this.full.setAttribute("role", "dialog"); this.full.setAttribute("aria-label", "Библиотека музыки");
      this.bind(this.full);
      this.full.addEventListener("scroll", () => this.closePlaylistMenu(), true);
      this.full.addEventListener("pointerdown", event => this.dragLibrary(event));
      this.full.addEventListener("keydown", event => {
        if (event.key === "Escape" && !this.dialog?.open) { event.preventDefault(); event.stopPropagation(); this.closeFull(); }
      });
      document.body.append(this.full);
      const layout = game.settings.get(ID, "libraryLayout") ?? {};
      this.full.style.width = `${clamp(layout.width ?? 640, Math.min(420, innerWidth - 16), innerWidth - 16)}px`;
      this.full.style.height = `${clamp(layout.height ?? 420, Math.min(300, innerHeight - 16), innerHeight - 16)}px`;
      this.fullDocked = true; this.dockLibrary();
      this.libraryResizeObserver = new ResizeObserver(() => { this.fitLibrary(); this.saveLibraryLayout(); });
      this.libraryResizeObserver.observe(this.full);
    }
    this.refresh(); this.full?.focus();
  }
  dockLibrary() {
    if (!this.full) return;
    const margin = 8, gap = 8;
    const mini = this.mini.getBoundingClientRect(), full = this.full.getBoundingClientRect();
    let width = full.width;
    const roomForBoth = innerWidth - mini.width - gap - margin * 2;
    if (roomForBoth >= 420) {
      width = Math.min(width, roomForBoth);
      this.full.style.width = `${width}px`;
      if (mini.right + gap + width > innerWidth - margin) {
        this.mini.style.left = `${Math.max(margin, innerWidth - width - mini.width - gap - margin)}px`;
        this.saveLayout();
      }
    }
    const anchor = this.mini.getBoundingClientRect();
    this.full.style.left = `${clamp(anchor.right + gap, margin, Math.max(margin, innerWidth - width - margin))}px`;
    const top = roomForBoth >= 420 ? anchor.top : anchor.bottom + gap;
    this.full.style.top = `${clamp(top, margin, Math.max(margin, innerHeight - full.height - margin))}px`;
  }
  fitLibrary() {
    if (!this.full) return;
    const r = this.full.getBoundingClientRect();
    this.full.style.left = `${clamp(r.left, 8, Math.max(8, innerWidth - r.width - 8))}px`;
    this.full.style.top = `${clamp(r.top, 8, Math.max(8, innerHeight - r.height - 8))}px`;
  }
  saveLibraryLayout(immediate = false) {
    if (!this.full) return;
    clearTimeout(this.libraryLayoutTimer);
    const r = this.full.getBoundingClientRect();
    const save = () => void game.settings.set(ID, "libraryLayout", { width: r.width, height: r.height });
    if (immediate) save(); else this.libraryLayoutTimer = setTimeout(save, 300);
  }
  dragLibrary(event) {
    if (!event.target.closest("[data-library-drag]") || event.target.closest("button, input") || event.button !== 0) return;
    event.preventDefault(); this.fullDocked = false;
    const r = this.full.getBoundingClientRect(), x = event.clientX - r.left, y = event.clientY - r.top;
    const move = ev => {
      if (!this.full) return;
      this.full.style.left = `${ev.clientX - x}px`; this.full.style.top = `${ev.clientY - y}px`; this.fitLibrary();
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true });
  }
  closeFull() {
    this.closePlaylistMenu();
    if (!this.full) return;
    this.saveLibraryLayout(true); this.libraryResizeObserver?.disconnect(); this.fullDocked = false;
    this.full.remove(); this.full = null; this.previousFocus?.focus?.();
  }
  async form(title, body, save, label = "Сохранить") {
    this.dialog?.close();
    const dialog = document.createElement("dialog"); dialog.className = "yapw yapw-dialog";
    dialog.innerHTML = `<form><header><h2>${e(title)}</h2><button type="button" data-cancel aria-label="Закрыть">${icon("xmark")}</button></header><div class="yapw-form-body">${body}<p class="yapw-form-error" role="alert" hidden></p></div><footer><button type="button" data-cancel>Отмена</button><button type="submit" class="yapw-primary">${e(label)}</button></footer></form>`;
    document.body.append(dialog); this.dialog = dialog;
    dialog.querySelectorAll("[data-cancel]").forEach(el => el.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("close", () => { if (dialog.dataset.picking === "true") return; dialog.remove(); if (this.dialog === dialog) this.dialog = null; });
    dialog.querySelector("form").addEventListener("submit", async event => {
      event.preventDefault(); const button = dialog.querySelector('[type="submit"]'); button.disabled = true;
      try { await save(new FormData(event.currentTarget),dialog); dialog.close(); this.schedule(); }
      catch (error) { const el = dialog.querySelector(".yapw-form-error"); el.textContent = error.message; el.hidden = false; button.disabled = false; }
    });
    dialog.showModal(); return dialog;
  }
  async cookiesDialog() {
    const status = await this.downloads.cookiesRequest();
    return this.form("Cookies YouTube", `<p class="yapw-help">Для видео, требующих входа или подтверждённого возраста, экспортируйте cookies своего аккаунта YouTube в формате Netscape cookies.txt.</p><label>Файл cookies.txt<input type="file" name="cookies" accept=".txt,text/plain" required></label><p class="yapw-help">Будут сохранены только cookies домена youtube.com. Они передаются помощнику и хранятся вне общедоступного хранилища Foundry; в мир и резервные копии библиотеки файл не попадает. Cookies дают доступ к аккаунту: не передавайте их другим людям.</p><p class="yapw-help">Можно также вручную положить файл на компьютере помощника по пути:<br><code class="yapw-cookie-path">${e(status.file)}</code><br>Перезапуск для замены cookies не требуется. После сохранения нажмите «Повторить все неудачные» или повтор нужного трека.</p><p class="yapw-help"><a href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies" target="_blank" rel="noopener noreferrer">Инструкция yt-dlp по экспорту cookies YouTube</a></p>`, async data => {
      await this.downloads.uploadCookies(data.get("cookies"));
      ui.notifications.info("Cookies YouTube сохранены в помощнике. Повторите неудачные загрузки.");
    }, "Сохранить cookies");
  }
  async settings() {
    const layout = game.settings.get(ID,"layout"), helper = game.settings.get(ID,"helper");
    const transparency = game.settings.get(ID,"miniTransparency");
    const visibility = `<hr><h3>Видимость мини-плеера</h3><label class="yapw-toggle-setting"><input name="fadeMini" type="checkbox" ${game.settings.get(ID,"fadeMini") === true ? "checked" : ""}>Затухание без наведения</label><label><span>Прозрачность без наведения <output data-transparency-value>${Number.isFinite(transparency) ? clamp(transparency,0,100) : 80}%</output></span><input name="miniTransparency" aria-label="Прозрачность мини-плеера без наведения" type="range" min="0" max="100" step="1" value="${Number.isFinite(transparency) ? clamp(transparency,0,100) : 80}"></label><p class="yapw-help">Ваша личная настройка, сохраняется для вашего пользователя. Через 1,5 секунды без наведения мини-плеер становится прозрачным, при наведении снова виден полностью. 0% — полностью виден, 100% — полностью прозрачен.</p>`;
    const help = game.user.isGM ? "Перетаскивайте плеер за обложку или название; двойной щелчок открывает библиотеку справа. Нижняя стрелка раскрывает текущий плейлист. Размеры окон сохраняются отдельно у каждого участника." : "Перетаскивайте плеер за обложку или название, изменяйте размер за правый нижний угол. Динамик на первом слое открывает личную громкость всех слоёв и всей музыки. Изменения громкости слышны только вам.";
    const dialog = await this.form("Настройки плеера", `<label>Ширина виджета, пиксели<input name="width" type="number" min="180" max="800" value="${Math.round(this.mini.getBoundingClientRect().width || layout.width || 460)}" required></label><label>Высота виджета, пиксели<input name="height" type="number" min="48" max="140" value="${Math.round((this.mini.getBoundingClientRect().height - this.miniExtraHeight) || 78)}" required></label><label>Масштаб текста и кнопок<select name="scale">${[0.8,1,1.2].map(n => `<option value="${n}" ${(layout.scale ?? 1) === n ? "selected" : ""}>${Math.round(n*100)}%</option>`).join("")}</select></label><p class="yapw-help">${help}</p>${visibility}${game.user.isGM ? `<hr><h3>Загрузки YouTube</h3><label>Адрес помощника<input name="url" type="url" value="${e(helper.url)}" placeholder="http://127.0.0.1:32123" required></label><label>Ключ подключения<input name="token" type="password" value="${e(helper.token)}" autocomplete="off"></label><p class="yapw-help">Запустите <strong>helper/Start-Helper.cmd</strong> в папке модуля на компьютере сервера Foundry, затем скопируйте ключ из его окна. Ключ сохраняется только в вашем браузере. Помощником пользуется активный ГМ. Для адреса Foundry, отличающегося от localhost:30000, задайте YAPW_ORIGINS при запуске.</p><button type="button" data-check>Проверить подключение</button><p data-check-result class="yapw-help"></p>` : ""}`, async data => {
      const next = { ...game.settings.get(ID,"layout"), version: 3, width: clamp(data.get("width"),180,800), height: clamp(data.get("height"),48,140), scale: clamp(data.get("scale"),0.8,1.2) };
      await game.settings.set(ID,"layout",next);
      this.mini.style.width = `${next.width}px`; this.mini.style.height = `${next.height + this.miniExtraHeight}px`; this.mini.style.setProperty("--yapw-scale",next.scale); this.keepOnScreen();
      await game.settings.set(ID,"fadeMini",data.has("fadeMini"));
      await game.settings.set(ID,"miniTransparency",clamp(data.get("miniTransparency"),0,100));
      this.updateMiniAppearance();
      if (game.user.isGM) {
        await game.settings.set(ID,"helper",{url:String(data.get("url")).trim().replace(/\/$/,""), token:String(data.get("token")).trim()}); void this.downloads.tick();
      }
    });
    const transparencyInput = dialog.querySelector('[name="miniTransparency"]');
    transparencyInput?.style.setProperty("--progress",`${transparencyInput.value}%`);
    transparencyInput?.addEventListener("input",event=>{
      dialog.querySelector("[data-transparency-value]").textContent=`${event.target.value}%`;
      event.target.style.setProperty("--progress",`${event.target.value}%`);
    });
    dialog.querySelector("[data-check]")?.addEventListener("click", async event => {
      event.target.disabled = true;
      const output = dialog.querySelector("[data-check-result]");
      try { await game.settings.set(ID,"helper", { url: dialog.querySelector('[name="url"]').value.trim().replace(/\/$/,""), token: dialog.querySelector('[name="token"]').value.trim() }); await this.downloads.check(); output.textContent = "Соединение установлено. Можно добавлять музыку."; }
      catch (error) { output.textContent = error.message; }
      finally { event.target.disabled = false; }
    });
  }
  async addDialog(playlistId) {
    const dialog = await this.form("Добавить музыку", `<p class="yapw-help">Назначение: <strong>${e(game.playlists.get(playlistId)?.name)}</strong></p><label>Название (необязательно)<input name="name" maxlength="180" placeholder="Название из файла или YouTube"></label><div class="yapw-source-fields" data-youtube-fields><label>Видео или плейлист YouTube<input name="youtube" placeholder="https://www.youtube.com/watch?v=…"></label></div><p class="yapw-help">После ссылки появится следующее поле. Можно вставить несколько ссылок сразу, разделив их пробелами или переносами строк.</p><div class="yapw-form-divider">или аудиофайлы</div><label>Выбрать несколько файлов на компьютере<input type="file" name="files" multiple accept="audio/*,.mp3,.ogg,.wav,.flac,.m4a,.aac,.webm,.opus"></label><label>Файл в хранилище Foundry<div class="yapw-input-row"><input name="path" placeholder="music/track.ogg"><button type="button" data-browse title="Обзор файлов">${icon("folder-open")}</button></div></label><p class="yapw-help">Ссылка на плейлист добавит все его треки. Для одной композиции используйте ссылку без параметра list. Файлы из обычных плейлистов приложения доступны через «Импорт из Foundry» в библиотеке.</p>`, async data => {
      const youtube = data.getAll("youtube").map(value => String(value).trim()).filter(Boolean), path = String(data.get("path") || "").trim(), name = String(data.get("name") || "").trim();
      const files = data.getAll("files").filter(file => file.size);
      if (!youtube.length && !path && !files.length) throw new Error("Добавьте ссылку или выберите файл.");
      for (const source of youtube) youtubeSource(source);
      if (path) audioPath(path);
      if (youtube.length) await this.library.addYoutubeBatch(playlistId,youtube,name);
      if (path) { await this.library.addFile(playlistId,path,name,await readDuration(path)); }
      // Uploads continue outside the dialog and appear immediately in the download queue.
      const uploads = files.map(file => ({ id:foundry.utils.randomID(), file }));
      if (uploads.length) {
        await this.library.edit(playlistId, tracks => tracks.push(...uploads.map(({id,file}) => ({ id, name: name || file.name.replace(/\.[^.]+$/,""), kind:"track", type:"upload", status:"queued", duration:null, path:"", cover:"", progress:0 }))));
        for (const {id,file} of uploads) { this.uploadFiles.set(id,file); void this.perform(() => this.upload(playlistId,id)); }
      }
      void this.downloads.tick();
    }, "Добавить");
    const fields = dialog.querySelector("[data-youtube-fields]");
    const appendField = () => {
      const label = document.createElement("label"); label.textContent = "Ещё ссылка YouTube";
      const input = document.createElement("input"); input.name = "youtube"; input.placeholder = "https://www.youtube.com/watch?v=…";
      label.append(input); fields.append(label); return input;
    };
    const ensureField = () => {
      const last = fields.querySelector("label:last-child input");
      try { youtubeSource(last.value); appendField(); } catch { /* Keep one empty field after a valid link. */ }
    };
    fields.addEventListener("input", ensureField);
    fields.addEventListener("paste", event => {
      if (!event.target.matches('[name="youtube"]')) return;
      const sources = event.clipboardData?.getData("text").trim().split(/\s+/) ?? [];
      if (sources.length < 2) return;
      event.preventDefault();
      event.target.setRangeText(sources[0], event.target.selectionStart, event.target.selectionEnd, "end");
      for (const source of sources.slice(1)) appendField().value = source;
      ensureField();
    });
    dialog.querySelector("[data-browse]").addEventListener("click", () => {
      dialog.dataset.picking = "true"; dialog.close();
      const picker = new foundry.applications.apps.FilePicker.implementation({ type:"audio", callback:path => { dialog.querySelector('[name="path"]').value = path; } });
      picker.addEventListener("close", () => { dialog.dataset.picking = "false"; if (dialog.isConnected) dialog.showModal(); }, {once:true});
      void picker.render({force:true});
    });
  }
  async confirmImport(source) {
    const fromFoundry = source === "foundry";
    const dialog = await this.form(fromFoundry ? "Импортировать музыку из Foundry?" : "Импортировать из YouTube Player Widget?",
      fromFoundry
        ? '<p>Открыть импорт музыки из плейлистов Foundry?</p><p class="yapw-help">На следующем шаге можно выбрать плейлисты для добавления в библиотеку. Исходные плейлисты и аудиофайлы сохранятся.</p>'
        : '<p>Добавить плейлисты YouTube Player Widget в библиотеку?</p><p class="yapw-help">Новые треки будут поставлены в очередь скачивания вместе с превью. Уже импортированные ссылки повторно не добавятся.</p>',
      async () => {
        if (fromFoundry) return this.importFoundryDialog();
        const count = await this.library.importYoutube();
        ui.notifications.info(`Импортировано: ${count.playlists} плейлистов, ${count.tracks} новых треков. Загрузки добавлены в очередь.`);
        void this.downloads.tick();
      }, fromFoundry ? "Продолжить" : "Импортировать");
    dialog.querySelector("footer [data-cancel]").focus();
    return dialog;
  }
  async importFoundryDialog() {
    const playlists = this.library.foundryPlaylists;
    if (!playlists.length) { ui.notifications.info("В Foundry нет других плейлистов с аудиофайлами для импорта."); return; }
    return this.form("Импорт музыки из Foundry", `<p class="yapw-help">Выберите плейлисты приложения. Музыка появится в библиотеке сразу, исходные плейлисты сохранятся. Повторный импорт добавляет только новые треки.</p>${playlists.map(p => `<label class="yapw-import-choice"><input type="checkbox" name="playlists" value="${e(p.id)}" checked><span>${e(p.name)} · ${p.sounds.contents.length} треков</span></label>`).join("")}`, async data => {
      const ids = data.getAll("playlists");
      if (!ids.length) throw new Error("Выберите хотя бы один плейлист.");
      const count = await this.library.importFoundry(ids);
      ui.notifications.info(`Импортировано: ${count.playlists} плейлистов, ${count.tracks} новых треков.`);
    }, "Импортировать");
  }
  async upload(playlistId,id) {
    const file = this.uploadFiles.get(id);
    if (!file) throw new Error("После перезагрузки страницы выберите исходный файл повторно через «Добавить музыку».");
    this.uploadControllers.get(id)?.abort();
    const controller = new AbortController(); this.uploadControllers.set(id, controller);
    this.uploadChain = (this.uploadChain ?? Promise.resolve()).catch(() => {}).then(async () => {
      try {
        if (controller.signal.aborted) return;
        let allowed = false;
        const exists = await this.library.updateTrack(id, t => { if (!["cancelled", "cancelling"].includes(t.status) && !controller.signal.aborted) { allowed = true; Object.assign(t,{status:"uploading",error:"",queueDismissed:false}); } });
        if (!exists) { this.uploadFiles.delete(id); return; }
        if (!allowed || controller.signal.aborted) return;
        const path = await uploadFile(file, controller.signal), duration = await readDuration(path, controller.signal);
        await this.library.updateTrack(id, t => { if (!controller.signal.aborted && !["cancelled", "cancelling"].includes(t.status)) Object.assign(t,{status:"ready",path,duration,progress:100}); });
        if (controller.signal.aborted) return;
        this.uploadFiles.delete(id);
      } catch (error) {
        if (!controller.signal.aborted) await this.library.updateTrack(id, t => { if (!["cancelled", "cancelling"].includes(t.status)) Object.assign(t,{status:"error",error:error.message}); });
      } finally { if (this.uploadControllers.get(id) === controller) this.uploadControllers.delete(id); this.schedule(); }
    });
    return this.uploadChain;
  }
  async cancelDownloads(playlistId = null, trackId = null) {
    const targets = await this.library.cancelDownloads(playlistId, trackId);
    for (const t of targets) this.uploadControllers.get(t.id)?.abort();
    this.schedule();
    await this.downloads.flushCancellations();
  }
  async action(action, element) {
    const row = element.closest("[data-track]"), pid = row?.dataset.playlist || element.closest("[data-playlist]")?.dataset.playlist || this.selected, tid = row?.dataset.track;
    const slot = Number(element.closest("[data-playback-layer]")?.dataset.playbackLayer ?? 0);
    this.closePlaylistMenu();
    if (action === "sync-audio") { if(this.audioSync.manualBusy)return;await this.audioSync.resync(); ui.notifications.info("Звук синхронизирован на этом компьютере."); return; }
    if(!game.user.isGM && ["current-playlist","mini-all-playlists","mini-select-playlist","select","deselect"].includes(action)) return;
    if (action === "library") { this.openFull(); return; }
    if (action === "close") { this.closeFull(); return; }
    if (action === "settings") return this.settings();
    if (action === "volume") {
      if (this.volumePopup && this.volumePinned) this.closeVolume();
      else { this.volumePinned = true; this.openVolume(element); }
      return;
    }
    if (action === "current-playlist") {
      if (this.miniPlaylistOpen) this.closeMiniPlaylist();
      else if (this.currentPlaylist) { this.miniPlaylistOpen = true; this.refresh(); }
      return;
    }
    if (action === "mini-all-playlists") {
      const previousId = this.popupPlaylist?.id;
      this.miniBrowseAll = true; this.miniBrowseId = null; this.refresh();
      const items = [...(this.miniPlaylist?.querySelectorAll('[data-action="mini-select-playlist"]') ?? [])];
      (items.find(item => item.dataset.playlist === previousId) ?? items[0])?.focus();
      return;
    }
    if (action === "mini-select-playlist") {
      if (!this.library.playlists.some(p => p.id === pid)) return;
      this.miniBrowseId = pid; this.miniBrowseAll = false; this.refresh();
      this.miniPlaylist?.querySelector('[data-action="mini-all-playlists"]')?.focus();
      return;
    }
    if (action === "select") { this.selected = this.selected === pid ? null : pid; this.refresh(); return; }
    if (action === "deselect") { this.selected = null; this.refresh(); return; }
    if (action.startsWith("tab-")) { this.tab = action.slice(4); this.refresh(); return; }
    if (!game.user.isGM) throw new Error("Управление доступно ведущему.");
    if (action === "cookies-upload") return this.cookiesDialog();
    if (action === "cookies-remove") { await this.downloads.cookiesRequest({ clear: true }); ui.notifications.info("Файл cookies удалён из помощника. Новые загрузки будут выполняться без него."); return; }
    if (action === "autoplay" || action === "repeat") { await this.library.togglePlaybackOption(slot,action); this.schedule(); return; }
    if (action === "import-foundry") return this.confirmImport("foundry");
    if (action === "create" || action === "rename") return this.form(action === "create" ? "Новый плейлист" : "Название плейлиста", `<label>Название<input name="name" required maxlength="180" value="${action === "rename" ? e(game.playlists.get(pid)?.name) : ""}" autofocus></label>`, async data => {
      const name = String(data.get("name")).trim(); if (!name) throw new Error("Введите название.");
      if (action === "create") { const p = await this.library.create(name); this.selected = p.id; this.tab = "library"; } else await game.playlists.get(pid).update({name});
    });
    if (action === "add") return this.addDialog(pid);
    if (action === "preview") { await this.preview.toggle(game.playlists.get(pid),tid); this.schedule(); return; }
    if (action === "add-layer") { await this.preview.stop(); return this.library.addLayer(pid,tid); }
    if (action === "stop-track") {
      if (this.preview.matches(pid,tid)) await this.preview.stop();
      const sound = game.playlists.get(pid)?.sounds.get(tid);
      if (sound?.playing || sound?.pausedTime != null) return this.library.stopTrack(pid,tid);
      return;
    }
    if (action === "play") { await this.preview.stop(); return this.library.play(pid,tid); }
    if (action === "play-playlist" || action === "shuffle-playlist") { await this.preview.stop(); return this.library.playPlaylist(pid,action === "shuffle-playlist"); }
    if (action === "sort-tracks") return this.library.sortTracks(pid,element.dataset.order);
    if (action === "toggle") { if (!this.library.soundAt(slot)) return this.openFull(); if (!this.library.soundAt(slot).playing) await this.preview.stop(); return this.library.toggle(slot); }
    if (action === "stop") { await this.preview.stop(); return this.library.stopLayer(slot); }
    if (action === "next" || action === "previous") { await this.preview.stop(); return this.library.step(action === "next" ? 1 : -1,slot); }
    if (action === "retry") {
      const t = this.library.tracks(game.playlists.get(pid)).find(t=>t.id===tid);
      if (t?.type === "upload") { if (!this.uploadFiles.has(tid)) throw new Error("Выберите исходный файл повторно через «Добавить музыку»."); await this.library.updateTrack(tid, t => Object.assign(t, { status: "queued", error: "", cancelRequested: false, queueDismissed: false })); return this.upload(pid,tid); }
      await this.library.retry(pid,tid); void this.downloads.tick(); return;
    }
    if (action === "cancel-download") return this.cancelDownloads(pid,tid);
    if (action === "cancel-playlist-downloads") return this.cancelDownloads(pid);
    if (action === "cancel-all-downloads") return this.cancelDownloads();
    if (action === "clear-download-queue") { await this.library.clearDownloadQueue(); this.schedule(); return; }
    if (action === "retry-all") {
      let missing = 0;
      for (const p of this.library.playlists) {
        await this.library.retry(p.id);
        for (const t of this.library.tracks(p).filter(t=>t.type==="upload" && t.status==="error" && !t.queueDismissed)) { if (this.uploadFiles.has(t.id)) void this.upload(p.id,t.id); else missing++; }
      }
      if (missing) ui.notifications.warn(`Для ${missing} файлов выберите оригинал заново через «Добавить музыку».`);
      void this.downloads.tick(); return;
    }
    if (action === "remove-track") return this.library.removeTrack(pid,tid);
    if (action === "remove-playlist") return this.confirmRemovePlaylists([pid]);
    if (action === "remove-all-playlists") return this.confirmRemovePlaylists(this.library.playlists.map(p => p.id), true);
    if (action === "edit-track") {
      const track = this.library.tracks(game.playlists.get(pid)).find(t=>t.id===tid);
      return this.form("Настройки трека", `<label>Название<input name="name" value="${e(track.name)}" maxlength="180" required></label><label>Плейлист<select name="playlist">${this.library.playlists.map(p=>`<option value="${p.id}" ${p.id===pid?"selected":""}>${e(p.name)}</option>`).join("")}</select></label>${track.type === "youtube" ? `<label>Ссылка YouTube<input name="source" value="${e(track.source)}" required></label><p class="yapw-help">Изменение ссылки снова поставит трек на загрузку.</p>` : ""}`, async data => {
        const name = String(data.get("name")).trim(), dest = String(data.get("playlist")); if (!name) throw new Error("Введите название трека.");
        let updated = {...track,name,customName:true};
        if (track.type === "youtube" && String(data.get("source")).trim() !== track.source) {
          const {youtubeTrack} = await import("./model.js"); updated = {...youtubeTrack(data.get("source"),name,foundry.utils.randomID()),customName:true};
        }
        await this.library.edit(pid, tracks=>{ tracks[tracks.findIndex(t=>t.id===tid)] = updated; });
        if (dest !== pid) await this.library.transferTrack(pid,updated.id,dest);
        void this.downloads.tick();
      });
    }
    if (action === "import") return this.confirmImport("youtube");
    if (action === "export") {
      const data = { module:ID,version:1,playlists:this.library.playlists.map(p=>({name:p.name,tracks:this.library.tracks(p)})) };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));
      const a = document.createElement("a"); a.href = url; a.download = "yet-another-player-widget-library.json"; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); return;
    }
    if (action === "restore") return this.form("Восстановить библиотеку", '<label>Резервная копия JSON<input type="file" name="backup" accept=".json" required></label><p class="yapw-help">Плейлисты добавятся к существующим. Аудиофайлы и превью должны находиться по прежним путям.</p>', async data => {
      const file = data.get("backup"); if (file.size > 20*1024*1024) throw new Error("Слишком большой файл.");
      const backup = JSON.parse(await file.text()); if (backup.module !== ID || !Array.isArray(backup.playlists)) throw new Error("Это не резервная копия плеера.");
      for (const entry of backup.playlists) {
        const p = await this.library.create(entry.name);
        await this.library.edit(p.id, tracks => {
          for (const original of entry.tracks ?? []) {
            const t = clone(original); t.id = foundry.utils.randomID(); t.jobId = null;
            if (t.status === "ready") t.path = audioPath(t.path);
            else if (["cancelled", "cancelling"].includes(t.status)) { t.status = "cancelled"; t.cancelRequested = false; }
            else if (t.type === "youtube") { t.status = "queued"; t.progress = 0; }
            else { t.status = "error"; t.error = "Выберите исходный файл повторно."; }
            tracks.push(t);
          }
        });
      }
      void this.downloads.tick();
    }, "Восстановить");
  }
}

Hooks.once("init", () => {
  installPlaybackSync(() => player?.audioSync);
  game.settings.register(ID,"layout",{scope:"client",config:false,type:Object,default:{version:3,left:85,top:110,width:460,height:78,scale:1}});
  game.settings.register(ID,"libraryLayout",{scope:"client",config:false,type:Object,default:{width:640,height:420}});
  game.settings.register(ID,"helper",{scope:"client",config:false,type:Object,default:{url:"http://127.0.0.1:32123",token:""}});
  game.settings.register(ID,"selection",{scope:"world",config:false,type:Object,default:{},onChange:()=>player?.schedule()});
  game.settings.register(ID,"layerVolumes",{scope:"world",config:false,type:Object,default:{},onChange:()=>player?.schedule()});
  game.settings.register(ID,"layerPlayback",{scope:"world",config:false,type:Object,default:{},onChange:()=>player?.schedule()});
  let previousLocalVolumes = {};
  try {
    const previous = JSON.parse(game.settings.storage?.get("client")?.getItem(`${ID}.localLayerVolumes`) ?? "null");
    if (previous && typeof previous === "object" && !Array.isArray(previous)) previousLocalVolumes = previous;
  } catch { /* Invalid legacy preferences fall back to the normal initial levels. */ }
  game.settings.register(ID,"localLayerVolumes",{scope:"user",config:false,type:Object,default:previousLocalVolumes,onChange:()=>{player?.audioSync.applyVolumes();player?.updateTime();}});
  // Keep the old shared values as initial preferences until each user saves their own.
  const legacyVisibility = key => game.settings.storage?.get("world")?.getSetting(`${ID}.${key}`)?.value;
  const legacyFade = legacyVisibility("fadeMini"), legacyTransparency = legacyVisibility("miniTransparency");
  game.settings.register(ID,"fadeMini",{name:"Затухание мини-плеера без наведения",hint:"Личная настройка вашего пользователя. Без наведения мини-плеер становится прозрачным, при наведении снова виден полностью.",scope:"user",config:true,type:Boolean,default:legacyFade === true,onChange:()=>player?.updateMiniAppearance()});
  game.settings.register(ID,"miniTransparency",{name:"Прозрачность мини-плеера без наведения (%)",hint:"Личная настройка. 0% — полностью виден, 100% — полностью прозрачен. Применяется при включённом затухании.",scope:"user",config:true,type:Number,range:{min:0,max:100,step:1},default:Number.isFinite(legacyTransparency) ? clamp(legacyTransparency,0,100) : 80,onChange:()=>player?.updateMiniAppearance()});
  game.keybindings.register(ID,"library",{name:"Открыть музыкальную библиотеку",editable:[{key:"KeyM",modifiers:["Control","Alt"]}],onDown:()=>{ player?.full ? player.closeFull() : player?.openFull(); return true; }});
});
Hooks.once("ready", async () => {
  player = new PlayerWidget();
  if (game.socket) player.audioSync.readiness.activate();
  game.modules.get(ID).api = { open:()=>player.openFull(), settings:()=>player.settings(), sync:()=>player.audioSync.resync(), widget:player, importYoutube:()=>player.library.importYoutube() };
  if (game.user.isGM && game.users.activeGM?.id === game.user.id) {
    await player.perform(async () => {
      for (const p of player.library.playlists) if (player.library.tracks(p).some(t=>t.type==="upload" && ["uploading","queued"].includes(t.status))) {
        await player.library.edit(p.id, tracks=>{ for (const t of tracks) if (t.type==="upload" && ["uploading","queued"].includes(t.status)) Object.assign(t,{status:"error",error:"Загрузка файла прервана. Выберите исходный файл повторно."}); });
      }
      await player.library.normalizePlayback(); await player.library.reconcile();
    });
  }
});
Hooks.on("preUpdatePlaylist",(playlist,changes)=>{for(const change of changes.sounds ?? []) stampPlayback(playlist.sounds.get(change._id),change);});
Hooks.on("preUpdatePlaylistSound",(sound,changes)=>stampPlayback(sound,changes));
Hooks.on("userConnected",user=> { player?.audioSync.readiness.userConnected(user); player?.audioSync.tick(); });
for (const hook of ["createPlaylist","updatePlaylist","deletePlaylist","createPlaylistSound","updatePlaylistSound","deletePlaylistSound","globalPlaylistVolumeChanged"]) Hooks.on(hook,()=> {
  player?.schedule();
  player?.audioSync.tick();
  if (player && game.user.isGM && game.users.activeGM?.id === game.user.id) {
    clearTimeout(player.playbackTimer);
    player.playbackTimer = setTimeout(() => void player.library.normalizePlayback().catch(report), 150);
  }
});
Hooks.on("renderPlaylistDirectory", (app,html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0]; if (!root || root.querySelector(".yapw-sidebar-button")) return;
  const button = document.createElement("button"); button.type="button"; button.className="yapw-sidebar-button"; button.innerHTML=`${icon("headphones")} Yet another player widget`;
  button.addEventListener("click",()=>player?.openFull()); (root.querySelector(".directory-header") ?? root).append(button);
});
