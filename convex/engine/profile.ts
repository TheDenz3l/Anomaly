import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { searchQueryFrom } from "../ai/decisions";
import type { Entity, EntityCard, EntityKind } from "../lib/validators";
import { entityCard } from "../web/entity";
import { photoFinder } from "../web/photos";
import type { Engine } from "./context";

/**
 * Profile chats: tapping a name marked in a reply ([[Isaiah Rashad|person|American rapper]]) opens
 * a sheet about it, written by the user's own model as the first reply of a hidden chat. The app
 * finds the sheet's photos and overview (web/entity.ts) while the model writes the sections under
 * them; questions asked in the sheet carry on in the same chat.
 */

/** A marked name: [[Name|kind|what it is]]. */
const MARK = /\[\[([^[\]|\n]{1,80})(?:\|[^[\]|\n]{0,120}){0,2}\]\]/g;

/** Marks reduced to their names, for text the app shows as written (card programs). */
export function plainNames(text: string): string {
  return text.replace(MARK, (_, name: string) => name.trim());
}

/** The hidden opening message of a profile chat. */
export function profileRequest(e: Entity, from?: string): string {
  const about = e.hint ? ` (${e.kind}: ${e.hint})` : "";
  const context = from && from !== "New chat" ? ` It came up in my chat "${from}".` : "";
  return `Tell me about ${e.name}${about}.${context}`;
}

/** The search the profile starts from: the name, narrowed by what it is. */
export function profileQuery(e: Entity): string {
  return `${e.name} ${e.hint.split(/\s+/).slice(0, 5).join(" ")}`.trim().slice(0, 200);
}

/** Words in a sheet's question that stand for its subject, which the query names instead. */
const STAND_INS = new Set("he him his she her hers they them their theirs it its".split(" "));

/**
 * The search for a question asked in a profile's sheet: "What is his latest film?" about Francis
 * Ford Coppola → "Francis Ford Coppola latest film".
 */
export function followUpQuery(e: Entity, text: string): string {
  const named = new Set(e.name.toLowerCase().split(/\s+/));
  const asked = searchQueryFrom(text)
    .split(/\s+/)
    .filter((w) => {
      const word = w.toLowerCase().replace(/'s$/, "");
      return !STAND_INS.has(word) && !named.has(word);
    });
  return `${e.name} ${asked.join(" ")}`.trim().slice(0, 200);
}

const SECTIONS: Record<EntityKind, string> = {
  person:
    "what they're known for, career highlights, notable work (a Carousel of their best-known works with a photo and year each), and anything current: a new release, a tour (dated shows from search results in a List, each with its venue and ticket link), a role, a game",
  place:
    "what it is and why people go, what to see or do (a Carousel or List with photos), getting there and around, the best time to go",
  organization: "what it does, its history, its key products or people, where it stands now",
  work: "what it is about, how it was made or who made it, its reception, where to watch, read, play or listen",
  product: "what it is, key specs, price and where to buy, how it compares with the alternatives",
  event: "what happened or will happen, when and where, who is involved, why it matters",
  thing: "what it is, how it works or came about, why it matters, related things worth knowing",
};

/**
 * What the profile's model is asked to write. The sheet already shows the name, a short
 * description and photos, and, when Wikipedia has an article, its overview as source [1].
 */
export function profileBrief(e: Entity, card: EntityCard | undefined, wikiSource: boolean): string {
  const lines = [
    "# Profile sheet",
    `The user tapped "${e.name}" in a reply. Your reply fills the profile sheet that opened; the sheet already shows the name, a short description and photos above your text.`,
  ];
  if (card?.extract && wikiSource) {
    lines.push(
      `It also shows this overview from Wikipedia, which is source [1]: "${card.extract}"`,
      "- Don't repeat the overview. Start straight with the first ### section."
    );
  } else {
    lines.push("- Open with a 2 to 3 sentence overview, no heading, then the sections.");
  }
  lines.push(
    `- Then 3 to 5 short ### sections that fit what it is; for this one: ${SECTIONS[e.kind]}. Skip a section you have nothing real for.`,
    "- Works, products and places with pictures go in a Carousel of Cards (title, photo phrase, the year or a short meta); dated events in a List. Only what search results or well-established facts support; never invent dates or listings.",
    `- Bold key titles, awards and names in the prose. Mark the people, works and places it is connected to with [[Name|kind|what it is]] so the user can keep exploring, once each; not ${e.name} itself, whose sheet this is.`,
    "- Write for the reader, about the subject: never mention the overview, the search results or what you were or weren't given. Leave out what you can't support rather than saying so.",
    "- Under 350 words of text. Cite with [n]. No greeting, no sign-off, no closing question or offer."
  );
  return lines.join("\n");
}

/** A short reminder for questions asked inside an open profile. */
export function profileNote(e: Entity): string {
  return `This chat is about ${e.name}${e.hint ? ` (${e.hint})` : ""}: the user is asking from its profile sheet. Answer about it directly and keep it brief, and don't mark ${e.name} itself as a name.`;
}

/**
 * The sheet's top for a profile chat: from the thread when an earlier reply already found it,
 * otherwise looked up now and saved, so the sheet shows it before the model's first words.
 * `article` settles as soon as the overview is known: the model needs that, not the photos, so it
 * starts while the photo search is still running. `saved` settles once the sheet has the card.
 */
export function profileCard(
  engine: Engine,
  threadId: Id<"threads">,
  e: Entity
): { article: Promise<EntityCard | undefined>; saved: Promise<void> } {
  if (e.card) return { article: Promise.resolve(e.card), saved: Promise.resolve() };
  let found: (card: EntityCard | undefined) => void = () => {};
  const article = new Promise<EntityCard | undefined>((resolve) => (found = resolve));
  const saved = (async () => {
    try {
      const card = await entityCard(engine.cache, photoFinder(engine.ctx, engine.search), e, found);
      found(card);
      await engine.ctx.runMutation(internal.entities.setCard, { threadId, card });
    } catch (err) {
      found(undefined);
      console.warn("profile lookup failed", (err as Error).message);
      await engine.ctx
        .runMutation(internal.entities.setCard, { threadId, card: { title: e.name, images: [] } })
        .catch(() => {});
    }
  })();
  return { article, saved };
}
