// Validate our creation payloads against the installed Foundry schema, without starting or changing a world.
// Usage: node tests/foundry-v13-schema.mjs "C:/foundry13/Foundry Virtual Tabletop/resources/app"
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Library } from "../scripts/library.js";
import { ID } from "../scripts/model.js";

const appPath = process.argv[2] || process.env.FOUNDRY_APP_PATH;
if (!appPath) throw new Error("Укажите папку resources/app установленного Foundry v13.");
await import(pathToFileURL(path.join(appPath, "common", "server.mjs")).href);

globalThis.game = {
  release: { version: "13.350" }, system: { id: "schema-test", version: "1.0.0" },
  user: { id: "AAAAAAAAAAAAAAAA", isGM: true }, playlists: new foundry.utils.Collection(),
  settings: { get: () => [{ id: "legacy", name: "Imported", tracks: [{ url: "abcdefghijk", title: "One" }] }] }
};
const NativePlaylist = foundry.documents.BasePlaylist;
class TestPlaylist extends NativePlaylist {
  static get database() { return { getFlagScopes: () => [ID, "core", "world"] }; }
  static async create(data) {
    // Exercise the real Document constructor and every native field validator.
    const playlist = new this({ ...data, _id: foundry.utils.randomID() });
    game.playlists.set(playlist.id, playlist);
    return playlist;
  }
  async setFlag(scope, key, value) { this.updateSource({ [`flags.${scope}.${key}`]: value }); return this; }
}
globalThis.CONFIG = {
  Playlist: { documentClass: TestPlaylist },
  PlaylistSound: { documentClass: foundry.documents.BasePlaylistSound }
};

assert.throws(() => new TestPlaylist({ name: "Old invalid payload", fade: 0 }), /positive number/);
console.log("PASS Real Foundry v13 schema reproduces the rejected fade: 0 payload");

const library = new Library();
const playlist = await library.create("123");
assert.ok(playlist.id);
assert.equal(playlist.name, "123");
assert.equal(playlist.getFlag(ID, "managed"), true);
assert.equal(playlist.mode, CONST.PLAYLIST_MODES.SEQUENTIAL);
assert.equal(playlist.sorting, CONST.PLAYLIST_SORT_MODES.MANUAL);
console.log("PASS Playlist 123 is created with the real Foundry v13 schema");

const imported = await library.importYoutube();
assert.equal(imported.playlists, 1);
assert.equal(imported.tracks, 1);
assert.equal(library.playlists.length, 2);
console.log("PASS YouTube import creates playlists with the real Foundry v13 schema");

const originalCreate = TestPlaylist.create;
TestPlaylist.create = async () => undefined;
await assert.rejects(() => library.create("Cancelled"), /не создал плейлист/);
TestPlaylist.create = originalCreate;
assert.ok((await library.create("After cancellation")).id);
console.log("PASS Cancelled creation reports a readable error and does not block the next attempt");

const listener={id:"BBBBBBBBBBBBBBBB",isGM:false,hasRole:()=>false,hasPermission:()=>false};
const otherListener={...listener,id:"CCCCCCCCCCCCCCCC"};
const preference=new foundry.documents.BaseSetting({key:`${ID}.miniTransparency`,user:listener.id,value:35});
assert.equal(preference.user,listener.id);
assert.equal(preference.canUserModify(listener,"create"),true);
assert.equal(preference.canUserModify(listener,"update",{value:65}),true);
assert.equal(preference.canUserModify(otherListener,"update",{value:65}),false);
assert.equal(preference.canUserModify(listener,"update",{user:otherListener.id}),false);
console.log("PASS Real Foundry v13 user settings allow players to save their own transparency and reject changes to another player's preference");
