import { ID } from "./model.js";
import { PlaybackReadiness, READINESS_CHANNEL, READY_START_DELAY_MS } from "./readiness.js";

export const START_DELAY_MS = 600;
export function serverNow() { const now = game.time?.serverTime; return Number.isFinite(now) ? now : Date.now(); }
export function soundDuration(doc) {
  return [doc?.sound?.duration,doc?.getFlag(ID,"duration")].find(value=>Number.isFinite(value)&&value>0);
}
export function localLayerVolume(slot = 0) {
  const value = game.settings.get(ID,"localLayerVolumes")?.[slot];
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0,Math.min(1,value));
  const previous = game.user.isGM ? game.settings.get(ID,"layerVolumes")?.[slot] : undefined;
  return Number.isFinite(previous) ? Math.max(0,Math.min(1,previous)) : game.user.isGM ? 0.8 : 1;
}
export function stampPlayback(sound, changes, now = serverNow()) {
  if (!sound?.parent?.getFlag(ID,"managed") || changes.playing !== true) return;
  if (changes.flags?.[ID]?.clock) return;
  if (sound.playing && !("pausedTime" in changes) && !("path" in changes)) return;
  changes.flags = { ...changes.flags, [ID]: { ...changes.flags?.[ID], clock: {
    id: foundry.utils.randomID(), at: now + START_DELAY_MS, ...(game.socket ? { waiting:true } : {}),
    offset: Math.max(0, Number(changes.pausedTime ?? sound.pausedTime) || 0), path: changes.path ?? sound.path
  } } };
}
export function playbackTarget(clock, now, duration, repeat = false) {
  const elapsed = clock.offset + Math.max(0, (now - clock.at) / 1000);
  const finite = Number.isFinite(duration) && duration > 0;
  return { offset: finite ? (repeat ? elapsed % duration : Math.min(elapsed,duration)) : elapsed,
    delay: Math.max(0,(clock.at - now) / 1000), ended: finite && !repeat && elapsed >= duration };
}
function bounded(promise, ms, signal) {
  return new Promise((resolve,reject) => {
    const finish = (fn,value) => { clearTimeout(timer); signal?.removeEventListener("abort",abort); fn(value); };
    const abort = () => finish(reject,new Error("Отменена устаревшая синхронизация."));
    const timer = setTimeout(() => finish(reject,new Error("Не удалось загрузить звук за отведённое время. Нажмите синхронизацию для повтора.")),ms);
    signal?.addEventListener("abort",abort,{once:true});
    if (signal?.aborted) { abort(); return; }
    Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
  });
}

