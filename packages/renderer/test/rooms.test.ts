import { describe, expect, it } from "vitest";
import { ROOM_STYLES, THEMES, asRoomStyle, roomStyleForTemplate } from "../src/render3d/rooms";

describe("roomStyleForTemplate", () => {
  it("maps the shipped templates to their rooms", () => {
    expect(roomStyleForTemplate("coding")).toBe("dev");
    expect(roomStyleForTemplate("content-studio")).toBe("studio");
    expect(roomStyleForTemplate("real-estate-marketing")).toBe("estate");
  });
  it("falls back to the dev floor for anything else", () => {
    expect(roomStyleForTemplate(null)).toBe("dev");
    expect(roomStyleForTemplate(undefined)).toBe("dev");
    expect(roomStyleForTemplate("something-new")).toBe("dev");
  });
  it("is case-insensitive", () => {
    expect(roomStyleForTemplate("Real-Estate-Marketing")).toBe("estate");
  });
});

describe("asRoomStyle", () => {
  it("accepts a real style and refuses garbage (it comes from a URL)", () => {
    expect(asRoomStyle("studio")).toBe("studio");
    expect(asRoomStyle("<script>")).toBe("dev");
    expect(asRoomStyle(null)).toBe("dev");
  });
});

describe("THEMES", () => {
  it("defines every room", () => {
    for (const s of ROOM_STYLES) expect(THEMES[s]).toBeDefined();
  });
  it("gives each room its own look", () => {
    const floors = new Set(ROOM_STYLES.map((s) => `${THEMES[s].floorMap}`));
    expect(floors.size).toBe(3);
    expect(new Set(ROOM_STYLES.map((s) => THEMES[s].arcadeMarquee)).size).toBe(3);
  });
  it("keeps the dev room exactly as it always was", () => {
    // these are the colours Office3D hard-coded before rooms existed
    expect(THEMES.dev.floor).toBe(0xf2f5fa);
    expect(THEMES.dev.deskTop).toBe(0x8a6a44);
    expect(THEMES.dev.arcadeMarquee).toBe(0xff9100);
    expect(THEMES.dev.floorMap).toBe("none");
  });
});
