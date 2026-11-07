# Choosing an approach

## Contents
- Step 1: Classify the problem
- Step 2: Pick the starting ladder
- Step 3: Method cards (when, data needs, defaults, traps)
- Step 4: Cold start plan
- Step 5: Library defaults by stack

## Step 1: Classify the problem

Answer these before naming any algorithm. Ask the user only for what you cannot infer
from their code or data.

| Question | Why it matters |
|---|---|
| Recommendation surface: home feed, "similar items" on an item page, "complete the basket", email, search re-rank? | Item-to-item surfaces need item similarity, not user models. Basket needs co-occurrence. |
| Feedback type: explicit ratings, or implicit interactions (clicks, views, plays, purchases, dwell time)? | Implicit data has no negatives; use ranking losses or confidence-weighted MF, not RMSE on observed cells. |
| Volume: users, items, interactions; interactions per user (median, not mean)? | Small or very sparse data favours baselines and item-kNN; very large catalogs need candidate generation + ranking. |
| Item churn: how fast do new items appear and expire (news, listings, short videos)? | High churn means item cold start is the main problem; content features become essential. |
| Repeat consumption: do users re-buy or re-listen to the same items? | Decides whether to filter seen items and how to split test data. |
| Side data: item text, categories, images; user attributes, context (time, device)? | Enables content-based, hybrid, and feature-based (two-tower) models. |
| Objective: what business outcome, and what online metric will judge it? | The offline target must match it (clicks invite click-bait; watch time favours long items). |
| Constraints: latency, batch vs real-time, team skill, existing stack. | Rules out heavy models early. |

## Step 2: Pick the starting ladder

Climb only while each step beats the previous one on a time-based split (see the
evaluation reference). Stop when the gain no longer pays for the complexity.

