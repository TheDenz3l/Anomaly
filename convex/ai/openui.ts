import { createParser, mergeStatements, type ElementNode } from "@openuidev/lang-core";
import {
  isPhotoUrl,
  openuiLibrary,
  openuiSource,
  PHOTO_PROPS,
  type OpenUIComponentName,
  type PhotoPick,
} from "../../src/genui/openui/library";
import type { PhotoFinder, PhotoKind } from "../web/photos";
import { OPENUI_TOOLS } from "./openuiTools";

/**
 * Cards: the model writes one ```openui block of OpenUI Lang (openui.com) in its reply, and the app
 * draws it with native components as it streams (src/genui/openui). The prompt comes from the
 * shared component library; this file also reads the blocks as they stream, merges edits into the
 * card they change, and finds photos for the phrases a card names.
 */

const library = openuiLibrary();

const PREAMBLE = [
  "You can answer with a small native app inside the reply, written in openui-lang: a compact, line-based UI language, not JSON.",
  "Write it in a ```openui fenced block on its own lines. Text before or after the block shows above or below it; keep that to a sentence at most.",
  "Only the components listed below exist. Never write HTML, JSX, JSON or code to draw UI.",
].join("\n");

const EXAMPLES = [
  `Example — an explainer (history, science, how something works):
\`\`\`openui
root = Root([hero, short, stats, eras, method, quiz, more], "sand")
hero = Hero("Rome's Aqueducts", "Gravity, stone and a very gentle slope", "Pont du Gard aqueduct")
short = Callout("Water flowed downhill the whole way, dropping about 34 cm per km, through channels of stone and concrete.", "note")
stats = Stats([Stat("11", "Aqueducts", "Supplying Rome"), Stat("~1M m³", "Water per day"), Stat("500 yrs", "Building span")])
eras = Carousel([Card("Aqua Appia", "Rome's first, mostly underground.", "Aqua Appia", "312 BCE"), Card("Pont du Gard", "Three tiers carrying water over the Gardon.", "Pont du Gard", "50 CE"), Card("Aqua Claudia", "Arches still standing across the Campagna.", "Aqua Claudia arches", "52 CE")], "Landmarks")
method = Tabs([Tab("Survey", [s1]), Tab("Build", [s2]), Tab("Maintain", [s3])])
s1 = Steps([Step("Find a source", "Springs in the hills above the city"), Step("Set the gradient", "Surveyors used the chorobates, a water level")])
s2 = Steps([Step("Cut the channel", "Mostly underground, lined with waterproof mortar"), Step("Bridge the valleys", "Arcades where the ground dropped away", null, "Roman aqueduct arches")])
s3 = Text("Crews scraped out **calcium deposits** and patched leaks; some channels needed clearing every few years.")
quiz = Quiz("How did the water move?", ["Pumps", "Gravity", "Slaves carrying jars"], 1, "Only gravity: every aqueduct sloped gently downhill.")
more = Buttons([Button("How were they surveyed?"), Button("Which still work today?")])
\`\`\``,
  `Example — a live tool (calculators, splitters, planners): $variables update on the phone without asking you again.
\`\`\`openui
root = Root([people, tip, each, note], "citrus")
$people = 4
$tip = 18
people = Slider($people, 1, 12, 1, "People")
tip = Choice($tip, ["15", "18", "20", "25"], "Tip %")
each = Value("Each person pays", "$" + @Round(180 * (1 + $tip / 100) / $people, 2), "On a $180 bill")
note = Callout("Tipping on the pre-tax amount is the norm in most US restaurants.", "tip")
\`\`\``,
  `Example — live data the card fetches itself (weather, places near somewhere, web results), again whenever the user changes a $variable it uses:
\`\`\`openui
root = Root([hero, pick, wx, food, more], "ocean")
$city = "Lisbon"
hero = Hero("A Weekend on the Coast", "Pick a city to see its forecast and where to eat", "Lisbon waterfront")
pick = Choice($city, ["Lisbon", "Porto", "Faro"], "City")
w = Query("weather", {location: $city}, null)
wx = Weather(w)
p = Query("places", {kind: "restaurant", near: $city, limit: 6}, {center: null, places: []})
food = Map(p.places, "Places to eat", p.center)
more = Buttons([Button("Plan a day in " + $city)])
\`\`\``,
];

const RULES = [
  'Photos: an image argument takes an image URL from tool results, or a short, specific phrase naming what the picture shows ("Bent Pyramid Dahshur", "Rosetta Stone", "Monarch butterfly"). The app finds a real photo for a phrase, so use phrases for concrete, well-known things, a different one for each picture; never invent an image URL. Skip photos for abstract ideas. The app never repeats a photo the chat already showed, so a follow-up card gets fresh ones.',
  "Screenshots: when the user wants to see a website, app or page (a pricing page, a store listing, a new site design), use Screenshot(url) with the page's real address, from search results, the user, or a well-known homepage. The app captures it live.",
  "Open with a Hero when the subject is something you can picture, then the short answer, then the parts. Mix components to suit the content instead of the same few every time.",
  "Make it interactive where that helps the user: Tabs or a Choice for parallel views, a Quiz or FlipCards when they're learning, Section for depth most readers skip, Slider/Choice/Toggle/Input with Value for anything they'd tweak, a Query for anything live. End explainers and plans with Buttons offering 2 or 3 natural follow-ups.",
  "It shows on a phone about 360 points wide: titles under 40 characters, labels a few words, card bodies one or two short sentences. Long explanations belong in Text.",
  'Strings use double quotes; escape a double quote inside a string as \\". Pass null for an optional argument you skip before one you give.',
];

