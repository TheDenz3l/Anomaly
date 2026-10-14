import {
  createLibrary,
  defineComponent,
  markReactive,
  tagSchemaId,
  type DefinedComponent,
  type Library,
} from "@openuidev/lang-core";
import { z } from "zod";

/**
 * The OpenUI component library. The model writes OpenUI Lang (openui.com) in a ```openui block:
 * one `name = Component(args…)` statement per line, arguments positional in the order the props are
 * declared here. The server builds the model's prompt from these definitions (convex/ai/openui.ts)
 * and the app attaches a native renderer to each (./components.tsx), so this file holds no React
 * Native code.
 */

/** A photo: a web URL from tool results, or a short phrase naming what it shows (the server finds one). */
const photo = z.string();
/** A prop the user can change: written as a `$variable` so expressions elsewhere follow it. */
const bound = <T extends z.ZodType>(schema: T): T => {
  markReactive(schema);
  return schema;
};
/** What a tap does: `Action([@ToAssistant("…")])`, `Action([@Set($v, …)])`, `Action([@OpenUrl("…")])`. */
const action = z.any();
tagSchemaId(action, "ActionExpression");
const children = z.array(z.any());

export const OPENUI_ACCENTS = [
  "sand",
  "ocean",
  "forest",
  "citrus",
  "violet",
  "rose",
  "steel",
] as const;

const def = <T extends z.ZodObject>(name: string, props: T, description: string) =>
  defineComponent({ name, props, description, component: null as unknown });

/* Sub-components: drawn by the component that lists them. */

const Stat = def(
  "Stat",
  z.object({ value: z.string(), label: z.string(), note: z.string().optional() }),
  "One figure as shown ('~2.3M', '146 m'), what it counts, an optional short note."
);
const Fact = def("Fact", z.object({ label: z.string(), value: z.string() }), "One labelled fact.");
const Step = def(
  "Step",
  z.object({
    title: z.string(),
    detail: z.string().optional(),
    when: z.string().optional(),
    image: photo.optional(),
  }),
  "One step: title, detail, an optional time or stage ('Day 2', '2560 BCE'), optional photo."
);
const Bar = def(
  "Bar",
  z.object({
    label: z.string(),
    value: z.number(),
    display: z.string().optional(),
    note: z.string().optional(),
  }),
  "One bar: label, numeric value drawn to scale, the value as shown, a note revealed on tap."
);
const Flip = def(
  "Flip",
  z.object({ front: z.string(), back: z.string() }),
  "A card the user turns over: term and meaning, myth and fact, question and answer."
);
const Card = def(
  "Card",
  z.object({
    title: z.string(),
    body: z.string().optional(),
    image: photo.optional(),
    meta: z.string().optional(),
    action: action.optional(),
  }),
  "A tappable media card: title, short body, photo, a small meta tag (date, price, size). Without an action, tapping asks the assistant about it."
);
const Tab = def(
  "Tab",
  z.object({ label: z.string(), children }),
  "One tab: a short label and the components it shows."
);
const Button = def(
  "Button",
  z.object({
    label: z.string(),
    action: action.optional(),
    style: z.enum(["primary", "secondary"]).optional(),
  }),
  "A button. Without an action it sends its label to the assistant as the user's next message."
);
const Series = def(
  "Series",
  z.object({ name: z.string(), points: z.array(z.array(z.number())) }),
  "One line: its name and [x, y] points in order, like [[2020, 4.1], [2021, 4.7]]."
);
const Item = def(
  "Item",
  z.object({ name: z.string(), subtitle: z.string().optional(), image: photo.optional() }),
  "One option being compared: a few words, a subtitle, a photo."
);
const Row = def(
  "Row",
  z.object({ label: z.string(), values: z.array(z.string()), winner: z.number().optional() }),
  "One compared quality: a short phrase per item in item order, and the index of the item that wins it."
);
const Place = def(
  "Place",
  z.object({
    name: z.string(),
    lat: z.number(),
    lng: z.number(),
    note: z.string().optional(),
  }),
  "A pin: name, coordinates, a short note (address, distance, why go)."
);
const Product = def(
  "Product",
  z.object({
    name: z.string(),
    price: z.number(),
    currency: z.string(),
    store: z.string(),
    url: z.string().optional(),
    image: photo.optional(),
    brand: z.string().optional(),
    rating: z.number().optional(),
  }),
  'Something to buy: name, the real price found, its currency as an ISO code ("USD", "EUR", "GBP", "JPY"), store, its page url, a photo url, brand, 0-5 rating.'
);

const Entry = def(
  "Entry",
  z.object({
    title: z.string(),
    body: z.string().optional(),
    image: photo.optional(),
    meta: z.string().optional(),
    badge: z.string().optional(),
    url: z.string().optional(),
    link: z.string().optional(),
  }),
  "One pick: its name, a sentence or two on why, a photo, a meta line (date · venue, neighbourhood, price, hours), a badge of a word or two ('Must-see', 'Free'), its page url from search results, and that link's label ('Tickets', 'Menu')."
);

