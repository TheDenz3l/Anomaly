import type { Memory } from "@/lib/types";

const DAY = 86_400_000;
const now = Date.now();

export const seedMemories: Memory[] = [
  {
    id: "mem_1",
    text: "Lives in Toronto, near Queen & Spadina",
    category: "place",
    scope: "global",
    confidence: 0.96,
    createdAt: now - 12 * DAY,
  },
  {
    id: "mem_2",
    text: "Prefers metric units",
    category: "preference",
    scope: "global",
    confidence: 0.91,
    createdAt: now - 20 * DAY,
  },
  {
    id: "mem_3",
    text: "Commutes by bike most of the year",
    category: "fact",
    scope: "global",
    confidence: 0.84,
    createdAt: now - 2 * DAY,
  },
  {
    id: "mem_4",
    text: "Partner's name is Sam; birthday in March",
    category: "person",
    scope: "global",
    confidence: 0.88,
    createdAt: now - 31 * DAY,
  },
  {
    id: "mem_5",
    text: "Building Anomaly, a generative-UI chat app on Expo and Convex",
    category: "work",
    scope: "global",
    confidence: 0.93,
    createdAt: now - 4 * DAY,
  },
  {
    id: "mem_6",
    text: "Budget for an e-bike is under $2,000",
    category: "preference",
    scope: "thread",
    confidence: 0.78,
    createdAt: now - 2 * DAY,
  },
  {
    id: "mem_7",
    text: "Prefers aisle seats and late showings",
    category: "preference",
    scope: "global",
    confidence: 0.74,
    createdAt: now - 1 * DAY,
  },
];
