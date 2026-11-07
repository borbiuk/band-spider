---
name: building-recommenders
description: Guides choosing, building, evaluating and debugging recommender systems that suggest items to users, from simple baselines to matrix factorization and two-tower retrieval with ranking. Includes a dependency-free script for leakage-safe offline evaluation of top-k recommendation lists. Use when the user builds, reviews or fixes a recommendation, personalization, "similar items", "you may also like", "buy again" or "frequently bought together" feature, works with user-item interaction data (clicks, views, plays, purchases, ratings), or asks about collaborative filtering, cold start, popularity bias, recommendation metrics or A/B tests of recommenders, even if they do not say "recommender". Not for search ranking, RAG or retriever evaluation, ad click-through models, or a request for personal picks such as books to read.
---

# Building recommenders

Most recommender failures come from the problem framing, the evaluation, or the data,
not from the choice of algorithm. Follow the core rules first; pick the model second.

## Core rules

1. **Frame before modelling.** Know the surface (feed, item page, basket, email), the
   feedback type (implicit or explicit), the number of slots k, whether users repeat
   items, and the online goal. Infer from code and data; ask only for what is missing.
2. **Baseline first.** Build a most-popular baseline (recent, distinct users) with the
   same filters as the model; for repeat products also a "buy again" baseline (the
   user's own frequent items). A model that does not beat it on the same split is not
   ready. Tuned item-kNN, EASE and implicit ALS are the next bar; do not skip them for a
   neural model.
3. **Split by time.** Train on interactions before one global cutoff, test on
   interactions after it. Build every feature (popularity counts, co-occurrence,
   embeddings) from train-period data only. Random splits leak the future; per-user
   leave-last-out is fine for sequence tasks only if every held-out interaction is after
   the global cutoff.
4. **Rank the full catalog.** Never evaluate by ranking the true item against a sample of
   random negatives; sampled metrics can reverse which model is better.
5. **Use top-k ranking metrics at the product's k** (NDCG@k, recall@k, MRR@k). Do not
   pick a top-k recommender by RMSE; use RMSE only when the product shows predicted
   ratings.
6. **Same filters everywhere.** Seen-item, availability and business filters must be
   identical for every model, for the baselines, and in serving. In every comparison,
   state the seen-item rule each side uses; if they differ on purpose (for example a
   filtered discovery model vs buy-again on a repeats-kept test), say so and why.
7. **Look past the average.** Report coverage and popularity bias, evaluate cold-start
   users and items as separate groups, and break results down by user history length.
8. **Offline is a filter, online decides.** Logged data reflects what the old system
   showed. Confirm wins with an online test (A/B test or interleaving).
9. **Prefer simple and maintained.** Use the team's stack and an actively maintained
   library (check recent activity; for example `implicit` in Python, Spark ALS on Spark)
   before custom training code.

## Workflow

For hands-on build or evaluation work (code, data or runs), copy this checklist into the
response and tick it off. For advisory questions, follow the same order in prose without
the checklist.

```
Recommender progress:
- [ ] 1. Frame: surface, feedback type, k, repeats, online goal, data volume and churn
- [ ] 2. Inspect data: interactions per user/item (median), time range, duplicates, bots
- [ ] 3. Split by time (+ validation split inside train for tuning)
- [ ] 4. Baselines (most-popular; buy-again for repeat products) with production filters
- [ ] 5. Candidate model(s) from the decision table; tune on validation only
- [ ] 6. Evaluate: ranking metrics, coverage, popularity bias, by history length
- [ ] 7. Paired comparison vs baseline; check the interval
- [ ] 8. Report with the template below
- [ ] 9. Cold-start fallback chain defined and tested
- [ ] 10. Online test plan and monitoring
```

## Choosing an approach (summary)

| Situation | Start with | Then try |
|---|---|---|
| Implicit feedback (clicks, plays, purchases) | most-popular, item-kNN | implicit ALS or EASE; BPR; hybrid with content |
| Repeat consumption (groceries, music) | buy-again (user's own frequent items) | blend buy-again with a discovery model |
| Explicit ratings and the UI shows predicted ratings | mu + b_u + b_i baseline | biased MF (fit observed ratings only) |
| Explicit ratings but the UI shows a top-k list | treat as implicit (rating threshold) | implicit ladder; ratings as graded relevance |
| "Similar items" / "bought together" | co-occurrence with lift or damping | item-kNN; blend with content for new items |
| Many new items (news, listings) | content-based + recency | hybrid adding collaborative signal |
| Order matters (sessions, playlists, anonymous users) | popular-in-context, session-kNN | sequence model (SASRec-style) only if it beats them |
| Huge catalog, rich features, low latency | several candidate sources | learned ranker + re-ranking; two-tower retrieval |
| Little data | popularity per segment, content, rules | collaborative later, once data grows |
| Someone proposes an LLM | the baselines above | LLM for item-text embeddings, explanations, re-ranking short lists |

For method cards (EASE, session-kNN, sequence models, LLM stance), default
hyperparameter ranges, cold-start plans and libraries by stack, read
[reference/choosing-an-approach.md](reference/choosing-an-approach.md).

## Evaluating with the bundled script

Run `scripts/evaluate_recs.py`; do not re-implement the metrics. Python 3.8+, standard
library only. Inputs are CSV files with a header; map other column names with
`--user-col`, `--item-col`, `--time-col`. The commands below use `${CLAUDE_SKILL_DIR}`,
which Claude Code replaces with this skill's folder. On other surfaces, replace it with
the path of the folder that holds this SKILL.md.

```bash
S=${CLAUDE_SKILL_DIR}/scripts/evaluate_recs.py
# 1. Time split (default: last 20% by time to test; --cutoff fixes the time, any column name via --time-col)
python3 $S split --interactions interactions.csv --time-col ts --cutoff 2025-06-01T00:00:00Z --out-dir eval/
# 2. Most-popular baseline for every test user
python3 $S popularity --train eval/train.csv --test eval/test.csv --out eval/pop.csv --k 10
# 3. Metrics for a recommendations file (user_id, item_id and rank, or a score column; rename with --score-col)
python3 $S evaluate --recs eval/model.csv --test eval/test.csv --train eval/train.csv --k 5 10 --per-user eval/model_users.csv
# 4. Is the model really better than the baseline?
python3 $S compare --recs-a eval/pop.csv --recs-b eval/model.csv --test eval/test.csv --train eval/train.csv --metric ndcg --at 10
```

If seen items will be filtered after the model runs, export more than k candidates per
user (k plus a typical history length), or the filtered lists come out short.

List every line of `warnings` from every run in the answer, with what you did about it;
never drop one. What they mean:
- `split`: a high cold-user share means a small warm test set or a per-session log; a
  high repeat share means the product may be repeat-driven (see below).
- `evaluate`: users without recommendations count as 0; recommended IDs unknown to train
  and test usually mean an ID-mapping bug; a non-zero `seen_item_rate` means a missing
  filter unless repeats are intended; tied scores make order arbitrary. Compare
  `avg_rec_popularity` with `avg_test_item_popularity` to see popularity bias.
- `compare`: an interval that crosses zero is no evidence of a difference; fewer than 30
  users is too few.

When the repeat share is high and the surface is unknown, report both framings side by
side: discovery (repeats dropped, seen items filtered) and buy-again (repeats kept,
buy-again baseline). State the assumption and ask; do not pick one.

Repeat products: add `--keep-repeats` to `split`, use `popularity --keep-seen` and
`popularity --personal-first` (buy-again) as baselines, and do not filter seen items in
the model. Cold-start users: `split` writes `test_cold_users.csv` only when there are
any. Evaluate them separately with lists made for them, for example
`popularity --test eval/test_cold_users.csv --out eval/pop_cold.csv`, then `evaluate`
against `eval/test_cold_users.csv` (`pop.csv` from step 2 has no cold users).
`popularity --window-days N --time-col ...` gives a recent-popular
baseline. Metric definitions, split options and the full pitfall list are in
[reference/evaluation.md](reference/evaluation.md).

Report template for hands-on evaluations (keep every line; adapt the wording):

```markdown
## Evaluation: [surface], k = [slots]
Split: [cutoff], train [n] interactions; test [n] warm users, [n] cold users (separate)
Seen-item rule: model [filtered/not], each baseline [filtered/not], why if different
| Model | NDCG@k | Recall@k | MRR@k | Coverage | Avg rec popularity |
Paired comparison: [metric] diff [x], 95% CI [a, b], users better/worse [n]/[n]
Warnings and actions: [every script warning -> what was done]
Not verified: [for example the model's training cutoff, online effect]
Next step: [decision or online test plan]
```

## Reviewing or debugging an existing recommender

1. Find how the offline numbers were produced: split type, negatives, filters, k,
   baseline, which features each model got. Most "great" results fail a core rule.
   Order findings by severity: leakage (split, features built on all data) first, then
   unequal inputs or filters between models, then sampled metrics and their biases,
   then a missing baseline or significance test, then everything else.
2. Reproduce one or two users by hand: their history, their list, why each item appears.
3. Run the sanity checks and the symptom guide in
   [reference/troubleshooting.md](reference/troubleshooting.md).
4. Fix evaluation first, then data, then the model.

## Production systems

For multi-stage design (candidate generation, ranking, re-ranking), position bias,
diversity (MMR, caps), freshness, exploration, feedback loops, serving fallbacks and
monitoring, read [reference/production.md](reference/production.md).

## Adapting to the user's stack

- Use the language, data store and ML stack already in the repository. Read the existing
  data model (interaction tables, item catalog) before proposing schemas.
- Check the installed version of any library and its docs before writing calls; APIs
  change (for example, matrix orientation and parameter names).
- No ML stack (SQL or a web backend only): popularity, co-occurrence and item-kNN in SQL
  or plain code are valid first versions. Export the evaluation inputs as CSV and use the
  script.
- If the data cannot leave a secure environment, run the script there; it needs no
  installs and no network.

## References

- [reference/choosing-an-approach.md](reference/choosing-an-approach.md): problem
  classification, method cards, cold start, libraries by stack
- [reference/evaluation.md](reference/evaluation.md): splits, metric definitions,
  pitfalls, significance, online tests
- [reference/production.md](reference/production.md): multi-stage architecture,
  ranking, re-ranking, feedback loops, serving, monitoring
- [reference/troubleshooting.md](reference/troubleshooting.md): symptom-to-cause guide
  and sanity checks
- [reference/sources.md](reference/sources.md): papers, course and libraries behind
  this guidance