const Root = def(
  "Root",
  z.object({ children, accent: z.enum(OPENUI_ACCENTS).optional() }),
  "The answer. accent colours it for the subject: sand (history, architecture, deserts), ocean (travel, sea, space, science), forest (nature, health, food), citrus (money, energy, sport), violet (music, art, culture), rose (people, fashion), steel (tech)."
);

export const OPENUI_COMPONENTS = [
  Root,
  def(
    "Hero",
    z.object({ title: z.string(), subtitle: z.string().optional(), image: photo.optional() }),
    "Full-width cover photo with the title over it. Opens an answer about something you can picture."
  ),
  def("Text", z.object({ markdown: z.string() }), "Markdown paragraphs, **bold**, lists, links."),
  def(
    "Image",
    z.object({ image: photo, caption: z.string().optional() }),
    "One large photo with a caption."
  ),
  def(
    "Screenshot",
    z.object({ url: z.string(), caption: z.string().optional() }),
    "A live screenshot of a web page: what a site, app or product page looks like now. url is the page's address, from search results or the user."
  ),
  def(
    "Gallery",
    z.object({ images: z.array(photo), title: z.string().optional() }),
    "A swipeable strip of 3 to 8 photos, each a URL or a phrase naming a different thing to show."
  ),
  def(
    "List",
    z.object({
      items: z.array(Entry.ref),
      title: z.string().optional(),
      numbered: z.boolean().optional(),
    }),
    "Picks the user reads through, each with its photo on the left and its name and a sentence or two beside it: places to go, events with dates and venues, restaurants, artists, shows, books. title only when no heading of yours already names it; numbered for a ranked or ordered list."
  ),
  Entry,
  def("Stats", z.object({ items: z.array(Stat.ref) }), "Up to 4 headline figures."),
  Stat,
  def(
    "Facts",
    z.object({ items: z.array(Fact.ref), title: z.string().optional() }),
    "Labelled facts, like a spec sheet or an evidence list."
  ),
  Fact,
  def(
    "Steps",
    z.object({
      steps: z.array(Step.ref),
      title: z.string().optional(),
      checkable: z.boolean().optional(),
    }),
    "Steps in order: a process, a method, a timeline, an itinerary. checkable for lists the user ticks off (packing, to-dos)."
  ),
  Step,
  def(
    "Bars",
    z.object({
      items: z.array(Bar.ref),
      title: z.string().optional(),
      unit: z.string().optional(),
    }),
    "Magnitudes compared to scale: sizes, counts, prices."
  ),
  Bar,
  def(
    "Table",
    z.object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.any())),
      title: z.string().optional(),
    }),
    "Rows of values in columns, for 4+ rows of structured data. rows lists each row's cells in column order; numbers sort and align as numbers."
  ),
  def(
    "Chart",
    z.object({
      series: z.array(Series.ref),
      title: z.string(),
      unit: z.enum(["number", "currency", "percent"]).optional(),
      xLabel: z.string().optional(),
    }),
    "A line chart of one or more series over x: growth, prices, a trend. Each series needs 2+ points."
  ),
  Series,
  def(
    "Compare",
    z.object({
      items: z.array(Item.ref),
      rows: z.array(Row.ref),
      verdict: z.string().optional(),
      title: z.string().optional(),
    }),
    "2 or 3 options side by side, quality by quality, with a winner per row and a verdict."
  ),
  Item,
  Row,
  def(
    "Map",
    z.object({
      places: z.array(z.any()),
      title: z.string().optional(),
      center: z.any().optional(),
    }),
    "A map with pins and a synced list: Place components, or `p.places` from a places Query (pass its `p.center` as center)."
  ),
  Place,
  def(
    "Products",
    z.object({ items: z.array(Product.ref), title: z.string().optional() }),
    "Things the user can buy, with real prices from search results. Not for articles or sources."
  ),
  Product,
  def(
    "Weather",
    z.object({ data: z.any() }),
    "The live forecast card (now, hourly, 7 days). Pass a weather Query: Weather(w)."
  ),
  def(
    "Callout",
    z.object({ text: z.string(), tone: z.enum(["tip", "note", "warning"]).optional() }),
    "A boxed short answer, tip or warning."
  ),
  def(
    "Quote",
    z.object({ text: z.string(), cite: z.string().optional() }),
    "A voice worth hearing."
  ),
  def(
    "Quiz",
    z.object({
      question: z.string(),
      choices: z.array(z.string()),
      answer: z.number(),
      explanation: z.string().optional(),
    }),
    "A question the user answers by tapping. answer is the index of the right choice."
  ),
  def(
    "FlipCards",
    z.object({ cards: z.array(Flip.ref), title: z.string().optional() }),
    "A swipeable row of cards the user taps to turn over."
  ),
  Flip,
  def(
    "Carousel",
    z.object({ cards: z.array(Card.ref), title: z.string().optional() }),
    "A swipeable row of media cards: places, eras, options, people, results."
  ),
  Card,
  def("Grid", z.object({ children }), "Lays its children out two per row."),
  def(
    "Tabs",
    z.object({ tabs: z.array(Tab.ref) }),
    "Parallel views the user switches between with a segmented control (2 to 4 tabs)."
  ),
  Tab,
  def(
    "Section",
    z.object({ title: z.string(), children, open: z.boolean().optional() }),
    "A collapsible section: the title shows, the user taps to open it. For depth most readers skip."
  ),
  def(
    "Choice",
    z.object({
      value: bound(z.string()),
      options: z.array(z.string()),
      label: z.string().optional(),
    }),
    'Picks one option into a $variable (chips for short options, a list for longer ones); show different components with `$v == "x" ? a : b`, or pass it to a Query.'
  ),
  def(
    "Checks",
    z.object({
      value: bound(z.string()),
      options: z.array(z.string()),
      label: z.string().optional(),
      note: z.string().optional(),
    }),
    'A checklist the user picks any number of options from; its $variable holds the picked ones joined with ", " ("Jazz, Rock"), "" for none.'
  ),
  def(
    "Dates",
    z.object({
      start: bound(z.string()),
      end: bound(z.string()),
      label: z.string().optional(),
    }),
    'A date range the user picks on a calendar (travel dates, a stay), into two $variables as "2026-10-12", "" until picked.'
  ),
  def(
    "Form",
    z.object({ title: z.string(), children, note: z.string().optional() }),
    "What you need from the user to go further, in one box: fields (Dates, Checks, Choice, Input) and last a primary Button whose @ToAssistant sends their answers. It ends a reply that already gave its best answer."
  ),
  def(
    "Slider",
    z.object({
      value: bound(z.number()),
      min: z.number(),
      max: z.number(),
      step: z.number().optional(),
      label: z.string().optional(),
      unit: z.string().optional(),
    }),
    "A slider bound to a number $variable that expressions elsewhere use."
  ),
  def(
    "Toggle",
    z.object({ value: bound(z.boolean()), label: z.string() }),
    "An on/off switch bound to a boolean $variable."
  ),
  def(
    "Input",
    z.object({
      value: bound(z.string()),
      label: z.string().optional(),
      placeholder: z.string().optional(),
    }),
    'A text field bound to a $variable, for details a Button then sends: Button("Book", Action([@ToAssistant("Book a table for " + $name)])).'
  ),
  def(
    "Value",
    z.object({ label: z.string(), value: z.any(), note: z.string().optional() }),
    'A large live figure, usually an expression over $variables: Value("Per person", "$" + @Round($total / $people, 2)).'
  ),
  def(
    "Buttons",
    z.object({ buttons: z.array(Button.ref) }),
    "A row of buttons, typically 2 or 3 follow-ups that continue the conversation."
  ),
  Button,
] as DefinedComponent[];

