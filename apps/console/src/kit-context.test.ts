import { describe, expect, it } from "vitest";
import { kitContext } from "./kit-context.js";

const field = (value: string | null) => (value === null ? { state: "missing" } : { state: "provided", value, source: "user", confirmed: true });
const kit = (platform: string | null, audience: string | null, tone: string | null) => ({ platform: field(platform), audience: field(audience), brand: { tone: field(tone) } }) as never;

describe("guided-setup answers reach the router", () => {
  it("adds a platform chosen in the form that the text does not mention", () => {
    expect(kitContext(kit("Instagram Reels", null, null), "A 25 second motion graphics video.")).toBe("Platform: Instagram Reels.");
  });
  it("does not repeat what the text already says, and ignores unanswered fields", () => {
    expect(kitContext(kit("Instagram Reels", "agencies", "soft"), "Make it for agencies on instagram reels, soft")).toBe("");
    expect(kitContext(kit(null, null, null), "anything")).toBe("");
    expect(kitContext(undefined, "anything")).toBe("");
  });
  it("adds audience and tone too", () => {
    expect(kitContext(kit("YouTube", "agencies", "soft, calm"), "A film.")).toBe("Platform: YouTube. Audience: agencies. Tone of voice: soft, calm.");
  });
});
