# Troubleshooting recommenders

Find the symptom, then run the checks in order. Most problems are data or evaluation bugs,
not model choice.

## Contents
- Offline metrics look too good
- Model does not beat most-popular
- Everyone gets the same (popular) items
- Recommendations are too narrow or repetitive
- Recommendations look random or irrelevant
- New users or new items get bad results
- Offline gain, no online gain
- Training problems (ALS, BPR, two-tower)
- Sanity checks to run on any recommender

## Offline metrics look too good

1. Random split or leave-one-out ignoring the global timeline -> switch to a time cutoff.
2. Features or co-occurrence tables built on the full log before splitting -> rebuild
   from train-period data.
3. Sampled metrics (ranking among 100 random items) -> rank the full catalog.
4. Test contains repeat interactions and the model recommends seen items on a repeat-heavy
   product -> decide whether repeats count; evaluate both ways.
5. Duplicate interactions (same user, item, time) split across train and test ->
   deduplicate before splitting.
6. User or item IDs encode time or outcome (for example IDs assigned at purchase) -> drop
   such features.
7. Timestamps in mixed units (seconds and milliseconds) or time zones put future
   interactions into train -> convert to one unit and UTC (`split` warns on mixed units).

## Model does not beat most-popular

1. The baseline gets an unfair advantage or penalty: check both use the same seen-item
   filter, availability filter and k.
2. Hyperparameters untuned: tune regularization, factors and alpha (ALS) or neighbourhood
   size and similarity (kNN) on validation.
3. Too little data per user: look at per-user results by history length. Personalization
   usually wins only above some history length; use popularity below it.
4. Test set dominated by repeats the model filters out, or repeats dropped on a
   re-purchase product -> decide on repeats first; compare with the buy-again baseline.
5. Domain is genuinely popularity-driven (news headlines, top charts): blend popularity
   or recency into the score instead of replacing it.
6. Wrong matrix orientation or ID mapping (user and item indices swapped, row index not
   matching the user ID) -> check a few users by hand.

## Everyone gets the same (popular) items

1. Dot-product scores with unnormalised embeddings -> try cosine or a damped norm.
2. Too few factors in MF: a low-rank model mostly learns popularity -> try more factors
   and re-tune regularization; log-scale very large counts.
3. Two-tower trained with uniform random negatives: popular items are rarely sampled as
   negatives, so they score high for everyone -> use in-batch or popularity-based
   negatives with the log-sampling-probability correction. (The reverse problem, in-batch
   negatives without the correction, under-recommends popular items.)
4. Item-kNN without damping for popular neighbours -> add damping or BM25/TF-IDF
   weighting.
5. Measure: avg_rec_popularity vs avg_test_item_popularity and long_tail_share from
   `scripts/evaluate_recs.py evaluate --train ...`.

## Recommendations are too narrow or repetitive

1. Near-duplicate items (same product in sizes or colours, same episode series) -> group
   variants before training or de-duplicate in re-ranking.
2. Content-based model with no diversity step -> add MMR or category caps.
3. Feedback loop: the model only learns from what it showed -> add exploration slots and
   train on all surfaces.

## Recommendations look random or irrelevant

1. ID mapping bug between training and serving (different encoders, re-indexed items) ->
   check that the same item ID maps to the same row in both.
2. Training on noisy signals (accidental clicks, bots, very short views) -> filter by
   dwell time or remove bot traffic.
3. Too many factors or too little regularization for the data size -> lower capacity.
4. Too few iterations or a learning rate that diverges (BPR, two-tower) -> plot the
   training loss and validation metric per epoch.
5. Sanity test: the nearest neighbours of a few well-known items should make sense to a
   human. If they do not, the problem is before ranking.

## New users or new items get bad results

1. No explicit fallback path: users with no history get an empty list or random factors
   -> add the popular-in-segment fallback.
2. New items never shown: no fresh-item candidate source and no exploration -> add both.
3. Factor vectors for unseen IDs are random or zero -> fold in users, or use a
   feature-based model (content, two-tower) for items.
4. Evaluate cold users and cold items as separate groups so the problem is visible.

## Offline gain, no online gain

1. Offline target does not match the online goal (clicks vs purchases, short vs long
   term).
2. Logged-data bias: the new model is only better at imitating the old one.
3. Serving differs from evaluation: different filters, stale features, a cache serving
   old lists, the fallback path firing more often than expected.
4. The offline gain was within noise: check the paired bootstrap interval.
5. Position or presentation effects dominate: the module position or layout matters more
   than the ranking.

## Training problems

- Implicit ALS: loss should fall every iteration; if validation metrics drop while loss
  falls, regularization is too low. Check whether the library expects raw counts,
  confidence values (1 + alpha * r) or 0/1 values, and whether it applies alpha itself;
  applying alpha twice or not at all is a common silent bug.
- BPR: sample triples uniformly at random; iterating user by user slows convergence. Track
  validation AUC or recall during training; stop early.
- Two-tower: check for folding (unrelated items close together): look at nearest
  neighbours across categories. More or harder negatives help. Normalise embeddings if
  norms explode.

## Sanity checks to run on any recommender

```
- [ ] No recommended item is unavailable or already consumed (unless repeats are intended)
- [ ] Lists have no duplicates and have the expected length
- [ ] Nearest neighbours of 5 well-known items make sense to a person
- [ ] Two users with very different histories get different lists
- [ ] A brand-new user gets the fallback, not an error or empty list
- [ ] Most-popular baseline computed with the same filters and split
- [ ] Metrics broken down by user history length
```