export type OpenUIComponentName =
  | "Root"
  | "Hero"
  | "Text"
  | "Image"
  | "Screenshot"
  | "Gallery"
  | "List"
  | "Entry"
  | "Stats"
  | "Stat"
  | "Facts"
  | "Fact"
  | "Steps"
  | "Step"
  | "Bars"
  | "Bar"
  | "Table"
  | "Chart"
  | "Series"
  | "Compare"
  | "Item"
  | "Row"
  | "Map"
  | "Place"
  | "Products"
  | "Product"
  | "Weather"
  | "Callout"
  | "Quote"
  | "Quiz"
  | "FlipCards"
  | "Flip"
  | "Carousel"
  | "Card"
  | "Grid"
  | "Tabs"
  | "Tab"
  | "Section"
  | "Choice"
  | "Checks"
  | "Dates"
  | "Form"
  | "Slider"
  | "Toggle"
  | "Input"
  | "Value"
  | "Buttons"
  | "Button";

/** Props that hold photos, per component: a phrase there is looked up by the server (convex/web/photos.ts). */
export const PHOTO_PROPS: Partial<Record<OpenUIComponentName, string[]>> = {
  Hero: ["image"],
  Image: ["image"],
  Gallery: ["images"],
  Step: ["image"],
  Card: ["image"],
  Item: ["image"],
  Product: ["image"],
  Entry: ["image"],
};

/** The library with a renderer on each component; null renderers serve prompt building and parsing. */
export function openuiLibrary<C>(renderers?: Partial<Record<OpenUIComponentName, C>>): Library<C> {
  return createLibrary<C>({
    root: "Root",
    components: OPENUI_COMPONENTS.map((c) => ({
      ...c,
      component: (renderers?.[c.name as OpenUIComponentName] ?? null) as C,
    })),
  });
}

/** The opening of an OpenUI block in a reply; the language tag may be written openui-lang. */
export const OPENUI_FENCE = "```openui";

/** The program inside a fence body: drops the "-lang" of an openui-lang tag. */
export function openuiSource(body: string): string {
  return body.replace(/^-lang\b/, "").replace(/^[^\n]*\n/, (first) => (first.trim() ? first : ""));
}

/** A photo prop's value as written: a web URL to show as is, or a phrase to look up. */
export const isPhotoUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

/** What the server found for each photo phrase in a card; null when nothing fit. */
export type PhotoPick = { q: string; url: string | null };
