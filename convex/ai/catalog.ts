/**
 * The kinds of card the router (Jev) chooses between when it reads a message. Replies draw every
 * card the model writes as an OpenUI app (./openui.ts); these names only say which shape of answer
 * fits, and data tools still draw Weather, MovieShowtimes and MapCard themselves.
 */

export const MODEL_COMPONENTS = [
  "MovieShowtimes",
  "MapCard",
  "Chart",
  "Table",
  "Compare",
  "Timeline",
  "Form",
  "Stepper",
  "Checklist",
  "ChoiceChips",
  "Weather",
  "ProductGrid",
  "Blocks",
] as const;

export type ModelComponent = (typeof MODEL_COMPONENTS)[number];

const descriptions: Record<ModelComponent, string> = {
  MovieShowtimes:
    "Movies playing nearby with showtimes per theatre. Prefer find_showtimes, which builds this for you.",
  MapCard: "A map with pinned places and a synced list. Use for 'near me' answers with 2+ places.",
  Chart:
    "A line chart. For savings/compound growth use model {type:'compound'} so the user can drag the contribution; otherwise give series points.",
  Table: "Tabular data with typed columns. Use for 4+ rows of structured values.",
  Compare:
    "Side-by-side comparison of 2-3 items with per-row winners and a verdict, and a photo per item when you have one.",
  Timeline: "Dated events in order (history, schedules, roadmaps); events can carry a photo.",
  Form: "Collect structured input from the user (booking details, preferences). Nothing is sent anywhere until they submit.",
  Stepper:
    "Step-by-step instructions the user follows in order (setup guides, recipes), with a photo for a step when it shows what to do.",
  Checklist: "Grouped checkable items (packing lists, to-dos).",
  ChoiceChips:
    "Tappable options for the user's next reply: clarifying questions or follow-up suggestions. Set multi for multi-select.",
  Weather:
    "Current conditions plus hourly and daily forecast. Prefer get_weather, which builds this for you.",
  Blocks:
    "A visual answer composed from blocks in reading order: plans, guides, breakdowns, explainers, and small tools the user asks for (scalers, splitters, calculators) where input blocks drive computed rows live on the phone. Headings, facts, items and steps can carry photos, and an images block shows a gallery. Bars draw magnitudes to scale, a quiz lets the user test themselves, cards turn over to reveal an answer, and a quote sets off a voice. Set accent to a colour that suits the subject. Blocks appear to the user as you write them, so put the most important one first. This card is the answer: at most one short sentence of text before it, none after.",
  ProductGrid:
    "Products the user can buy: real prices you found, each product's page url, and a photo url when you have one. Not for articles, sources or links.",
};

/** One line per card for routers choosing between them (Jev's card question). */
export function cardSummary(name: string): string {
  const d = descriptions[name as ModelComponent];
  return d ? `${name}: ${d.split(/(?<=\.)\s/)[0]}` : `The ${name} card.`;
}
