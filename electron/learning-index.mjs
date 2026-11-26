import { readingScope, studySearchSnapshot } from "./reading-store.mjs";
import { learningSearchTerms, matchLearningScraps } from "../shared/learning-search.mjs";

export async function searchLearning(store, id, query) {
  const terms = learningSearchTerms(query);
  if (!terms.length) return [];
  const { root, current } = await readingScope(store, id);
  const entries = await studySearchSnapshot(root);
  return current() ? matchLearningScraps(entries, terms) : [];
}
