export const ID = "yet-another-player-widget";
export const ROOT = `modules/${ID}`;
export const MAX_COOKIES_BYTES = 1024 * 1024;
export function youtubeCookies(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_COOKIES_BYTES) throw new Error("Файл cookies должен быть текстовым и не больше 1 МБ.");
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (!/^# (?:Netscape )?HTTP Cookie File\s*$/.test(lines[0])) throw new Error("Нужен cookies.txt в формате Netscape, а не JSON или заголовок Cookie.");
  const cookies = [];
  for (const line of lines.slice(1)) {
    if (!line.trim() || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) continue;
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    if (fields.length !== 7 || !/^(TRUE|FALSE)$/.test(fields[1]) || fields[0].startsWith(".") !== (fields[1] === "TRUE") || !fields[2].startsWith("/") || !/^(TRUE|FALSE)$/.test(fields[3]) || !/^\d*$/.test(fields[4]) || !Number.isSafeInteger(Number(fields[4])) || !fields[5] || fields.some(field => /[\x00-\x1f\x7f]/.test(field))) throw new Error("Некорректный формат cookies.txt. Экспортируйте файл заново в формате Netscape.");
    const host = fields[0].replace(/^\./, "").toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com")) cookies.push(line);
  }
  if (!cookies.length) throw new Error("В файле не найдены cookies YouTube. Экспортируйте cookies домена youtube.com.");
  return { text: ["# Netscape HTTP Cookie File", ...cookies, ""].join("\n"), count: cookies.length };
}
export const STATUS = Object.freeze({ queued: "В очереди", resolving: "Чтение плейлиста", downloading: "Скачивается", processing: "Обработка", uploading: "Загрузка файла", cancelling: "Отменяется", cancelled: "Отменено", ready: "Загружен", error: "Ошибка" });
export const isDownloadActive = track => ["queued", "resolving", "downloading", "processing", "uploading"].includes(track.status);
export const isDownloadFinished = track => ["ready", "cancelled", "error"].includes(track.status) && !track.cancelRequested;
export const isInDownloadQueue = track => isDownloadActive(track) || track.status === "cancelling" || track.cancelRequested || (!track.queueDismissed && (track.status !== "ready" || ["youtube", "upload"].includes(track.type)));
export const clone = value => JSON.parse(JSON.stringify(value));
export const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
export function time(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—:——";
  const n = Math.floor(seconds);
  return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
export function youtubeSource(input) {
  input = String(input ?? "").trim();
  if (/^[\w-]{11}$/.test(input)) return { url: `https://www.youtube.com/watch?v=${input}`, videoId: input, playlist: false, key: input };
  let url;
  try { url = new URL(input); } catch { throw new Error("Укажите ссылку на видео или плейлист YouTube."); }
  const host = url.hostname.toLowerCase();
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtube-nocookie.com"].includes(host) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw new Error("Поддерживаются только ссылки YouTube.");
  const list = url.searchParams.get("list");
  if (list && /^[\w-]{10,150}$/.test(list)) return { url: `https://www.youtube.com/playlist?list=${list}`, playlist: true, key: `list:${list}` };
  const videoId = host === "youtu.be" ? url.pathname.split("/")[1] : url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
  if (!/^[\w-]{11}$/.test(videoId ?? "")) throw new Error("В ссылке не найдено видео YouTube.");
  return { url: `https://www.youtube.com/watch?v=${videoId}`, videoId, playlist: false, key: videoId };
}
export function audioPath(input) {
  const path = String(input ?? "").trim().replaceAll("\\", "/");
  if (!path || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^https?:\/\//i.test(path)) || path.startsWith("//")) throw new Error("Выберите аудиофайл в хранилище Foundry.");
  return path;
}
export function youtubeTrack(source, name, id) {
  const parsed = youtubeSource(source);
  return { id, kind: parsed.playlist ? "playlist" : "track", name: String(name || (parsed.playlist ? "Плейлист YouTube" : "Видео YouTube")), source: parsed.url, sourceKey: parsed.key, type: "youtube", status: "queued", progress: 0, cover: parsed.videoId ? `https://i.ytimg.com/vi/${parsed.videoId}/hqdefault.jpg` : "", duration: null, path: "", error: "", jobId: null };
}
export function importPlan(sourcePlaylists, existingPlaylists, randomID) {
  return (Array.isArray(sourcePlaylists) ? sourcePlaylists : []).map((source, index) => {
    const key = String(source.id ?? `legacy-${index}-${source.name}`);
    const existing = existingPlaylists.find(p => p.getFlag(ID, "importKey") === key);
    const seen = new Set((existing?.getFlag(ID, "tracks") ?? []).map(t => t.sourceKey));
    const tracks = [];
    for (const item of source.tracks ?? []) {
      try {
        const track = youtubeTrack(item.url ?? item.videoId ?? item.id, item.title ?? item.name, randomID());
        if (!seen.has(track.sourceKey)) { tracks.push(track); seen.add(track.sourceKey); }
      } catch {
        tracks.push({ id: randomID(), kind: "track", name: String(item.title ?? item.name ?? "Недоступный трек"), source: String(item.url ?? ""), type: "youtube", status: "error", error: "Некорректная ссылка в исходном плейлисте", progress: 0 });
      }
    }
    return { key, existing, name: String(source.name || "Импортированный плейлист"), tracks };
  });
}
