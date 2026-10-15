// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { cleanEntity } from "../convex/entities";
import { followUpQuery, profileBrief, profileRequest } from "../convex/engine/profile";
import { ENTITY_RULE } from "../convex/engine/prompt";
import { DEFAULT_SETTINGS } from "../convex/lib/settings";
import { entityKey, titleFits } from "../convex/web/entity";
import { isEntity, parseEntity, settleEntity, stripEntities } from "../src/lib/entities";
import { signedIn } from "./convex";

describe("marked names in reply text", () => {
  it("reads the name, kind and hint", () => {
    expect(parseEntity("[[Isaiah Rashad|person|American rapper from Chattanooga]]")).toEqual({
      name: "Isaiah Rashad",
      kind: "person",
      hint: "American rapper from Chattanooga",
    });
    expect(parseEntity("[[The Sun's Tirade|work|2016 album]]")?.kind).toBe("work");
    // An unknown or missing kind is still a name to look up.
    expect(parseEntity("[[Mercury|planet]]")).toEqual({ name: "Mercury", kind: "thing", hint: "" });
    expect(parseEntity("[[Matt Damon]]")?.name).toBe("Matt Damon");
  });

  it("isn't fooled by links, citations or stray brackets", () => {
    expect(isEntity("[1]")).toBe(false);
    expect(isEntity("[Damon](https://example.com)")).toBe(false);
    expect(isEntity("[[]]")).toBe(false);
    expect(isEntity("[[a|b|c|d]]")).toBe(false);
  });

  it("strips to the names for copy and previews", () => {
    expect(
      stripEntities(
        "I think [[Matt Damon|person|actor]]'s range beats [[Ben Affleck|person|actor]]."
      )
    ).toBe("I think Matt Damon's range beats Ben Affleck.");
  });

  it("shows a mark still arriving as the name so far", () => {
    expect(settleEntity("Fans of [[Isaiah Ra")).toBe("Fans of Isaiah Ra");
    expect(settleEntity("Fans of [[Isaiah Rashad|person|Ameri")).toBe("Fans of Isaiah Rashad");
    expect(settleEntity("Fans of [[Isaiah Rashad|person|American rapper]")).toBe(
      "Fans of Isaiah Rashad"
    );
    // A finished one is left for the renderer.
    const done = "Fans of [[Isaiah Rashad|person|American rapper]]";
    expect(settleEntity(done)).toBe(done);
  });
});

describe("profile lookup", () => {
  it("matches an article to the name", () => {
    expect(titleFits("Isaiah Rashad", "Isaiah Rashad")).toBe(true);
    expect(titleFits("Mercury (planet)", "Mercury")).toBe(true);
    expect(titleFits("Los Angeles Lakers", "Lakers")).toBe(true);
    expect(titleFits("Matt Damon filmography", "Matt Damon")).toBe(false);
    expect(titleFits("Damon Albarn", "Matt Damon")).toBe(false);
  });

  it("keys the same name the same way", () => {
    const a = entityKey({ name: "Matt Damon", kind: "person", hint: "American actor" });
    const b = entityKey({ name: "matt  damon", kind: "person", hint: "American actor." });
    expect(a).toBe(b);
    expect(entityKey({ name: "Mercury", kind: "thing", hint: "planet" })).not.toBe(
      entityKey({ name: "Mercury", kind: "thing", hint: "chemical element" })
    );
  });

  it("tidies what the model wrote", () => {
    expect(cleanEntity({ name: " Matt [Damon] ", kind: "PERSON", hint: "actor|writer" })).toEqual({
      name: "Matt Damon",
      kind: "person",
      hint: "actor writer",
    });
    expect(cleanEntity({ name: "  ", kind: "person" })).toBeNull();
  });

  it("asks for a profile that doesn't repeat the overview", () => {
    const e = { name: "Matt Damon", kind: "person" as const, hint: "American actor" };
    expect(profileRequest(e, "Ben Affleck vs Matt Damon")).toContain(
      "Matt Damon (person: American actor)"
    );
    const brief = profileBrief(e, { title: "Matt Damon", extract: "An actor.", images: [] }, true);
    expect(brief).toContain("source [1]");
    expect(brief).toContain("Don't repeat the overview");
    expect(profileBrief(e, undefined, false)).toContain("Open with a 2 to 3 sentence overview");
    expect(ENTITY_RULE).toContain("[[Name|kind|what it is]]");
  });

  it("searches a sheet question under the subject's name", () => {
    const e = { name: "Francis Ford Coppola", kind: "person" as const, hint: "film director" };
    expect(followUpQuery(e, "What is his latest film?")).toBe("Francis Ford Coppola latest film");
    expect(followUpQuery(e, "Did Coppola’s daughter direct too?")).toBe(
      "Francis Ford Coppola Did daughter direct too"
    );
  });
});