| Situation | Ladder (start at the left) |
|---|---|
| Implicit feedback, one catalog, up to roughly millions of items | most-popular -> item-kNN -> implicit ALS, or EASE if the catalog has up to about 20-30k items -> BPR / hybrid with content features |
| Repeat consumption (groceries, music, re-orders) | buy-again (user's own frequent items, recency-weighted) -> blend of buy-again and a discovery model; evaluate with repeats kept in test |
| Explicit ratings and the product really shows predicted ratings | global/user/item baseline (mu + b_u + b_i) -> biased MF -> MF + implicit signals |
| Explicit ratings but the product shows a top-k list | Treat as implicit (rating >= threshold = positive) and use the implicit ladder; keep ratings as graded relevance for NDCG |
| "Similar items" / "people also bought" | co-occurrence with lift or damped conditional probability -> item-kNN on interactions -> content similarity blend for new items |
| Heavy item churn (news, jobs, listings) | content-based (text embeddings, categories) + recency -> hybrid that adds collaborative signal for items with enough interactions |
| Order matters: sessions, anonymous users, playlists | popular-in-context -> session-kNN or item-to-item on the current session items -> sequence model only if it beats them on a time split |
| Very large corpus, rich features, strict latency | multi-stage: several candidate generators (item-kNN, ALS, two-tower) -> learned ranker -> re-ranking; see the production reference |
| Fewer than a few thousand interactions | most-popular per segment, content-based, or rules; collaborative models will mostly learn popularity |

Default when unsure: implicit ALS (confidence-weighted MF) with a most-popular baseline
and item-kNN as comparisons. It is fast, well understood, and strong on implicit data
when tuned.

## Step 3: Method cards

### Most-popular (non-personalized)
- Use: always, as the first baseline and as the cold-start fallback.
- Variants: popular in the last N days (recency window matching the product's pace),
  popular per segment (country, category, device). Count distinct users, not raw interactions,
  so one heavy user cannot make an item popular.
- For explicit ratings, rank by a damped mean: (sum of ratings + k * global mean) /
  (n ratings + k), so items with two 5-star ratings do not top the list. Choose k near
  the typical rating count of a mid-popular item.
- Trap: it is often hard to beat. A personalized model that does not beat it is not ready.

### Co-occurrence and association ("bought together")
- Score j for anchor i by co-occurrence normalised against j's popularity: lift
  P(j | i) / P(j), or the damped conditional probability count(i and j) / (count(i) *
  count(j)^alpha) with alpha in (0, 1]. Raw co-occurrence counts just return
  best-sellers.
- Require a minimum co-occurrence count to avoid lucky pairs; tune it on the
  evaluation, do not guess.

### Item-kNN (item-item collaborative filtering)
- Use: strong baseline for implicit data; natural for "similar items"; easy to explain
  ("because you watched X").
- Similarity: cosine on the binary or confidence-weighted user-item matrix. For explicit
  ratings, subtract user/item baselines first (adjusted cosine). Normalising each user
  vector down-weights heavy users. BM25 or TF-IDF weighting of the matrix often helps
  (both are built into the `implicit` library).
- Scoring for implicit data: sum the similarities of the candidate to the user's items.
  A weighted average gives every candidate the same score (1) on binary data.
- Keep only the top-k neighbours per item (start with k in 20-100 and tune). Store a few
  more than k so enough remain after removing seen items.
- Trap: popular items are similar to everything. Use damping or an exponent on the
  popular item's norm if lists look like best-seller lists.

### User-kNN (user-user collaborative filtering)
- Rarely the best choice today: slower to serve and unstable for users with little
  history. Use it only for small, dense data or when "people like you" explanations are
  required.
- If used: Pearson correlation on mean-centred ratings with significance damping
  (multiply by min(co-rated / 50, 1)), neighbourhood of 20-50.

### Matrix factorization for explicit ratings (biased MF, "SVD" in the Netflix-prize sense)
- Model: prediction = mu + b_u + b_i + p_u . q_i, fitted only on observed ratings with L2
  regularization, by SGD or ALS.
- Do not run plain truncated SVD on a zero-filled rating matrix and call it MF: it
  treats missing as rating 0 and pushes predictions toward zero.
- Add implicit signals (which items the user rated or viewed, not the value) when
  available; add time-dependent biases if ratings drift. Clip predictions to the rating
  scale.
- Ratings are missing not at random: users rate what they chose and often liked, so
  error on logged ratings is optimistic. If it matters, test on ratings of randomly
  chosen items or weight errors by inverse propensity.

### Implicit ALS (confidence-weighted MF, Hu-Koren-Volinsky; also called WALS or iALS)
- Use: default personalized model for implicit data at most scales.
- Model: preference p_ui = 1 if any interaction, else 0; confidence c_ui = 1 + alpha *
  r_ui (or 1 + alpha * log(1 + r_ui / eps) for heavy-tailed counts). Fits all user-item
  cells, unobserved ones with low weight, so no negative sampling is needed.
- Hyperparameters to tune on validation (not test): factors, regularization, alpha (or
  the unobserved weight), iterations. alpha is the most sensitive: large alpha on binary
  data over-trusts each click.
- Trap: users and items with very many interactions dominate the loss; cap or log-scale
  counts. Very short plays or views (skips) are not positives: drop them or treat them
  as negative signal, with the threshold taken from the dwell-time distribution.

### BPR (Bayesian Personalized Ranking)
- Use: when you want to optimise ranking (AUC) directly with SGD, need a pairwise loss in
  a custom model, or want to add features to the loss later.
- Training: triples (user, observed item, unobserved item), sampled uniformly at random
  with replacement; looping user by user converges much more slowly.
- Trap: uniform negatives are mostly easy, so learning slows; popularity-aware or hard
  negatives help but can over-penalise popular items. Always compare against a tuned
  implicit ALS on the same split; neither wins on every dataset.

### EASE and SLIM (linear item-item models)
- Use: implicit data with a catalog small enough for dense items x items matrices.
  One such matrix is items^2 floats: 1.6 GB at 20k items and 10 GB at 50k items in
  float32 (double in float64), and the inverse needs a second matrix of the same size.
  Practical limit on one machine: about 20-30k items. Often matches or beats MF and
  neural models in honest comparisons.
- EASE: one closed-form solve for item-item weights with a zero diagonal; the L2
  regularization strength is the only key knob. SLIM learns sparse weights with
  L1 + L2 and scales further but trains slower.
- Trap: memory grows with items^2 and the inverse costs items^3 time; for larger
  catalogs use ALS, item-kNN, or a sparse or approximate EASE variant.

### Session-kNN and sequence models
- Use when the order of recent actions carries short-term intent (sessions, playlists,
  anonymous visitors, next-episode).
- Strong simple baseline: session-kNN. Find past sessions similar to the current one
  (shared items, recent items weighted more) and score items from those sessions.
  Item-to-item on the last few items is even simpler.
- Sequence models (GRU4Rec, SASRec-style transformers) predict the next item from the
  ordered history. Use them when there is enough data and they beat session-kNN and
  tuned item-kNN; on small data they often do not.
- Evaluate next-item prediction with the target interactions after one global cutoff
  (rule 3 in SKILL.md), ranked against the full catalog.

### LLM-based recommendation (stance)
- Useful: embeddings of item text or images for content-based and cold-start items;
  natural-language explanations of a recommendation; re-ranking or filtering a short
  candidate list with rich context; parsing a conversational request into filters.
- Not a replacement for collaborative signal: an LLM does not know what this product's
  users did together, and it can name items that are not in the catalog. Restrict
  outputs to catalog IDs.
- Prove it the same way as any model: same time split, same baselines, full-catalog
  metrics, then an online test. Count cost and latency per request.

### Content-based
- Use: item cold start, high churn, items with rich text or attributes, privacy-limited
  settings, or "more like this".
- Build item vectors (TF-IDF or a pretrained text/image embedding, plus categorical
  attributes), build a user profile from the items they engaged with (weighted by
  strength and recency), rank by cosine similarity.
- Trap: over-specialisation (only near-duplicates). Add diversity in re-ranking.

### Hybrid
- Simplest that works: switching (content-based until a user or item has enough
  interactions, then collaborative) or a weighted blend of normalised scores. Learn blend
  weights on validation data, never by hand on test.
- Feature-based hybrid: models that take user and item features plus IDs (LightFM-style
  factorization with features, or a two-tower network) handle cold start and warm items
  in one model.

### Two-tower retrieval and DNN ranking
- Use: very large corpora, rich user/context features, real-time context (session,
  query), or when several signals must be combined. Usually as one candidate generator
  plus a separate ranking model.
- Two-tower: user/context tower and item tower produce embeddings; score = dot product;
  serve with approximate nearest neighbour search. Train with sampled softmax or in-batch
  negatives and correct for popularity sampling bias (subtract log of item sampling
  probability), or popular items get pushed down.
- Ranking model: gradient-boosted trees or a DNN on (user, item, context) features,
  trained on impressions with labels that match the product objective.
- Trap: neural models often lose to tuned simple baselines in honest comparisons. Prove
  the gain on a time-based split and online.

## Step 4: Cold start plan

Decide the fallback chain explicitly and test each branch.

| Case | Default handling |
|---|---|
| New user, no history | Popular (recent, per segment if a segment is known); onboarding choices; context (device, location, referrer). Switch to personalized after a small number of interactions; pick the threshold from per-user metrics by history length. |
| New user, a few interactions | Item-kNN or content-based from those items; ALS can "fold in" a new user by solving for the user vector against fixed item factors. |
| New item, no interactions | Content-based similarity to known items; feature-based models; reserve some exposure for exploration so the item can collect data. |
| Whole new product (no log) | Rules, curated lists, popularity from a related product; log impressions and clicks from day one so a model can be trained later. |

## Step 5: Library defaults by stack

Prefer a maintained library over hand-written training loops. For any library, check
recent release activity, the installed version and its docs before writing calls,
because projects go quiet and APIs change.

| Stack | Default choice |
|---|---|
| Python, implicit data | `implicit` (ALS, BPR, logistic MF, item-kNN with cosine/TF-IDF/BM25); EASE is a few lines of NumPy |
| Python, features + IDs, hybrid | LightFM-style factorization with features, or a two-tower model in the team's deep learning framework |
| Python, research comparisons of many models | RecBole or Microsoft Recommenders (also has split and metric utilities) |
| Spark / big data | Spark MLlib ALS (has an implicit-preference mode) |
| SQL-only or no ML stack | Popularity and co-occurrence in SQL; item-kNN from a co-occurrence table |
| JVM / Node / other | Popularity, co-occurrence and item-kNN are easy to write; export ALS factors from a Python job if needed |

Whatever the library: use its "filter already liked items" option consistently in both
evaluation and serving, and check whether it expects a user-by-item or item-by-user
matrix.
