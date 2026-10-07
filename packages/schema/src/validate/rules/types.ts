import type { Finding } from "../../findings.js";
import type { DeckConfigDocument } from "../../types.js";
import type { Context } from "../context.js";

/** A pure semantic rule over a well-shaped config document. */
export type Rule = (doc: DeckConfigDocument, ctx: Context) => Finding[];