describe("profile chats", () => {
  async function chat(t: Awaited<ReturnType<typeof signedIn>>["t"], userId: any) {
    return await t.run((ctx) =>
      ctx.db.insert("threads", {
        userId,
        title: "Ben Affleck vs Matt Damon",
        modelRef: "p/m",
        mode: "chat",
        reasoningLevel: "auto",
        incognito: false,
        updatedAt: Date.now(),
      })
    );
  }

  it("opens a hidden chat, reuses it, and goes with its chat", async () => {
    const { t, userId, as } = await signedIn();
    const parent = await chat(t, userId);
    const name = { name: "Matt Damon", kind: "person", hint: "American actor" };
    const { threadId } = await as.mutation(api.entities.open, { threadId: parent, ...name });

    // Not in Recents; the sheet shows the profile's reply under the app's request.
    const listed = await as.query(api.threads.list, {});
    expect(listed.map((x) => x.id)).toEqual([parent]);
    const sheet = await as.query(api.entities.sheet, { threadId });
    expect(sheet?.entity.name).toBe("Matt Damon");
    expect(sheet?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // The same name again reopens it; a name inside it hangs off the first chat.
    expect((await as.mutation(api.entities.open, { threadId: parent, ...name })).threadId).toBe(
      threadId
    );
    const inner = await as.mutation(api.entities.open, {
      threadId,
      name: "Ben Affleck",
      kind: "person",
      hint: "American actor and director",
    });
    expect((await t.run((ctx) => ctx.db.get(inner.threadId)))?.parentThreadId).toBe(parent);

    await t.mutation(internal.entities.setCard, {
      threadId,
      card: { title: "Matt Damon", images: ["https://upload.wikimedia.org/a.jpg"] },
    });
    expect((await as.query(api.entities.sheet, { threadId }))?.entity.card?.images).toHaveLength(1);

    await t.mutation(internal.threads.purge, { threadId: parent, userId });
    expect(await t.run((ctx) => ctx.db.get(threadId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(inner.threadId))).toBeNull();
  });

  it("only opens names from the user's own chats", async () => {
    const { t, userId } = await signedIn();
    const parent = await chat(t, userId);
    const other = await signedIn();
    await expect(
      other.as.mutation(api.entities.open, { threadId: parent, name: "Matt Damon" })
    ).rejects.toThrow();
  });
});

describe("profile header", () => {
  it("drops the same Wikimedia photo at another size", async () => {
    const { distinct } = await import("../convex/web/entity");
    expect(
      distinct([
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f9/MattDamon-byPhilipRomano2.jpg/1280px-MattDamon-byPhilipRomano2.jpg?utm_source=x",
        "https://upload.wikimedia.org/wikipedia/commons/f/f9/MattDamon-byPhilipRomano2.jpg?utm_source=y",
        "https://cdn.britannica.com/37/Actor-Matt-Damon.jpg",
      ])
    ).toHaveLength(2);
  });

  it("tidies the pronunciation the plain-text export leaves", async () => {
    const { cleanExtract } = await import("../convex/web/entity");
    expect(
      cleanExtract("Matthew Paige Damon ( DAY-mən; born October 8, 1970) is an American actor.")
    ).toBe("Matthew Paige Damon (born October 8, 1970) is an American actor.");
    expect(cleanExtract("Isaiah Rashad (born July 16, 1991) is a rapper.")).toBe(
      "Isaiah Rashad (born July 16, 1991) is a rapper."
    );
  });
});

describe("names in cards", () => {
  it("shows a mark slipped into a card program as its name", async () => {
    const { plainNames } = await import("../convex/engine/profile");
    expect(plainNames('c = Card("[[Good Will Hunting|work|1997 film]]", null, "poster")')).toBe(
      'c = Card("Good Will Hunting", null, "poster")'
    );
  });
});

describe("the profile's model", () => {
  const H = 60 * 60_000;
  const relay = [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "claude-fable-5",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "glm-5.3-flash-uncensored",
    "deepseek-v4.1-flash",
    "gemini-4-argon",
  ].map((id) => ({ id, kind: "chat" as const, tools: true }));

  it("times the chat's model, its family and a few known ones, never flagships or variants", async () => {
    const { speedCandidates, familyOf } = await import("../convex/lib/profileModel");
    expect(familyOf("openai/gpt-6.1-sol")).toBe("gpt");
    expect(familyOf("claude-haiku-5-5")).toBe("claude");
    expect(speedCandidates("7api/gpt-6.1-sol", relay)).toEqual([
      "7api/gpt-6.1-sol",
      "7api/gpt-6-sol",
      "7api/gpt-6-luna",
      "7api/gpt-5.6-sol",
      "7api/claude-haiku-5-5",
      "7api/gemini-4-argon",
    ]);
    expect(speedCandidates("7api/gemini-4-argon", relay)).toEqual([
      "7api/gemini-4-argon",
      "7api/gpt-6.1-sol",
      "7api/gpt-6-sol",
      "7api/gpt-6-luna",
      "7api/claude-haiku-5-5",
    ]);
    // A model that can't search can't answer questions asked in the sheet.
    expect(
      speedCandidates("p/gpt-6.1-sol", [{ id: "gpt-6-sol", kind: "chat", tools: false }])
    ).toEqual(["p/gpt-6.1-sol"]);
  });

  it("keeps the chat's model while it's quick, and otherwise takes the first quick one", async () => {
    const { pickProfileModel } = await import("../convex/lib/profileModel");
    const now = Date.now();
    const at = now - H;
    // The probe's readings on the relay, 2026-10-15.
    const sol = { ref: "7api/gpt-6.1-sol", speed: { firstTextMs: 2414, at } };
    const quick = { ref: "7api/gpt-6-sol", speed: { firstTextMs: 1966, at } };
    const luna = { ref: "7api/gpt-5.6-luna", speed: { firstTextMs: 1055, at } };
    expect(pickProfileModel([sol, quick, luna], now)).toBe("7api/gpt-6.1-sol");

    const argon = { ref: "7api/gemini-4-argon", speed: { firstTextMs: 5398, at } };
    // The earlier (newer, fuller) of the quick ones gets it.
    expect(pickProfileModel([argon, sol, quick, luna], now)).toBe("7api/gpt-6.1-sol");
    const slowSol = { ...sol, speed: { firstTextMs: 4000, at } };
    expect(pickProfileModel([argon, slowSol, quick, luna], now)).toBe("7api/gpt-6-sol");
    // None quick: the ones close to the quickest count.
    const slow = (c: typeof quick, ms: number) => ({
      ...c,
      speed: { ...c.speed, firstTextMs: ms },
    });
    expect(pickProfileModel([argon, slow(sol, 5000), slow(quick, 4200)], now)).toBe(
      "7api/gpt-6.1-sol"
    );

    // Nothing to compare against yet, or readings too old: the chat's model.
    expect(pickProfileModel([{ ref: argon.ref }, quick], now)).toBe(argon.ref);
    const stale = (c: typeof quick) => ({ ...c, speed: { ...c.speed, at: now - 4 * 24 * H } });
    expect(pickProfileModel([argon, stale(quick)], now)).toBe(argon.ref);
    // Everything timed out: no reason to move.
    const down = (c: typeof quick) => ({ ...c, speed: { ...c.speed, firstTextMs: 20_000 } });
    expect(pickProfileModel([down(argon), down(quick)], now)).toBe(argon.ref);
  });

  it("probes again when a reading is missing or a day old, and smooths new ones", async () => {
    const { speedsDue, blendSpeed } = await import("../convex/lib/profileModel");
    const now = Date.now();
    const fresh = { ref: "p/a", speed: { firstTextMs: 1000, at: now - H } };
    expect(speedsDue([fresh], now)).toBe(false);
    expect(speedsDue([fresh, { ref: "p/b" }], now)).toBe(true);
    expect(speedsDue([{ ...fresh, speed: { firstTextMs: 1000, at: now - 25 * H } }], now)).toBe(
      true
    );
    expect(blendSpeed({ firstTextMs: 1000, at: now - H }, 3000, now)).toBe(2000);
    expect(blendSpeed({ firstTextMs: 1000, at: now - 4 * 24 * H }, 3000, now)).toBe(3000);
    expect(blendSpeed(undefined, 3000, now)).toBe(3000);
  });

  async function setup(speeds: Record<string, number>) {
    const { t, userId, as } = await signedIn();
    const parent = await t.run(async (ctx) => {
      await ctx.db.insert("providers", {
        userId,
        providerId: "7api",
        label: "7api",
        baseUrl: "https://7api.example",
        keyHint: "",
        headerHints: [],
        status: "connected",
        models: relay.map(({ id, kind }) => ({ id, name: id, contextWindow: 200_000, kind })),
      });
      for (const [modelId, firstTextMs] of Object.entries(speeds))
        await ctx.db.insert("modelSpeeds", {
          userId,
          providerId: "7api",
          modelId,
          firstTextMs,
          at: Date.now(),
        });
      return await ctx.db.insert("threads", {
        userId,
        title: "Ben Affleck vs Matt Damon",
        modelRef: "7api/gemini-4-argon",
        mode: "chat",
        reasoningLevel: "medium",
        incognito: false,
        updatedAt: Date.now(),
      });
    });
    const open = async (name: string) => {
      const { threadId } = await as.mutation(api.entities.open, { threadId: parent, name });
      return (await t.run((ctx) => ctx.db.get(threadId)))!;
    };
    const probes = () =>
      t.run(async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
          f.name.includes("speed")
        )
      );
    return { t, userId, open, probes };
  }

  it("writes at low effort with a quicker model from the same provider", async () => {
    const all = Object.fromEntries(relay.map((m) => [m.id, 2000]));
    const { open, probes } = await setup({ ...all, "gemini-4-argon": 5400 });
    const profile = await open("Matt Damon");
    expect(profile.modelRef).toBe("7api/gpt-6.1-sol");
    expect(profile.reasoningLevel).toBe("low");
    // Fresh readings for every candidate: no probe.
    expect(await probes()).toHaveLength(0);
  });

  it("keeps the chat's model and times the others when nothing has been timed", async () => {
    const { open, probes } = await setup({});
    expect((await open("Matt Damon")).modelRef).toBe("7api/gemini-4-argon");
    const [probe] = await probes();
    expect(probe.args[0].refs[0]).toBe("7api/gemini-4-argon");
    // Names opened in a row start one probe, not one each.
    await open("Ben Affleck");
    expect(await probes()).toHaveLength(1);
  });

  it("uses the model the user set for side work", async () => {
    const { t, userId, open } = await setup({});
    await t.run((ctx) =>
      ctx.db.insert("settings", {
        userId,
        ...DEFAULT_SETTINGS,
        roleModels: { ...DEFAULT_SETTINGS.roleModels, worker: "7api/gpt-6-luna" },
      })
    );
    expect((await open("Matt Damon")).modelRef).toBe("7api/gpt-6-luna");
  });
});
