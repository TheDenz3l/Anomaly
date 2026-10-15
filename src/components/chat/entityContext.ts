import { createContext, useContext } from "react";
import type { EntityRef } from "@/lib/entities";

/**
 * Opens the profile sheet for a name marked in a reply. Provided by the chat screen and by the
 * sheet itself (a name tapped inside a profile opens the next one); without it names are plain text.
 */
export const EntityOpener = createContext<((entity: EntityRef) => void) | null>(null);

export const useEntityOpener = () => useContext(EntityOpener);

/**
 * Where a card's "ask the assistant" taps go. Inside a profile sheet they're questions about it,
 * asked in the sheet; elsewhere they're the user's next message in the chat.
 */
export const AskTarget = createContext<((message: string) => void) | null>(null);
