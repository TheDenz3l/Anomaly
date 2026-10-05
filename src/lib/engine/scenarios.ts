import type { CatalogName, CatalogProps } from "@/genui/schemas";
import * as fx from "@/lib/mock/fixtures";
import type { Model, Source, SubagentMode, ThreadMode, UiEventPart } from "@/lib/types";
import { decisions, type Difficulty, type Scenario } from "./decision";

/** A mock "model turn": the ops a real endpoint would stream (reasoning, text deltas, tool calls, sources). */
export type Op =
  | { op: "think"; text: string }
  | { op: "text"; text: string }
  | { op: "component"; name: CatalogName; props: unknown; fallbackText: string; buildMs?: number }
  | { op: "sources"; sources: Source[] }
  | { op: "wait"; ms: number };

export type Script = { ops: Op[]; difficulty: Difficulty; kind?: "report" };

export type ScriptContext = {
  model: Model;
  mode: ThreadMode;
  hasImages: boolean;
  incognito: boolean;
  memoryEnabled: boolean;
  subagentMode: SubagentMode;
  locationGranted: boolean;
};

const think = (text: string): Op => ({ op: "think", text });
const say = (text: string): Op => ({ op: "text", text });
const ui = <N extends CatalogName>(
  name: N,
  props: CatalogProps<N>,
  fallbackText: string,
  buildMs?: number
): Op => ({
  op: "component",
  name,
  props,
  fallbackText,
  buildMs,
});

export const demoPrompts = [
  "What movies are playing near me?",
  "Show my savings if I add $500 a month",
  "Research the best e-bikes under $2,000",
  "Compare Pixel 11 and iPhone 17 using sub-agents",
  "What's the weather this weekend?",
  "Packing list for 4 days in Lisbon",
  "Remember that I'm vegetarian",
];

function demoChips(prompt = "Try one of these"): Op {
  return ui(
    "ChoiceChips",
    {
      prompt,
      choices: demoPrompts.slice(0, 6).map((p, i) => ({ id: `demo${i}`, label: p })),
    },
    `Suggestions: ${demoPrompts.slice(0, 6).join("; ")}`
  );
}

function moviesResults(city?: string): Script {
  const where = city && city !== "current" ? city : "you";
  return {
    difficulty: "moderate",
    ops: [
      think(
        "Location is near Queen & Spadina. Plan: TMDB now-playing for posters and runtimes, Overpass for cinemas within 3 km, then read each theatre's showtimes page. Mark times as coming from theatre sites."
      ),
      say(
        `Here's what's playing tonight near ${where}. **Northbound** has the most showings, and Scotiabank has the latest IMAX at **10:15 PM**.`
      ),
      ui(
        "MovieShowtimes",
        fx.movieShowtimes,
        "Five films tonight. Northbound: Scotiabank IMAX 4:20, 7:10, 10:15 PM; Yonge-Dundas 5:00, 7:45, 9:30 PM.",
        1100
      ),
      ui(
        "MapCard",
        fx.theatreMap,
        "Five theatres within 3 km; the closest is Scotiabank Theatre, 0.4 km away.",
        900
      ),
      say("Tap a time to pick it and I'll plan the rest of the evening around it."),
      { op: "sources", sources: fx.movieSources },
    ],
  };
}