const LIVE_DATA = [
  "## Live data",
  "",
  'A card can fetch live data on the phone: `name = Query("tool", {args}, defaults)` runs when the card shows and again whenever a $variable in its args changes, without asking you. Read results with dot access (w.now.tempC, p.places) and lists with @Each. Use a Query when the data is live or follows the user\'s choice; otherwise write what you know. Tools:',
  ...Object.entries(OPENUI_TOOLS).map(([, t]) => `- ${t.doc}`),
].join("\n");

const EDITS = [
  "## Changing your last card",
  "",
  "When the user asks to change the card you showed last (add, remove, swap or fix something in it), don't rewrite it: write a ```openui-edit block holding only the statements that change or are new, with the same names as before. The app merges them into that card and shows the result. To add a component, re-declare its parent with the new child in its list and define the child; to remove one, re-declare the parent without it. A new or unrelated card is a normal ```openui block starting with root = Root(...).",
].join("\n");

let prompt: string | null = null;

/** The model's instructions for writing cards. */
export function openuiCatalog(): string {
  prompt ??= [
    library.prompt({
      preamble: PREAMBLE,
      bindings: true,
      toolCalls: false,
      examples: EXAMPLES,
      additionalRules: RULES,
    }),
    LIVE_DATA,
    EDITS,
  ].join("\n\n");
  return prompt;
}

/** OpenUI components that present one shape of answer better than a composed card (router hint). */
const EXACT: Record<string, string> = {
  Compare: "a Compare",
  Chart: "a Chart",
  Table: "a Table",
  MapCard: "a Map",
  ProductGrid: "Products",
  Timeline: "Steps with a date on each",
  Checklist: "checkable Steps",
  Stepper: "Steps",
  Form: "Input fields and a Button that sends them",
};

/** Steers one reply toward a card, built around a specific component when the router is sure of it. */
export function openuiDirective(kind: "visual" | "tool", exact?: string): string {
  const around = exact && EXACT[exact] ? ` Build it around ${EXACT[exact]}.` : "";
  return kind === "visual"
    ? `Present this answer as an OpenUI app (one \`\`\`openui block): open with the key point, then the parts the content calls for, with photos and something to tap where they help.${around} Write at most one sentence outside the block.`
    : `Present this answer as an OpenUI app (one \`\`\`openui block) that works as a small live tool: $variables for what the user would adjust (prefilled with theirs), Value components for the results.${around} Write at most one sentence outside the block.`;
}

export const OPENUI_ANSWER_NOTE =
  "When you answer from these results: if they are products, places, things to compare or dated events, show them in an OpenUI app (one ```openui block) with photos from the results, and your text around it.";

let parser: ReturnType<typeof createParser> | null = null;
const parse = (source: string) => {
  parser ??= createParser(library.toJSONSchema(), "Root");
  return parser.parse(source);
};

/** An ```openui-edit block: statements to merge into the last card rather than a card of its own. */
export const isEdit = (body: string) => /^-edit\b/.test(body);

/** Checks a finished program: what renders, why nothing does, and a sentence for voice. */
export function readOpenUI(
  body: string
):
  | { ok: true; source: string; fallbackText: string; issues: string[] }
  | { ok: false; error: string } {
  return readProgram(openuiSource(body.replace(/^-edit\b/, "")).trim());
}

function readProgram(
  source: string
):
  | { ok: true; source: string; fallbackText: string; issues: string[] }
  | { ok: false; error: string } {
  if (!source) return { ok: false, error: "empty openui block" };
  let result;
  try {
    result = parse(source);
  } catch (err) {
    return { ok: false, error: `openui parse failed: ${String(err).slice(0, 200)}` };
  }
  const issues = result.meta.errors.map((e) => `${e.component}${e.path}: ${e.message}`);
  if (!result.root) return { ok: false, error: issues[0] ?? "no root = Root(...) statement" };
  return { ok: true, source, fallbackText: fallbackOf(result.root), issues };
}

