# Offline and online evaluation

## Contents
- Protocol (the order of work)
- Splitting the data
- Metrics and their exact definitions
- Beyond-accuracy metrics
- Pitfalls that make offline numbers lie
- Comparing models fairly
- Online tests

## Protocol (the order of work)

1. Fix the question: which surface, which users (warm, cold, all), which k (the number
   of slots the product really shows).
2. Split by time (below). Keep a validation split inside train for tuning; touch the test
   split once per final comparison.
3. Build the most-popular baseline with the same candidate filters as the model.
4. Train each model on train only; tune on validation only.
5. Generate top-k lists for every test user, with the same seen-item filter the product
   uses.
6. Compute ranking metrics plus coverage and popularity bias; break results down by user
   history length.
7. Check significance with a paired comparison over users.
8. Confirm with an online test before claiming a win.

## Splitting the data

Default: a global time-based split. Pick a cutoff time; everything before it is train,
everything after it is test. This is the only split that never trains on the future.
`scripts/evaluate_recs.py split` does this, writes users with no train history to
`test_cold_users.csv` as a separate group (only when there are any), and (by default)
drops repeat interactions with items the user already had in train. It warns when
most post-cutoff rows are cold users or repeats.

| Split | Use it when | Problem |
|---|---|---|
| Global time cutoff | Default for any product with timestamps | Test users are the ones active after the cutoff; check how many there are |
| Rolling time windows (several cutoffs) | You need stable estimates or want to see drift | More compute |
| Per-user leave-last-out | Sequence tasks where the next action is the target, and only if every held-out interaction is after one global cutoff | Without that cutoff, train for user A contains interactions after user B's test interaction: global-timeline leakage that can change model order |
| Random hold-out of interactions | Only when there are no timestamps | Leaks future popularity and co-occurrence; inflates collaborative models most |
| Random leave-one-out (as in the BPR paper) | Reproducing old papers | Same leakage; not for product decisions |

Validation split: split train again by time (cutoff before the test cutoff) and tune
hyperparameters there. Retrain the chosen configuration on all train data before testing.

Decide and document:
- Repeat interactions: drop them from test for discovery surfaces; keep them for
  re-purchase or "listen again" surfaces (`--keep-repeats`). Then do not filter seen
  items in the model, and compare against `popularity --keep-seen` and the buy-again
  baseline `popularity --personal-first`, which is often very hard to beat there.
- Cold-start users and items: report them as separate groups. Mixing them with warm users
  hides both numbers.
- Relevance: for implicit data, any test interaction is relevant by default. Stronger
  signals (purchase vs click, long vs short dwell) can be graded gains for NDCG
  (`--relevance-col`). For explicit ratings, decide a threshold (for example rating >= 4
  on a 5-point scale is relevant) and say so.

## Metrics and their exact definitions

All metrics are per user, then averaged with equal weight per user. Users in test with no
recommendations count as zero, not dropped. These are the definitions in
`scripts/evaluate_recs.py`:

| Metric @k | Definition | Read it as |
|---|---|---|
| precision | hits in top k / k (k even if the list is shorter) | share of slots that were useful |
| recall | hits in top k / number of relevant test items | share of what the user later did that we found |
| hit_rate | 1 if any hit in top k, else 0 | share of users with at least one useful item |
| ndcg | DCG / ideal DCG, DCG = sum of gain / log2(position + 1) | rewards hits near the top; graded gains supported |
| map | sum over hit positions of precision@position / min(relevant count, k) | position-aware precision |
| mrr | 1 / position of first hit (0 if none in top k) | how far a user scrolls to the first good item |

Notes:
- Libraries differ: some use exponential gain (2^rel - 1) in NDCG, some divide AP by the
  number of relevant items instead of min(relevant, k), some define recall@k as hits /
  min(k, relevant count), some drop users without hits. Do not compare numbers across
  tools or papers without checking the definitions.
- Absolute values depend on the dataset, the split and the catalog size. There is no
  universal "good NDCG". Compare models on the same split only.
- Do not use RMSE or MAE to choose a top-k recommender. They only score items the user
  chose to rate and ignore everything that was never shown. Use them only if the product
  really displays predicted ratings.

## Beyond-accuracy metrics