function research(stage: "clarify" | "plan" | "run"): Script {
  if (stage === "clarify") {
    return {
      difficulty: "moderate",
      ops: [
        think("Broad question. Ask what matters before spending search budget."),
        say("Before I start, a quick question so the research fits how you'll ride."),
        ui(
          "ChoiceChips",
          fx.ebikeClarify,
          "What matters most: range, hill climbing, weight, cargo, or repairability?"
        ),
      ],
    };
  }
  if (stage === "plan") {
    return {
      difficulty: "moderate",
      ops: [
        say(
          "Here's the plan. Edit or remove steps, then start. Estimated cost is shown before anything runs."
        ),
        ui(
          "ResearchPlan",
          fx.ebikePlan,
          "Four steps: shortlist, range and hills, weight and servicing, owner reports.",
          800
        ),
      ],
    };
  }
  return {
    difficulty: "hard",
    kind: "report",
    ops: [
      say(
        "Running four research workers in parallel. You can leave this screen; I'll send a notification when the report is ready."
      ),
      ui(
        "ResearchProgress",
        fx.ebikeProgress,
        "Research in progress: 4 workers, 38 sources found.",
        500
      ),
      { op: "wait", ms: fx.ebikeProgress.durationMs + 400 },
      think(
        "Synthesis. Hub motors with torque sensors are fine for moderate hills; steep grades favour mid-drive. Claimed ranges overstate real-world by 20–35%. Verifier dropped two claims with no retrieved source."
      ),
      say(
        "### Short answer\nFor city commuting with some hills, the **Ride1Up Prodigy V2** is the strongest pick under $2,000. It's the only mid-drive in the group and the lightest at 23 kg [5][8]. If range matters more than weight, the **Velotric Discover 2** goes furthest per charge [7].\n\n### What the testing showed\n- Claimed ranges run 20–35% optimistic in mixed riding with hills [1][3].\n- Mid-drive motors climb steep grades noticeably better than hub motors at the same wattage [8].\n- Torque sensors make hub-motor bikes feel far more natural in traffic; the Aventon Level 3 has one [6].\n- Look for UL 2849 certification. It's the clearest signal of a safe battery system [9].\n\n### Owning one\nOwners report that standard parts like brakes, chains and tires are easy to service anywhere, while proprietary displays and batteries are the usual failure points [4][10]. In Toronto, power-assisted bikes are limited to 32 km/h and 120 kg [11]."
      ),
      ui(
        "Table",
        fx.ebikeTable,
        "Shortlist: Aventon Level 3 $1,899; Velotric Discover 2 $1,599; Ride1Up Prodigy V2 $1,995; Lectric XP Trike $1,499."
      ),
      say(
        "All 11 citations were checked against the retrieved pages. Two claims without a source were dropped."
      ),
      { op: "sources", sources: fx.ebikeSources },
    ],
  };
}

function subagents(stage: "plan" | "run" | "cancel"): Script {
  if (stage === "plan") {
    return {
      difficulty: "hard",
      ops: [
        think(
          "Three independent questions plus verification. Parallel(4) fits within depth 1 and budget."
        ),
        say(
          "This splits cleanly into parallel work. Here's the plan. Approve it and the workers start."
        ),
        ui(
          "SubagentPlan",
          fx.phonePlan,
          "Plan: four workers for cameras, battery, prices and verification. Estimated cost $0.08.",
          900
        ),
      ],
    };
  }
  if (stage === "cancel") {
    return {
      difficulty: "easy",
      ops: [say("Cancelled. Nothing ran and nothing was charged to your key.")],
    };
  }
  const total = Math.max(...fx.phoneTimeline.runs.map((r) => r.durationMs));
  return {
    difficulty: "hard",
    ops: [
      say("Workers are running. You can cancel any of them."),
      ui(
        "SubagentTimeline",
        fx.phoneTimeline,
        "Four workers: camera, battery, prices, verification.",
        400
      ),
      { op: "wait", ms: total + 500 },
      say(
        "Here's how they compare. One worker couldn't reach carrier pages, so trade-in offers are missing and prices are manufacturer list prices."
      ),
      ui(
        "Compare",
        fx.phoneCompare,
        fx.phoneCompare.verdict ?? "Comparison of Pixel 11 and iPhone 17."
      ),
      { op: "sources", sources: fx.phoneSources },
    ],
  };
}

function memory(text: string, ctx: ScriptContext): Script {
  if (ctx.incognito) {
    return {
      difficulty: "easy",
      ops: [say("Got it for this chat. It's incognito, so I won't save anything to memory.")],
    };
  }
  if (!ctx.memoryEnabled) {
    return {
      difficulty: "easy",
      ops: [
        say(
          "Got it for this chat. Memory is turned off in Settings, so I won't keep it afterwards."
        ),
      ],
    };
  }
  const gate = decisions.memoryGate(text);
  const auto = gate.confidence > 0.85;
  return {
    difficulty: "easy",
    ops: [
      say(
        auto
          ? "Got it. I'll keep that in mind in future chats."
          : "Got it. Want me to remember this across chats?"
      ),
      ui(
        "MemoryConfirm",
        {
          text: gate.choice.text,
          category: gate.choice.category,
          scope: gate.choice.scope,
          confidence: gate.confidence,
        },
        `Memory: ${gate.choice.text}`,
        300
      ),
    ],
  };
}