/** The first plain statement in the answer, for voice and text-only clients. */
function fallbackOf(root: ElementNode): string {
  let found = "";
  const walk = (v: unknown) => {
    if (found || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const el = v as ElementNode;
    if (el.type !== "element") return;
    const p = el.props;
    if (el.typeName === "Callout" && typeof p.text === "string") found = p.text;
    else if (el.typeName === "Text" && typeof p.markdown === "string") found = p.markdown;
    else Object.values(p).forEach(walk);
  };
  walk(root);
  if (!found && Array.isArray(root.props.children)) {
    const hero = (root.props.children as ElementNode[]).find((c) => c?.typeName === "Hero");
    found = [hero?.props.title, hero?.props.subtitle].filter(Boolean).join(": ");
  }
  return found.replace(/\*\*/g, "").slice(0, 400) || "Interactive answer shown.";
}

/** Whether a card ends with its own follow-up buttons (the turn then adds no chips of its own). */
export const hasFollowUps = (source: string) => /=\s*Buttons\(/.test(source);

/** The photo key a screenshot of a page goes by, so the app can tell it from the page link. */
export const screenshotKey = (url: string) => `screenshot:${url.trim()}`;

/**
 * One card as its block streams: the program so far (merged into the card it edits, for an
 * ```openui-edit block), and photos for the phrases it names. Photos are looked up as soon as the
 * statement naming them is complete and handed out in the order the card names them, so no photo
 * shows twice, and none the chat has already shown (`seen`) shows again, except a product's own
 * photo and, in an edit, the photos the card already had. `onPhotos` fires as each one is settled.
 */
export class OpenUICard {
  private picks = new Map<string, string | null>();
  private order: string[] = [];
  private used: Set<string>;
  private kept: Map<string, string | null>;
  private chain: Promise<void> = Promise.resolve();
  private edit: boolean | null = null;
  source = "";

  constructor(
    private readonly o: {
      /** The last card in the chat, which an edit changes. */
      base?: { source: string; photos?: PhotoPick[] };
      findPhotos?: PhotoFinder;
      /** Photos the chat has already shown. */
      seen?: Set<string>;
      onPhotos?: () => void;
    } = {}
  ) {
    this.used = new Set(o.seen);
    this.kept = new Map((o.base?.photos ?? []).map((p) => [p.q, p.url]));
  }

  /** The program so far, with the photos of its finished statements on their way. */
  update(body: string): string {
    // The fence's tag line says whether this is an edit; it's settled once that line ends.
    const edit = this.edit ?? isEdit(body);
    if (body.includes("\n")) this.edit = edit;
    const raw = openuiSource(body.replace(/^-edit\b/, ""));
    this.source = edit && this.o.base ? merge(this.o.base.source, raw) : raw;
    this.collect(false);
    return this.source;
  }

  /** The finished card, checked; every photo it names is now being looked up. */
  finish(body: string): ReturnType<typeof readOpenUI> {
    this.update(body);
    this.collect(true);
    return readProgram(this.source.trim());
  }

  photos(): PhotoPick[] {
    return this.order.filter((q) => this.picks.has(q)).map((q) => ({ q, url: this.picks.get(q)! }));
  }

  /** Resolves once every photo asked for so far is settled. */
  settled(): Promise<void> {
    return this.chain;
  }

  private collect(all: boolean) {
    let root: ElementNode | null = null;
    try {
      root = parse(this.source).root;
    } catch {
      return;
    }
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach(walk);
      const el = v as ElementNode;
      if (el.type !== "element") return;
      // A statement still being written may hold half a phrase.
      if (all || !el.partial) {
        if (el.typeName === "Screenshot" && typeof el.props.url === "string")
          this.want(el.props.url, "screenshot");
        for (const prop of PHOTO_PROPS[el.typeName as OpenUIComponentName] ?? []) {
          const val = el.props[prop];
          for (const s of Array.isArray(val) ? val : [val])
            if (typeof s === "string")
              this.want(s, isProduct(el.typeName, this.source) ? "product" : "photo");
        }
      }
      Object.values(el.props).forEach(walk);
    };
    walk(root);
  }

  private want(src: string, kind: PhotoKind) {
    const phrase = kind === "screenshot" ? screenshotKey(src) : src.trim();
    if (!src.trim() || this.order.includes(phrase)) return;
    this.order.push(phrase);
    // A product is pictured by its own photo however often it comes up.
    const fresh = (u: string) => kind === "product" || !this.used.has(u);
    // In an edit, what the card showed before stays as it was.
    if (this.kept.has(phrase)) {
      this.picks.set(phrase, this.kept.get(phrase)!);
      this.o.onPhotos?.();
      return;
    }
    if (isPhotoUrl(phrase)) {
      this.picks.set(phrase, fresh(phrase) ? phrase : null);
      this.used.add(phrase);
      return;
    }
    const find = this.o.findPhotos;
    const found = find
      ? find(kind === "screenshot" ? src.trim() : phrase, { kind }).catch(() => [] as string[])
      : Promise.resolve([] as string[]);
    this.chain = this.chain.then(async () => {
      const pick = (await found).find(fresh) ?? null;
      if (pick) this.used.add(pick);
      this.picks.set(phrase, pick);
      this.o.onPhotos?.();
    });
  }
}

/** A photo of something to buy: a Product, or a compared item in a card that sells things. */
const isProduct = (component: string, source: string) =>
  component === "Product" || (component === "Item" && /=\s*Products\(/.test(source));

/** An edit merged into the card it changes; the edit alone when the two can't be merged. */
function merge(base: string, patch: string): string {
  try {
    return mergeStatements(base, patch, "root");
  } catch {
    return patch;
  }
}
