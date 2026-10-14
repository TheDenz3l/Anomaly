/**
 * Where the cards a tool draws (showtimes, a forecast) go in the reply. The tool runs before the
 * model writes a word, so drawn at once they'd sit above the answer's opening. Instead they wait
 * for the text the model writes next and follow the paragraph that introduces them: the first one
 * in the section about them ("### 3. Movie night", or a paragraph that opens on them in bold), the
 * opening paragraph when the reply has no sections, and otherwise the end. Either way they come
 * after words about them, so the model can always say "below".
 *
 * Text streams through as it comes; only the start of a line that may be a heading waits until
 * it's clear, and only while a card is waiting.
 */

export type Placed = { type: "text"; text: string } | { type: "card"; id: string };

/** What each card-drawing tool's cards are about, as a section heading would name it. */
export const CARD_TOPICS: Record<string, RegExp> = {
  find_showtimes: /movie|film|cinema|showtime|theat(?:er|re)|screening/i,
  get_weather: /weather|forecast|temperature|rain\b|climate/i,
};

type Held = { id: string; topic: RegExp };

export class CardPlacer {
  private held: Held[] = [];
  /** The start of the current line while it may still be a heading. */
  private pending = "";
  private deciding = false;
  private lineStart = true;
  /** Cards whose section has begun: they follow its first paragraph. */
  private afterParagraph: string[] = [];
  /** Cards whose bold-led paragraph is being written: they follow it. */
  private afterLine: string[] = [];
  /** The reply has sections, so a card waits for the one about it. */
  private sections = false;
  /** Any words in the reply yet: a heading before them is its title, not a section. */
  private textSeen = false;
  /** Words since the current section's heading. */
  private sectionText = false;
  /** Words since the cards were drawn, and whether a paragraph of them has ended. */
  private wrote = false;
  private paragraphEnded = false;
  private out: Placed[] = [];
  private buf = "";

  hold(id: string, topic: RegExp): void {
    if (!this.held.length) {
      this.wrote = false;
      this.paragraphEnded = false;
    }
    this.held.push({ id, topic });
  }

  push(text: string): Placed[] {
    for (const ch of text) this.char(ch);
    return this.drain();
  }

  /** A card the model wrote is about to start (it begins a new line). */
  beforeBlock(): Placed[] {
    this.settle();
    this.release(this.afterLine.splice(0));
    this.release(this.afterParagraph.splice(0));
    if (this.paragraphEnded && !this.sections) this.releaseAll();
    this.lineStart = true;
    this.wrote = true;
    return this.drain();
  }

  /** The reply is over: whatever is still waiting goes at the end. */
  finish(): Placed[] {
    this.settle();
    this.release(this.afterLine.splice(0));
    this.release(this.afterParagraph.splice(0));
    this.releaseAll();
    return this.drain();
  }

  private waiting(): boolean {
    return this.held.length + this.afterParagraph.length + this.afterLine.length > 0;
  }

  private char(ch: string) {
    if (this.deciding) {
      this.pending += ch;
      this.decide();
      return;
    }
    if (this.lineStart && this.waiting()) {
      this.deciding = true;
      this.pending = ch;
      this.decide();
      return;
    }
    if (this.lineStart && ch === "#" && this.textSeen) this.sections = true;
    this.buf += ch;
    if (ch === "\n") {
      this.lineStart = true;
      this.release(this.afterLine.splice(0));
    } else {
      this.lineStart = false;
      if (ch.trim()) this.textSeen = this.wrote = this.sectionText = true;
    }
  }

  /** Reads the line start so far: a heading, a bold lead, a blank line, plain text, or not yet clear. */
  private decide() {
    const line = this.pending;
    const t = line.trimStart();
    const ended = line.endsWith("\n");
    if (!t.trim()) {
      if (ended) this.blank();
      return;
    }
    if (t.startsWith("#")) {
      if (ended) this.heading(line);
      return;
    }
    if (t.startsWith("**")) {
      const close = t.indexOf("**", 2);
      if (close < 0) {
        if (ended) this.plain();
        return;
      }
      const rest = t.slice(close + 2).replace(/^[\s:.—-]*/, "");
      if (!rest) {
        // Only the bold words so far: a heading if the line ends here.
        if (ended) this.heading(line);
        return;
      }
      // A paragraph led by bold words: cards about them follow it.
      const lead = t.slice(2, close);
      if (!this.openingDone()) this.afterLine.push(...this.take((c) => c.topic.test(lead)));
      this.plain();
      return;
    }
    if (t === "*" && !ended) return;
    this.plain();
  }

  /** After the opening paragraph of a reply with no sections, waiting cards go before what's next. */
  private openingDone(): boolean {
    if (this.paragraphEnded && !this.sections && this.held.length) {
      this.releaseAll();
      return true;
    }
    return false;
  }

  private blank() {
    if (this.wrote) this.paragraphEnded = true;
    this.emitLine(true);
    // The section's first paragraph is done: its cards come next.
    if (this.sectionText) this.release(this.afterParagraph.splice(0));
  }

  private plain() {
    this.openingDone();
    this.textSeen = this.wrote = this.sectionText = true;
    this.emitLine(false);
  }

  private heading(line: string) {
    // A section with no paragraph yet still keeps its cards: they go before the next heading.
    this.release(this.afterParagraph.splice(0));
    const title = !this.textSeen && !/^\s*(#+|\*\*)\s*(\d|part\b)/i.test(line);
    if (!title) this.sections = true;
    // A heading isn't a paragraph: the opening paragraph is still to come after a title.
    this.textSeen = true;
    this.sectionText = false;
    this.emitLine(true);
    this.afterParagraph.push(...this.take((c) => c.topic.test(line)));
  }

  /** Writes the line start out and goes back to streaming. */
  private emitLine(ended: boolean) {
    this.buf += this.pending;
    this.pending = "";
    this.deciding = false;
    this.lineStart = ended;
    if (ended) this.release(this.afterLine.splice(0));
  }

  /** A line start still being read is written out as it is. */
  private settle() {
    if (!this.deciding) return;
    this.buf += this.pending;
    this.pending = "";
    this.deciding = false;
  }

  private take(match: (c: Held) => boolean): string[] {
    const hit = this.held.filter(match);
    this.held = this.held.filter((c) => !hit.includes(c));
    return hit.map((c) => c.id);
  }

  private releaseAll() {
    this.release(this.take(() => true));
  }

  private release(ids: string[]) {
    if (!ids.length) return;
    if (this.buf) this.out.push({ type: "text", text: this.buf });
    this.buf = "";
    for (const id of ids) this.out.push({ type: "card", id });
  }

  private drain(): Placed[] {
    if (this.buf) this.out.push({ type: "text", text: this.buf });
    this.buf = "";
    return this.out.splice(0);
  }
}
