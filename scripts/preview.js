// Separate local audio: no Playlist documents or socket messages are changed.
export class TrackPreview {
  constructor(changed = () => {}) { this.changed = changed; this.generation = 0; this.active = null; }
  matches(playlistId, trackId) { return this.active?.playlistId === playlistId && this.active?.trackId === trackId; }
  async stop() {
    ++this.generation;
    const active = this.active; this.active = null; this.changed();
    if (active) await active.sound.stop({ fade: 0 });
  }
  async toggle(playlist, trackId) {
    if (!game.user.isGM) throw new Error("Предпрослушивание доступно только ведущему.");
    const same = this.matches(playlist?.id, trackId);
    const stopping = this.stop(), generation = this.generation;
    await stopping;
    if (generation !== this.generation) return;
    if (same) return;
    const track = playlist?.sounds.get(trackId);
    if (!track) throw new Error("Сначала дождитесь загрузки трека.");
    const sound = new foundry.audio.Sound(track.path, { context: game.audio.music });
    const active = this.active = { playlistId: playlist.id, trackId, sound, loading: true };
    const ended = () => { if (this.active === active) void this.stop().catch(console.error); };
    sound.addEventListener("end", ended, { once: true });
    this.changed();
    try {
      await sound.load();
      if (generation !== this.generation) { await sound.stop({ fade: 0 }); return; }
      if (sound.failed || !Number.isFinite(sound.duration) || sound.duration <= 0) throw new Error("Не удалось открыть звук для предпрослушивания.");
      // Each audition starts between one third and halfway through the actual audio.
      await sound.play({ offset: sound.duration * (0.3 + Math.random() * 0.2), volume: track.volume ?? 0.8, loop: false });
      if (generation !== this.generation) { await sound.stop({ fade: 0 }); return; }
      active.loading = false; this.changed();
    } catch (error) {
      if (generation !== this.generation) return;
      await this.stop(); throw error;
    }
  }
}