| Metric | Definition (script) | Why |
|---|---|---|
| coverage | distinct items recommended in top k across users / catalog size | low coverage = the long tail never gets exposure |
| gini | Gini index of how often each catalog item is recommended (0 = even, 1 = one item) | concentration of exposure |
| avg_rec_popularity | mean train popularity (distinct users) of recommended items; compare to avg_test_item_popularity | above the test value = the model is more popularity-biased than users are |
| long_tail_share | share of recommended slots outside the head (head = top 20% items by train popularity, `--head-fraction`) | how much tail exposure the model gives |
| seen_item_rate | share of recommended slots that the user already had in train | should be 0 for discovery surfaces; a non-zero value usually means a filter bug |
| users_with_short_lists | users who got fewer than k items | short lists lose slots; check filters and candidate supply |

Diversity within a list (intra-list distance) and novelty need item features or
popularity logs from the product; compute them separately if the user cares about them.

## Pitfalls that make offline numbers lie

Check every item. Each one has inflated or reversed real comparisons.

1. Future leakage: random splits, or features computed on the whole log (popularity
   counts, item embeddings, co-occurrence tables, text vocabularies) before splitting.
   Every feature must be computed from train-period data only. For recommendations
   someone else produced, verify the claimed training cutoff: `evaluate` warns when
   recommended items have no train interactions and counts hits on them (expected only
   for content, fresh-item or exploration sources). For a stronger check, rebuild a
   simple model on train only and on all data and see which one the delivered lists
   resemble.
2. Sampled metrics: ranking the held-out item against 100 random negatives instead of the
   full catalog. Sampled metrics can reverse which model is better and collapse toward
   AUC. Rank against all candidate items. If the catalog is truly too large, evaluate on
   the full output of the production candidate generator instead of random samples;
   this favours models similar to that generator, so report it as a caveat. If you must
   read a sampled evaluation, also check where the true item sits in the candidate list:
   at a fixed position (for example appended last) with tied scores, the sort order
   decides hits.
3. Inconsistent seen-item filtering: the model filters seen items but the baseline does
   not (or the reverse), or evaluation filters but serving does not.
4. Weak baselines: no most-popular baseline, or an untuned kNN or ALS. Tuned simple
   methods often beat new neural models. Give baselines the same tuning budget.
5. Tuning on test: choosing hyperparameters, epochs or blend weights by test score.
6. Dropping hard users: excluding users without recommendations or without hits from the
   average.
7. Different candidate sets: one model may recommend items the other cannot (new items,
   unavailable items). Apply the same availability filter to all models.
8. Mismatched k: the product shows 4 slots but the report uses k = 50.
9. Logged data is biased: the test interactions happened on items the old recommender
   chose to show. Offline metrics favour models that imitate the old system. Treat
   offline wins as a filter, not proof; confirm online.
10. Averages hide groups: a model can win on heavy users and lose on new users. Always
    break down by history length (`--per-user` writes per-user rows with n_train).

## Comparing models fairly

- Same split, same candidate filter, same k, same metric code for all models.
- Run `compare` for a paired bootstrap over users: it reports the mean difference, a 95%
  interval, and how many users got better or worse. Treat an interval that crosses zero
  as "no evidence of a difference".
- With many models or many metrics, expect some false wins; prefer one pre-chosen primary
  metric (usually NDCG@k or recall@k at the product's k) and treat the others as
  guardrails.
- Report run-to-run variance for models with random initialisation (retrain with a few
  seeds) before calling small gains real.

## Online tests

- Offline and online results often disagree; the online test decides.
- Before starting, estimate the sample size needed to detect the smallest effect worth
  shipping; stop at the planned size, not when the result looks good.
- To compare two rankers, interleaving (mixing both lists in one list and counting which
  model's items get clicked) needs far fewer users than an A/B test. Still A/B test the
  winner on business metrics.
- Randomise by user, not by request, so a user sees one variant. Run long enough to cover
  weekly cycles and novelty effects.
- Primary metric: the product outcome the recommender is meant to move (purchases,
  retained users, long-term engagement), not only clicks on the module.
- Guardrails: catalog coverage, share of exposure to new items, latency, complaint or
  hide rates.
- Watch for interference: recommendations change what users interact with, which changes
  training data for both arms if they share one model.