// Uses the document's normal Sound; the active GM handles managed track endings. Only local audio is repaired;
// players never change shared playback documents or any other module's sounds.
export class PlaybackSync {
  constructor(library, changed = () => {}, {now = serverNow, timeout = 60000, tolerance = 0.3} = {}) {
    Object.assign(this,{library,changed,now,timeout,tolerance}); this.states = new Map(); this.clocks = new Map(); this.clockRetryAt = new Map(); this.manualBusy = false;
    this.readiness = new PlaybackReadiness({ now, changed, publish:(doc,clock,ready) => library.write(async () => {
      if (game.users.activeGM?.id !== game.user.id || !ready()) return;
      await doc.setFlag(ID,"clock",{...clock,waiting:false,at:this.now()+READY_START_DELAY_MS});
    }) });
    game.socket?.on("userActivity",(userId,activity) => {
      const message = activity?.[ID];
      if (message?.userId === userId) this.readiness.receive(message);
    });
    // Accept acknowledgements from clients using the previous module channel too.
    game.socket?.on(READINESS_CHANNEL,message => this.readiness.receive(message));
  }
  key(doc) { return `${doc.parent.id}:${doc.id}`; }
  effectiveVolume(doc) {
    if (game.user.isGM && this.previewMuted) return 0;
    const slot = this.library.layerEntries?.find(entry=>entry.sound === doc)?.slot ?? 0;
    return localLayerVolume(slot);
  }
  applyVolumes() {
    for(const state of this.states.values()) if(this.live(state) && state.sound?.loaded) this.applyVolume(state);
  }
  applyVolume(state, fade = 0) {
    const volume = this.effectiveVolume(state.doc), audio = state.sound;
    audio.volume = volume;
    if(audio.playing && typeof audio.fade === "function") void Promise.resolve(audio.fade(volume,{duration:fade,from:fade ? 0 : volume})).catch(()=>{});
  }
  setPreviewMuted(muted) { this.previewMuted = muted; this.applyVolumes(); }
  end(state) {
    if (!this.live(state) || state.ended) return;
    state.ended = true;
    if (this.library.onSoundEnd) {
      if (game.user.isGM && game.users.activeGM?.id === game.user.id) void this.library.onSoundEnd(state.doc, state.clockId).catch(error => { state.error = error.message; this.changed(); });
    } else void state.doc._onEnd?.();
  }
  setLocalVolume(slot, value) {
    if(!Number.isInteger(slot) || slot < 0 || !Number.isFinite(value)) return Promise.reject(new Error("Некорректная громкость слоя."));
    const task = (this.volumeWrite ?? Promise.resolve()).catch(()=>{}).then(async()=>{
      await game.settings.set(ID,"localLayerVolumes",{...game.settings.get(ID,"localLayerVolumes"),[slot]:Math.max(0,Math.min(1,value))});
      this.applyVolumes();this.changed();
    });
    this.volumeWrite = task;return task;
  }
  clock(doc) {
    const clock = doc.getFlag(ID,"clock");
    return clock && Number.isFinite(clock.at) && Number.isFinite(clock.offset) && clock.offset >= 0 && clock.path === doc.path ? clock : null;
  }
  get status() {
    const states = [...this.states.values()].filter(s=>s.doc.playing);
    const failed = states.find(s=>s.error), loading = states.some(s=>s.phase === "loading");
    const waiting = this.readiness.status;
    return { busy: this.manualBusy || loading || Boolean(waiting), error: Boolean(failed) || Boolean(waiting?.error), message: failed?.error || waiting?.message || (loading ? "Загрузка звука. Нажмите для повторной синхронизации." : "Синхронизировать звук с ведущим на этом компьютере"), waiting:Boolean(waiting), label:waiting?.label };
  }
  position(doc) {
    const clock = this.clock(doc), sound = doc?.sound;
    // A queued Sound has no valid currentTime until its scheduled playback begins.
    // Keep the selected offset visible through loading and the common start delay.
    if (clock && (clock.waiting || this.now() < clock.at || !sound?.playing)) return clock.offset;
    const position = sound?.element && Number.isFinite(sound.element.currentTime) ? sound.element.currentTime : sound?.currentTime;
    return Number.isFinite(position) && position >= 0 ? position : clock?.offset;
  }
  live(state) { return this.states.get(state.key) === state && state.doc.playing && state.doc.path === state.path && (!state.sound || state.doc.sound === state.sound) && !state.abort.signal.aborted; }
  retire(state) {
    state.abort.abort(); state.doc._cancelFadeOut?.();
    const audio = state.sound;
    if (audio) {
      // A late load may finish after replacement, but can never begin playback.
      const stop = () => { void Promise.resolve(audio.stop?.({fade:0})).catch(()=>{}); };
      audio.addEventListener?.("play",stop,{once:true});
      audio.element?.pause(); stop();
    }
  }
  stop(doc) {
    const key = this.key(doc), state = this.states.get(key);
    if (state) { this.states.delete(key); this.retire(state); this.changed(); }
    else if (doc.sound?.playing) void doc.sound.stop({fade:0});
  }
  ensureClock(doc) {
    const key = this.key(doc);
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || this.clocks.has(key) || this.now() < (this.clockRetryAt.get(key) ?? 0)) return;
    const offset = (doc.sound?.playing ? this.position(doc) : undefined) ?? doc.pausedTime ?? 0;
    const task = doc.setFlag(ID,"clock",{id:foundry.utils.randomID(),at:this.now(),offset:Math.max(0,offset),path:doc.path,...(game.socket ? {waiting:true} : {})});
    this.clocks.set(key,task);
    void task.catch(error=>{this.clockRetryAt.set(key,this.now()+10000);console.warn(`${ID} | Не удалось сохранить момент воспроизведения`,error);})
      .finally(()=>{this.clocks.delete(key);if(this.clock(doc))void this.sync(doc);});
  }
  sync(doc, {force = false} = {}) {
    if (!doc.playing) { this.stop(doc); return Promise.resolve(); }
    const clock = this.clock(doc);
    if (!clock) { this.ensureClock(doc); return Promise.resolve(); }
    if (clock.waiting) this.readiness.track(doc,clock);
    if (game.audio.locked) { this.readiness.report(doc,clock,"locked"); return Promise.resolve(); }
    const key = this.key(doc), signature = JSON.stringify(clock);
    let state = this.states.get(key);
    const committed = state && state.clockId === clock.id && state.waiting && !clock.waiting;
    if (committed) { state.waiting=false; state.signature=signature; }
    if (state && (force || state.signature !== signature || state.path !== doc.path || doc.sound !== state.sound)) {
      this.states.delete(key); this.retire(state); state = null;
    }
    if (!state) {
      state = {key,doc,path:doc.path,signature,clockId:clock.id,waiting:Boolean(clock.waiting),abort:new AbortController(),phase:"idle",attempts:0,retryAt:0};
      this.states.set(key,state);
      // Retire audio that Foundry created before the module was ready.
      if (doc.sound) this.retire({...state,sound:doc.sound,abort:new AbortController()});
    }
    if (state.task || state.ended) return state.task ?? Promise.resolve();
    if (state.error && (state.attempts >= 3 || this.now() < state.retryAt)) return Promise.resolve();
    if (state.sound?.playing) {
      const target = playbackTarget(clock,this.now(),state.sound.duration,doc.repeat);
      if (target.ended) return Promise.resolve(); // The Sound end event applies this layer's playback options.
      state.sound.loop = Boolean(doc.repeat); state.sound.volume = this.effectiveVolume(doc);
      const current = this.position(doc), duration = state.sound.duration;
      let drift = Math.abs(current - target.offset);
      if (doc.repeat && Number.isFinite(duration)) drift = Math.min(drift,Math.abs(duration-drift));
      const media = state.sound.element, stalled = media && !media.paused && this.now() > clock.at + 5000 && media.readyState < 3;
      if (!stalled && target.delay === 0 && drift <= this.tolerance) return Promise.resolve();
      if (stalled) { this.fail(state,new Error("Звук не получает данные. Нажмите синхронизацию для повтора.")); return Promise.resolve(); }
    }
    state.task = this.run(state,clock).finally(()=>{
      state.task=null; this.changed();
      if (this.live(state) && state.phase === "waiting" && !this.clock(doc)?.waiting) void this.sync(doc);
    });
    return state.task;
  }
  fail(state,error) {
    if (!this.live(state)) return;
    this.retire(state);
    if(state.doc.sound === state.sound) state.doc.sound = null;
    state.abort = new AbortController(); state.sound = null;
    state.phase = "error"; state.error = error.message || String(error);
    this.readiness.report(state.doc,this.clock(state.doc) ?? {},"error",state.error);
    state.retryAt = this.now() + (state.attempts < 2 ? 3000 : 10000); this.changed();
  }
  async run(state,clock) {
    const signal = state.abort.signal, valid = () => this.live(state) && !signal.aborted;
    try {
      if (!state.sound) {
        ++state.attempts; state.phase="loading"; state.error=""; this.readiness.report(state.doc,clock,"loading"); this.changed();
        const audio = state.sound = new foundry.audio.Sound(state.path,{context:state.doc.context ?? game.audio.music,forceBuffer:true});
        state.doc.sound = audio;
        audio.addEventListener("play",()=>{ if(this.live(state)) {void state.doc._onStart?.();this.applyVolume(state,this.previewMuted ? 0 : state.doc.fadeDuration ?? 0);} });
        audio.addEventListener("end",()=>this.end(state));
        audio.addEventListener("stop",()=>{ if(this.live(state)) void state.doc._onStop?.(); });
        const loading = audio.load();
        void Promise.resolve(loading).then(()=>{if(!this.live(state)||state.sound!==audio){audio.element?.pause();void Promise.resolve(audio.stop({fade:0})).catch(()=>{});}},()=>{});
        await bounded(loading,this.timeout,signal);
        if (!valid() || state.sound !== audio) return;
        if (audio.failed || !audio.loaded) throw new Error("Не удалось прочитать аудиофайл. Проверьте доступность файла и повторите синхронизацию.");
        if (audio.element) {
          const play = audio.element.play.bind(audio.element);
          audio.element.play = () => { const task=play(); task?.catch(error=>this.fail(state,error)); return task; };
        }
      } else if (state.sound.playing) await bounded(state.sound.stop({fade:0}),this.timeout,signal);
      if (!valid()) return;
      // Read the live clock: the final readiness report may already have committed a start.
      clock = this.clock(state.doc);
      if (clock?.waiting) { state.phase="waiting"; this.readiness.report(state.doc,clock,"ready"); return; }
      if (!clock) return;
      const target = playbackTarget(clock,this.now(),state.sound.duration,state.doc.repeat);
      if (target.ended) { if(game.user.isGM&&game.users.activeGM?.id===game.user.id) this.end(state); else state.ended=true; return; }
      await bounded(state.sound.play({offset:target.offset,delay:target.delay,loop:Boolean(state.doc.repeat),volume:this.effectiveVolume(state.doc),fade:0}),this.timeout,signal);
      if (valid()) { state.phase="playing"; state.error=""; }
    } catch(error) { if(valid()) this.fail(state,error); }
  }
  tick() {
    const docs = this.library.playlists.flatMap(p=>p.sounds.contents), wanted = new Set(docs.filter(d=>d.playing).map(d=>this.key(d)));
    for (const [key,state] of this.states) if(!wanted.has(key)) {this.states.delete(key);this.retire(state);}
    for (const doc of docs) if(doc.playing) void this.sync(doc);
    this.readiness.tick();
  }
  async resync() {
    if(this.manualBusy) return;
    // Resume within the click gesture, before waiting for the server clock.
    const resumed = game.audio.music?.resume?.();
    this.manualBusy=true;this.changed();
    try {
      await Promise.all([bounded(resumed,3000).catch(()=>{}),bounded(game.time?.sync?.(),3000).catch(()=>{})]);
      if(game.audio.locked) throw new Error("Браузер ещё не разрешил звук. Щёлкните по странице и повторите синхронизацию.");
      const docs=this.library.playlists.flatMap(p=>p.sounds.contents).filter(d=>d.playing);
      await Promise.all(docs.map(doc=>this.sync(doc,{force:true})));
      if(docs.some(doc=>!this.clock(doc))) throw new Error("Ожидается момент старта от ведущего. Попросите ГМа обновить страницу и повторите синхронизацию.");
      if(this.status.error) throw new Error(this.status.message);
    } finally {this.manualBusy=false;this.changed();}
  }
}

export function installPlaybackSync(resolve) {
  const proto = CONFIG.PlaylistSound?.documentClass?.prototype;
  if(!proto || typeof proto.sync !== "function") return;
  const original = proto.sync;
  proto.sync = function(...args) {
    const sync = resolve();
    if(this.parent?.getFlag(ID,"managed") && sync) {void sync.sync(this);return;}
    return original.apply(this,args);
  };
}