const scenarioScripts: Record<Scenario, (text: string, ctx: ScriptContext) => Script> = {
  movies: (_t, ctx) =>
    ctx.locationGranted
      ? moviesResults()
      : {
          difficulty: "easy",
          ops: [
            think("Needs local showtimes. Ask for location inline instead of guessing a city."),
            say(
              "I can check what's playing nearby. I'll need your location to find theatres close to you."
            ),
            ui(
              "LocationRequest",
              { reason: "Find theatres near you", fallbackCity: "Toronto" },
              "Location needed to find nearby theatres.",
              300
            ),
          ],
        },
  savings: () => ({
    difficulty: "moderate",
    ops: [
      think(
        "Compound monthly contributions over 20 years at 6%. Render an interactive chart so the user can drag the contribution."
      ),
      say(
        "Here's how $10,000 grows with **$500 a month** at a 6% average return. Drag the handle to try other amounts; the chart recalculates as you go."
      ),
      ui(
        "Chart",
        fx.savingsChart,
        "At $500 a month for 20 years at 6%, $10,000 grows to about $264,000.",
        1000
      ),
      say("Returns vary year to year. Treat 6% as a planning assumption, not a promise."),
    ],
  }),
  research: () => research("clarify"),
  subagents: (_t, ctx) =>
    ctx.subagentMode === "off" && !/agent/i.test(_t)
      ? scenarioScripts.compare(_t, ctx)
      : subagents("plan"),
  compare: () => ({
    difficulty: "moderate",
    ops: [
      say(
        "Quick side-by-side from what I already know. Ask me to use sub-agents if you want fresh sources."
      ),
      ui("Compare", fx.phoneCompare, fx.phoneCompare.verdict ?? ""),
    ],
  }),
  weather: () => ({
    difficulty: "easy",
    ops: [
      say(
        "Mild and mostly dry today. Rain moves in late tonight and sticks around Sunday, so **Saturday is the better day** to be outside."
      ),
      ui(
        "Weather",
        fx.weatherToronto,
        "Toronto: 14°C, sun and cloud. High 16, low 8. Rain from 10 PM; Sunday wet, 13°C."
      ),
      { op: "sources", sources: fx.weatherSources },
    ],
  }),
  checklist: () => ({
    difficulty: "easy",
    ops: [
      say(
        "Lisbon is hilly and the cobblestones get slick, so shoes matter more than anything else. Here's a list you can tick off as you pack."
      ),
      ui("Checklist", fx.lisbonChecklist, "Documents, clothes and tech for four days in Lisbon."),
    ],
  }),
  memory: (text, ctx) => memory(text, ctx),
  products: () => ({
    difficulty: "moderate",
    ops: [
      say(
        "Four solid options. The **Sony WH-1000XM6** has the best noise cancelling for the price; the **Soundcore Space One** gets you most of the way for a third of the cost."
      ),
      ui(
        "ProductGrid",
        fx.headphones,
        "Sony WH-1000XM6 $279; Bose QuietComfort Ultra $299; Sennheiser Momentum 4 $229; Soundcore Space One $99."
      ),
      { op: "sources", sources: fx.headphoneSources },
    ],
  }),
  timeline: () => ({
    difficulty: "easy",
    ops: [
      say("Eight moments that shaped the web. Tap one for detail."),
      ui(
        "Timeline",
        fx.webTimeline,
        "1989 proposal, 1991 first site, 1993 Mosaic, 1995 JavaScript, 1998 Google, 2004 Web 2.0, 2007 iPhone, 2014 HTML5."
      ),
      { op: "sources", sources: fx.webTimelineSources },
    ],
  }),
  form: () => ({
    difficulty: "easy",
    ops: [
      say("I've filled in what I could. Check the details. Nothing gets sent until you confirm."),
      ui("Form", fx.bookingForm, "Table request at Bar Isabel for 2, Saturday 7:00 PM."),
    ],
  }),
  steps: () => ({
    difficulty: "moderate",
    ops: [
      say("WireGuard is the simplest reliable option. Five steps, about 20 minutes."),
      ui(
        "Stepper",
        fx.wireguardSteps,
        "Pick a host, install WireGuard, forward UDP 51820, add your phone, test from outside."
      ),
    ],
  }),
  image: (_t, ctx) => ({
    difficulty: "easy",
    ops: ctx.model.profile.features.vision
      ? [
          say(
            "Your photo was sent as an `image_url` part. In mock mode I can't look at it yet. With a vision model connected, I'll describe it and answer questions about it here."
          ),
        ]
      : [
          say(
            `**${ctx.model.name}** can't read images, so it only received your text. Switch to a vision model such as GPT-5 or Claude Sonnet 4.5 from the model picker.`
          ),
        ],
  }),
  fallback: () => ({
    difficulty: "easy",
    ops: [
      say(
        "This is a mock reply. No model is connected yet, so I can't answer that for real. Once you add a provider in Settings, messages go to your own model.\n\nThese prompts show what Atlas can build inline:"
      ),
      demoChips(),
    ],
  }),
};

