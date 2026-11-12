import { ID } from "./model.js";

export const START_DELAY_MS = 600;
export function serverNow() { const now = game.time?.serverTime; return Number.isFinite(now) ? now : Date.now(); }
export function soundDuration(doc) {
  return [doc?.sound?.duration,doc?.getFlag(ID,"duration")].find(value=>Number.isFinite(value)&&value>0);
}
export function localLayerVolume(slot = 0) {
  const value = game.settings.get(ID,"localLayerVolumes")?.[slot];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0,Math.min(1,value)) : 1;
}
export function stampPlayback(sound, changes, now = serverNow()) {
  if (!sound?.parent?.getFlag(ID,"managed") || changes.playing !== true) return;
  if (changes.flags?.[ID]?.clock) return;
  if (sound.playing && !("pausedTime" in changes) && !("path" in changes)) return;
  changes.flags = { ...changes.flags, [ID]: { ...changes.flags?.[ID], clock: {
    id: foundry.utils.randomID(), at: now + START_DELAY_MS,
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

// Uses the document's normal Sound and native end callbacks. Only local audio is repaired;
// players never change shared playback documents or any other module's sounds.
export class PlaybackSync {
  constructor(library, changed = () => {}, {now = serverNow, timeout = 20000, tolerance = 0.3} = {}) {
    Object.assign(this,{library,changed,now,timeout,tolerance}); this.states = new Map(); this.clocks = new Map(); this.clockRetryAt = new Map(); this.manualBusy = false;
  }
  key(doc) { return `${doc.parent.id}:${doc.id}`; }
  effectiveVolume(doc) {
    const slot = this.library.layerEntries?.find(entry=>entry.sound === doc)?.slot ?? 0;
    return (Number.isFinite(doc.volume) ? doc.volume : 0.8) * (game.user.isGM ? 1 : localLayerVolume(slot));
  }
  applyVolumes() {
    for(const state of this.states.values()) if(this.live(state) && state.sound?.loaded) this.applyVolume(state);
  }
  applyVolume(state, fade = 0) {
    const volume = this.effectiveVolume(state.doc), audio = state.sound;
    audio.volume = volume;
    if(!game.user.isGM && audio.playing && typeof audio.fade === "function") void Promise.resolve(audio.fade(volume,{duration:fade,from:fade ? 0 : volume})).catch(()=>{});
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
    return { busy: this.manualBusy || loading, error: Boolean(failed), message: failed?.error || (loading ? "Загрузка звука. Нажмите для повторной синхронизации." : "Синхронизировать звук с ведущим на этом компьютере") };
  }
  position(doc) {
    const sound = doc?.sound;
    return sound?.element && Number.isFinite(sound.element.currentTime) ? sound.element.currentTime : sound?.currentTime;
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
    const task = doc.setFlag(ID,"clock",{id:foundry.utils.randomID(),at:this.now(),offset:Math.max(0,offset),path:doc.path});
    this.clocks.set(key,task);
    void task.catch(error=>{this.clockRetryAt.set(key,this.now()+10000);console.warn(`${ID} | Не удалось сохранить момент воспроизведения`,error);})
      .finally(()=>{this.clocks.delete(key);if(this.clock(doc))void this.sync(doc);});
  }
  sync(doc, {force = false} = {}) {
    if (!doc.playing) { this.stop(doc); return Promise.resolve(); }
    if (game.audio.locked) return Promise.resolve();
    const clock = this.clock(doc);
    if (!clock) { this.ensureClock(doc); return Promise.resolve(); }
    const key = this.key(doc), signature = JSON.stringify(clock);
    let state = this.states.get(key);
    if (state && (force || state.signature !== signature || state.path !== doc.path || doc.sound !== state.sound)) {
      this.states.delete(key); this.retire(state); state = null;
    }
    if (!state) {
      state = {key,doc,path:doc.path,signature,abort:new AbortController(),phase:"idle",attempts:0,retryAt:0};
      this.states.set(key,state);
      // Retire audio that Foundry created before the module was ready.
      if (doc.sound) this.retire({...state,sound:doc.sound,abort:new AbortController()});
    }
    if (state.task || state.ended) return state.task ?? Promise.resolve();
    if (state.error && (state.attempts >= 3 || this.now() < state.retryAt)) return Promise.resolve();
    if (state.sound?.playing) {
      const target = playbackTarget(clock,this.now(),state.sound.duration,doc.repeat);
      if (target.ended) return Promise.resolve(); // Native end event advances the playlist.
      state.sound.loop = Boolean(doc.repeat); state.sound.volume = this.effectiveVolume(doc);
      const current = this.position(doc), duration = state.sound.duration;
      let drift = Math.abs(current - target.offset);
      if (doc.repeat && Number.isFinite(duration)) drift = Math.min(drift,Math.abs(duration-drift));
      const media = state.sound.element, stalled = media && !media.paused && this.now() > clock.at + 5000 && media.readyState < 3;
      if (!stalled && target.delay === 0 && drift <= this.tolerance) return Promise.resolve();
      if (stalled) { this.fail(state,new Error("Звук не получает данные. Нажмите синхронизацию для повтора.")); return Promise.resolve(); }
    }
    state.task = this.run(state,clock).finally(()=>{state.task=null;this.changed();});
    return state.task;
  }
  fail(state,error) {
    if (!this.live(state)) return;
    this.retire(state);
    if(state.doc.sound === state.sound) state.doc.sound = null;
    state.abort = new AbortController(); state.sound = null;
    state.phase = "error"; state.error = error.message || String(error);
    state.retryAt = this.now() + (state.attempts < 2 ? 3000 : 10000); this.changed();
  }
  async run(state,clock) {
    const signal = state.abort.signal, valid = () => this.live(state) && !signal.aborted;
    try {
      if (!state.sound) {
        ++state.attempts; state.phase="loading"; state.error=""; this.changed();
        const audio = state.sound = new foundry.audio.Sound(state.path,{context:state.doc.context ?? game.audio.music});
        state.doc.sound = audio;
        audio.addEventListener("play",()=>{ if(this.live(state)) {void state.doc._onStart?.();if(!game.user.isGM)this.applyVolume(state,state.doc.fadeDuration ?? 0);} });
        audio.addEventListener("end",()=>{ if(this.live(state)) {state.ended=true;void state.doc._onEnd?.();} });
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
      } else await bounded(state.sound.stop({fade:0}),this.timeout,signal);
      if (!valid()) return;
      const target = playbackTarget(clock,this.now(),state.sound.duration,state.doc.repeat);
      if (target.ended) { state.ended=true; if(game.user.isGM&&game.users.activeGM?.id===game.user.id) void state.doc._onEnd?.(); return; }
      await bounded(state.sound.play({offset:target.offset,delay:target.delay,loop:Boolean(state.doc.repeat),volume:this.effectiveVolume(state.doc),fade:0}),this.timeout,signal);
      if (valid()) { state.phase="playing"; state.error=""; }
    } catch(error) { if(valid()) this.fail(state,error); }
  }
  tick() {
    const docs = this.library.playlists.flatMap(p=>p.sounds.contents), wanted = new Set(docs.filter(d=>d.playing).map(d=>this.key(d)));
    for (const [key,state] of this.states) if(!wanted.has(key)) {this.states.delete(key);this.retire(state);}
    for (const doc of docs) if(doc.playing) void this.sync(doc);
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
