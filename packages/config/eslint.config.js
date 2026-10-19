// @ts-check
import { node } from "./eslint/node.js";

/** Fixtures contain deliberate violations and are linted only by the tests. */
export default [{ ignores: ["test/fixtures/**"] }, ...node({ root: import.meta.dirname })];