export function scriptForPrompt(text: string, ctx: ScriptContext): Script {
  const route = decisions.route({
    text,
    hasImages: ctx.hasImages,
    researchMode: ctx.mode === "research",
  });
  return scenarioScripts[route.choice](text, ctx);
}

export function scriptForEvent(event: UiEventPart, ctx: ScriptContext): Script | null {
  const p = event.payload ?? {};
  switch (`${event.component}:${event.action}`) {
    case "LocationRequest:allow":
      return moviesResults("current");
    case "LocationRequest:city":
      return moviesResults(String(p.city ?? "Toronto"));
    case "MovieShowtimes:select_showtime":
      return {
        difficulty: "easy",
        ops: [
          say(
            `Good pick: **${p.movie}** at **${p.theatre}**, ${p.time}. Tickets are sold on the theatre's site, so I can't buy them for you. It's ${p.distance} from you; leave about 15 minutes early to get seats.`
          ),
          ui(
            "ChoiceChips",
            {
              prompt: "Anything else for tonight?",
              choices: [
                { id: "dinner", label: "Find dinner nearby" },
                { id: "remind", label: "Remind me an hour before" },
                { id: "directions", label: "Directions to the theatre" },
              ],
            },
            "Find dinner, set a reminder, or get directions."
          ),
        ],
      };
    case "MapCard:directions":
      return {
        difficulty: "easy",
        ops: [
          say(
            `Opening walking directions to **${p.place}**. It's about ${p.minutes} minutes on foot.`
          ),
        ],
      };
    case "Chart:save_plan":
      return {
        difficulty: "easy",
        ops: [
          say(
            `Saved. At **${p.contribution} a month** you'd have about **${p.final}** after 20 years, and ${p.growth} of that comes from growth. I'll keep this in the thread so you can come back to it.`
          ),
        ],
      };
    case "ChoiceChips:choose": {
      const ids = Array.isArray(p.ids) ? (p.ids as string[]) : [];
      if (ids.some((i) => fx.ebikeClarify.choices.some((c) => c.id === i))) return research("plan");
      if (ids[0]?.startsWith("demo")) return scriptForPrompt(event.label, ctx);
      return {
        difficulty: "easy",
        ops: [
          say(
            `Okay: ${event.label.toLowerCase()}. In mock mode that's where this thread ends, but the choice was sent back to the model as a \`ui_event\`.`
          ),
        ],
      };
    }
    case "ResearchPlan:start":
      return research("run");
    case "SubagentPlan:approve":
      return subagents("run");
    case "SubagentPlan:cancel":
      return subagents("cancel");
    case "Form:submit":
      return {
        difficulty: "easy",
        ops: [
          say(
            `Here's the request: **${p.party} people at ${p.restaurant}, ${String(p.day).toLowerCase()} at ${p.time}**${p.patio ? ", patio if possible" : ""}. Sending it contacts the restaurant, so I need your go-ahead.`
          ),
          ui(
            "ChoiceChips",
            {
              prompt: "Send it?",
              choices: [
                { id: "send", label: "Send request" },
                { id: "edit", label: "Change details" },
              ],
            },
            "Send the request or change details."
          ),
        ],
      };
    case "Stepper:complete":
      return {
        difficulty: "easy",
        ops: [
          say(
            "Nice, you're done. If the tunnel connects but local addresses don't load, check `AllowedIPs` includes your home subnet."
          ),
        ],
      };
    case "ProductGrid:open":
      return {
        difficulty: "easy",
        ops: [
          say(
            `The **${p.name}** is ${p.price} at ${p.store}. Prices change often, so check the listing before you buy.`
          ),
        ],
      };
    default:
      return null;
  }
}

/** Events that only change local state — no model turn needed. */
export function isSilentEvent(event: UiEventPart): boolean {
  return event.component === "MemoryConfirm" || event.action === "cancel_run";
}
