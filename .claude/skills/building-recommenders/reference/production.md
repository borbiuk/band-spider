# Production systems

## Contents
- Multi-stage architecture
- Candidate generation
- Ranking
- Re-ranking: business rules, diversity, freshness
- Feedback loops and biased logs
- Serving and freshness of the model
- Monitoring
- Start-small checklist

## Multi-stage architecture

Use stages only when one model cannot score the whole catalog within the latency budget,
or when several signals must be combined.

1. Candidate generation (retrieval): several cheap sources each return hundreds to a few
   thousand items. Examples: item-kNN on recent items, ALS or two-tower nearest
   neighbours, popular-in-segment, fresh items, items from followed creators.
2. Ranking (scoring): one model with richer features scores the union of candidates.
   Candidate scores from different sources are not comparable, so do not merge lists by
   raw score.
3. Re-ranking: rules and list-level goals (filters, diversity, freshness, business
   constraints) produce the final page.

For a small catalog (a few thousand items) a single model that scores every item is
simpler and often enough.

## Candidate generation

- Measure each source by recall@N of the final positive items (N = number of candidates
  it returns), not by NDCG; the ranker fixes the order later.
- Embedding retrieval: dot product favours items with large embedding norms, which are
  usually popular items. Cosine removes norm effects. If popular items crowd lists,
  normalise or damp the norm.
- Use approximate nearest neighbour search (for example ScaNN, FAISS, HNSW-based
  indexes) for large catalogs. Check its recall against exact search on a sample.
- Precompute candidates for static inputs (item-to-item lists, nightly user lists);
  compute at request time only what needs fresh context.
- Keep a source that does not depend on past exposure (fresh items, exploration),
  otherwise new items never get data.

## Ranking

- Training data: impressions with outcomes (shown and clicked, shown and not clicked).
  Unshown items are not negatives for the ranker.
- Label and objective must match the product goal. Clicks alone reward click-bait;
  watch time alone favours long items. Combine signals (for example click with
  satisfaction or completion) or optimise a weighted objective.
- Position bias: items higher on the page get more clicks regardless of quality. Add
  position as a training feature and set it to a fixed value (top position) at serving
  time, or learn a position-bias correction.
- Use the same feature code for training and serving, and compute training features "as
  of" the impression time (no future data).
- Weight users fairly: a fixed number of training examples per user stops a few very
  active users from dominating.
- Use explicit negative feedback (hide, dislike, skip soon after start) as negative
  labels or as a separate objective. With several objectives, rank by a weighted sum and
  tune the weights with online tests.
- Gradient-boosted trees on hand-made features are a strong first ranker; move to a DNN
  when there are rich sparse features or sequences.

## Re-ranking: business rules, diversity, freshness

- Hard filters first: out of stock, unavailable in region, already purchased, blocked or
  hidden by the user, policy rules. Apply the same filters in offline evaluation.
- Diversity: greedy maximal marginal relevance (MMR). At each slot pick the item with the
  highest lambda * relevance - (1 - lambda) * max similarity to items already picked.
  Normalise relevance to [0, 1] first so the two terms are on the same scale. Tune
  lambda with an online test; start with a mild setting. Simple caps (at most N items per
  category, artist or seller) are easier to explain and often enough.
- Freshness: boost items by age, or reserve a few slots for new items. Add item age as a
  ranker feature, and at serving time set it to a fixed value (for example 0), so the
  model does not learn that old items are better just because they had more time to
  collect interactions.
- Exploration: give a small share of slots to items with uncertain scores (epsilon-greedy
  or a bandit). Without exploration, the model only learns about what it already shows.
- Fairness: if exposure for creators or user groups matters, measure exposure and
  quality per group; add constraints only after measuring.

## Feedback loops and biased logs

- The model trains on interactions with items the previous model chose to show. This
  strengthens popularity and the old model's taste over time (filter bubble, rich get
  richer).
- Train on interactions from all surfaces (search, browse, external links), not only
  from the recommender's own module.
- Log impressions with position and the model version that produced them. Without
  impressions you cannot build a ranker or correct position bias later.
- Watch the share of exposure going to the head over time; a steady rise means the loop
  is narrowing.
- For unbiased offline estimates of a new policy you need randomised exposure data
  (a small random slice) or logged propensities. Without either, rely on online tests.

## Serving and freshness of the model

- Retrain on a schedule matched to how fast items and tastes change; warm-start from the
  previous model to save time and keep embeddings stable.
- New users with a few interactions: fold them in (solve for the user vector against
  fixed item factors in ALS) or use item-kNN on their recent items until the next
  retrain.
- Always have a fallback path (popular in segment) when the model, the feature store or
  the user lookup fails. Never return an empty list.
- Cache precomputed lists, but invalidate on strong signals (purchase, hide, dislike).
- Version models and log the version with each impression.

## Monitoring

| Signal | What it catches |
|---|---|
| Online metric by model version | regressions after retrain |
| Coverage and head share of exposure | narrowing feedback loop |
| Share of requests served by the fallback | broken lookups, cold-start growth |
| Score and feature distributions vs training | data drift, broken features |
| Latency per stage | slow candidate sources |
| Empty or short lists | filter bugs, catalog sync issues |

## Start-small checklist

```
- [ ] Impressions, clicks and conversions are logged with position and model version
- [ ] Most-popular fallback exists and is tested
- [ ] One candidate source + simple ranker (or a single model) beats the baseline offline
- [ ] Hard filters applied identically offline and online
- [ ] Online test with user-level randomisation and guardrails
- [ ] Monitoring for coverage, fallback rate, latency
```
