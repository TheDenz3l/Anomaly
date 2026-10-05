import { EMBEDDING_DIMENSIONS } from "../schema";

/** Zero-pads (cosine-preserving) or truncates a vector to the index width. */
export function fitVector(vec: number[]): number[] {
  if (vec.length === EMBEDDING_DIMENSIONS) return vec;
  if (vec.length > EMBEDDING_DIMENSIONS) return vec.slice(0, EMBEDDING_DIMENSIONS);
  return [...vec, ...new Array<number>(EMBEDDING_DIMENSIONS - vec.length).fill(0)];
}
