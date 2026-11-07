#!/usr/bin/env python3
"""Leakage-safe offline evaluation for top-k recommenders.

Standard library only (Python 3.8+), so it runs anywhere, including sandboxes
with no network and no package installs.

Subcommands
  split       Global time-based split of an interaction log into train, test
              and test_cold_users CSVs.
  popularity  Most-popular (or personal-then-popular) baseline from a train CSV.
  evaluate    Ranking and beyond-accuracy metrics for a recommendations CSV.
  compare     Paired bootstrap comparison of two recommendation CSVs.

Input formats (CSV with a header row; column names are configurable)
  interactions / train / test : user_id, item_id, timestamp [, other columns]
  recommendations             : user_id, item_id and either rank (1 = best)
                                or score (higher = better)

Run "python3 evaluate_recs.py <subcommand> --help" for all options.
"""

import argparse
import csv
import json
import math
import os
import random
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

# Fraction of interactions that go to test when no explicit cutoff is given.
# 20% is a common hold-out size that leaves most history for training.
DEFAULT_TEST_FRACTION = 0.2

# Head items = the most popular items that make up this fraction of the catalog
# (Pareto-style "top 20% of items"). Everything else is "long tail".
DEFAULT_HEAD_FRACTION = 0.2

# 1000 bootstrap resamples gives stable 95% interval ends to about two
# decimal places for typical per-user metric spreads; raise it for papers.
DEFAULT_BOOTSTRAP_SAMPLES = 1000

# Fixed seed so that repeated runs print the same interval.
DEFAULT_SEED = 0

# Below about 30 paired users a bootstrap interval is too unstable to trust
# (the usual small-sample rule of thumb); compare still runs but warns.
MIN_USERS_FOR_BOOTSTRAP = 30

# Warn when more than half of the post-cutoff rows belong to users with no
# train history: the test set would then describe only a small, odd group.
MAX_COLD_USER_SHARE = 0.5

# Warn when more than half of the post-cutoff rows are repeats of items the
# user already had: the product is repeat-driven and dropping repeats may be
# the wrong default.
MAX_REPEAT_SHARE = 0.5

# A bootstrap interval reads its 2.5% and 97.5% points from the resamples;
# below 100 resamples those points are too coarse to mean anything.
MIN_BOOTSTRAP_SAMPLES = 100

# Epoch seconds stay below 1e11 until the year 5000; epoch milliseconds are
# above 1e11 for any date after 1973. A file with values on both sides of
# this line almost surely mixes seconds and milliseconds.
EPOCH_MS_THRESHOLD = 1e11

SECONDS_PER_DAY = 86400


class InputError(Exception):
    """A problem with user input that should be reported without a traceback."""


# ---------------------------------------------------------------- CSV helpers

def read_rows(path, required):
    """Read a CSV file and check that the required columns exist."""
    if not os.path.isfile(path):
        raise InputError("File not found: %s" % path)
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        missing = [c for c in required if c not in header]
        if missing:
            raise InputError(
                "%s: missing column(s) %s. Found columns: %s. "
                "Use --user-col/--item-col/--time-col/--rank-col/--score-col "
                "to map your column names." % (path, missing, header))
        rows = list(reader)
    if not rows:
        raise InputError("%s has a header but no data rows." % path)
    return header, rows


def write_rows(path, header, rows):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)


def parse_time(value, line_no, path):
    """Accept numbers (epoch seconds or any ordered number) or ISO-8601 text."""
    text = (value or "").strip()
    if not text:
        raise InputError("%s line %d: empty timestamp." % (path, line_no))
    try:
        number = float(text)
    except ValueError:
        number = None
    if number is not None:
        if not math.isfinite(number):
            raise InputError("%s line %d: timestamp %r is not finite."
                             % (path, line_no, text))
        return number
    # Python before 3.11 accepts only 3 or 6 fraction digits; pad to 6.
    text = re.sub(r"(\d{2}:\d{2}:\d{2})\.(\d+)",
                  lambda m: m.group(1) + "." + (m.group(2) + "000000")[:6], text)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise InputError(
            "%s line %d: cannot parse timestamp %r. Use epoch numbers or "
            "ISO-8601 like 2024-01-31T12:00:00." % (path, line_no, text))
    if parsed.tzinfo is None:
        # Mixing naive and aware times is an error in Python, so treat
        # naive times as UTC.
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _is_number(text):
    try:
        float(text)
        return True
    except (TypeError, ValueError):
        return False


def user_items(rows, user_col, item_col):
    result = defaultdict(set)
    for row in rows:
        result[row[user_col]].add(row[item_col])
    return result


# ---------------------------------------------------------------- split

def cmd_split(args):
    header, rows = read_rows(args.interactions,
                             [args.user_col, args.item_col, args.time_col])
    times = [parse_time(r[args.time_col], i + 2, args.interactions)
             for i, r in enumerate(rows)]
    order = sorted(range(len(rows)), key=lambda i: times[i])

    if args.cutoff is not None:
        cutoff = parse_time(args.cutoff, 0, "--cutoff")
    else:
        if not 0 < args.test_fraction < 1:
            raise InputError("--test-fraction must be between 0 and 1.")
        index = int(len(order) * (1 - args.test_fraction))
        index = min(max(index, 1), len(order) - 1)
        cutoff = times[order[index]]

    train = [rows[i] for i in order if times[i] < cutoff]
    later = [rows[i] for i in order if times[i] >= cutoff]
    if not train or not later:
        raise InputError(
            "Split is empty on one side (train=%d, test=%d). Data times run from "
            "%s to %s; the cutoff parsed as %s. Use the same format and unit as "
            "the data." % (len(train), len(later), times[order[0]],
                           times[order[-1]], cutoff))

    train_seen = user_items(train, args.user_col, args.item_col)
    train_items = {r[args.item_col] for r in train}
    stats = Counter()
    test, cold = [], []
    for row in later:
        user, item = row[args.user_col], row[args.item_col]
        if user not in train_seen:
            stats["dropped_cold_user_rows"] += 1
            cold.append(row)
            if not args.keep_cold_users:
                continue
        if item not in train_items:
            stats["cold_item_rows"] += 1
        if item in train_seen.get(user, ()) and not args.keep_repeats:
            stats["dropped_repeat_rows"] += 1
            continue
        test.append(row)

    warnings = []
    cold_share = stats["dropped_cold_user_rows"] / len(later)
    if cold_share > MAX_COLD_USER_SHARE:
        warnings.append(
            "%.0f%% of rows after the cutoff come from users with no train "
            "history. Warm-user metrics will cover few users. Check whether the "
            "log is per-session or per-user, move the cutoff, or evaluate cold "
            "users as their own group (test_cold_users.csv)." % (100 * cold_share))
    repeat_share = stats["dropped_repeat_rows"] / len(later)
    if repeat_share > MAX_REPEAT_SHARE:
        warnings.append(
            "%.0f%% of rows after the cutoff are repeats of items the user had in "
            "train and were dropped. The product looks repeat-driven; if it shows "
            "repeats (re-buy, re-listen), rerun with --keep-repeats and use "
            "popularity --keep-seen." % (100 * repeat_share))
    numeric = [t for t, r in zip(times, rows)
               if _is_number(r[args.time_col])]
    if numeric and min(numeric) < EPOCH_MS_THRESHOLD <= max(numeric):
        warnings.append(
            "Numeric timestamps span both epoch-second and epoch-millisecond "
            "ranges. Convert them to one unit before splitting; mixed units put "
            "future interactions into train.")
    write_rows(os.path.join(args.out_dir, "train.csv"), header, train)
    write_rows(os.path.join(args.out_dir, "test.csv"), header, test)
    cold_path = os.path.join(args.out_dir, "test_cold_users.csv")
    if cold:
        write_rows(cold_path, header, cold)
    elif os.path.exists(cold_path):
        os.remove(cold_path)  # a stale file from an earlier run would mislead
    report = {
        "cutoff": cutoff,
        "train_rows": len(train),
        "test_rows": len(test),
        "test_users": len({r[args.user_col] for r in test}),
        "rows_after_cutoff": len(later),
        "dropped_cold_user_rows": stats["dropped_cold_user_rows"]
        if not args.keep_cold_users else 0,
        "cold_user_rows_kept": stats["dropped_cold_user_rows"]
        if args.keep_cold_users else 0,
        "dropped_repeat_rows": stats["dropped_repeat_rows"],
        "test_rows_with_cold_items": stats["cold_item_rows"],
        "cold_test_users": len({r[args.user_col] for r in cold}),
        "cold_users_file": cold_path if cold else None,
        "warnings": warnings,
        "notes": [
            "Train holds only interactions before the cutoff, so no future data "
            "leaks.",
            "Cold-start users (no train history) are written to "
            "test_cold_users.csv only if there are any; evaluate them as a separate "
            "group with recommendations made for them (for example popularity "
            "--test test_cold_users.csv). --keep-cold-users also mixes them into "
            "test.csv.",
            "Repeat interactions with items seen in train are dropped; use "
            "--keep-repeats for re-purchase or re-listen products.",
        ],
    }
    print(json.dumps(report, indent=2))
    return 0


# ---------------------------------------------------------------- popularity

def cmd_popularity(args):
    required = [args.user_col, args.item_col]
    if args.window_days is not None:
        required.append(args.time_col)
    _, train = read_rows(args.train, required)
    _, test = read_rows(args.test, [args.user_col])
    seen = user_items(train, args.user_col, args.item_col)
    window = train
    if args.window_days is not None:
        times = [parse_time(r[args.time_col], i + 2, args.train)
                 for i, r in enumerate(train)]
        start = max(times) - args.window_days * SECONDS_PER_DAY
        window = [r for r, t in zip(train, times) if t >= start]
    # Count distinct users per item so one heavy user cannot make an item popular.
    pairs = {(r[args.user_col], r[args.item_col]) for r in window}
    counts = Counter(item for _, item in pairs)
    ranked = sorted(counts, key=lambda item: (-counts[item], item))
    own = defaultdict(Counter)
    if args.personal_first:
        for r in train:
            own[r[args.user_col]][r[args.item_col]] += 1
    # Personal-first lists contain seen items by design, so they never filter.
    keep_seen = args.keep_seen or args.personal_first
    users = sorted({r[args.user_col] for r in test})
    out = []
    for user in users:
        user_seen = set() if keep_seen else seen.get(user, set())
        personal = sorted(own[user], key=lambda i: (-own[user][i], i))
        used = set()
        for item in personal + ranked:
            if item in user_seen or item in used:
                continue
            used.add(item)
            out.append({"user_id": user, "item_id": item, "rank": len(used)})
            if len(used) == args.k:
                break
    write_rows(args.out, ["user_id", "item_id", "rank"], out)
    print("Wrote %d rows for %d users to %s" % (len(out), len(users), args.out))
    return 0


# ---------------------------------------------------------------- metrics

def load_recommendations(path, args, warnings):
    header, rows = read_rows(path, [args.user_col, args.item_col])
    if args.rank_col in header:
        key, reverse = args.rank_col, False
    elif args.score_col in header:
        key, reverse = args.score_col, True
    else:
        raise InputError(
            "%s needs a %r or %r column to order items. Found: %s"
            % (path, args.rank_col, args.score_col, header))
    grouped = defaultdict(list)
    for line_no, row in enumerate(rows, start=2):
        try:
            value = float(row[key])
        except (TypeError, ValueError):
            raise InputError("%s line %d: %s=%r is not a number."
                             % (path, line_no, key, row[key]))
        if not math.isfinite(value):
            raise InputError("%s line %d: %s is NaN or infinite; fix the model "
                             "output before evaluating." % (path, line_no, key))
        grouped[row[args.user_col]].append((value, line_no, row[args.item_col]))
    result = {}
    duplicates = tied_users = 0
    boundary_users = Counter()
    k_values = getattr(args, "k", None) or []
    top = max(k_values or [0])
    for user, entries in grouped.items():
        entries.sort(key=lambda e: (-e[0] if reverse else e[0], e[1]))
        ordered, values, used = [], [], set()
        for value, _, item in entries:
            if item in used:
                duplicates += 1
                continue
            used.add(item)
            ordered.append(item)
            values.append(value)
        result[user] = ordered
        head_values = values[:top]
        if len(set(head_values)) < len(head_values):
            tied_users += 1
        # A tie between positions k and k+1 decides which item enters the top k.
        for k in k_values:
            if len(values) > k and values[k - 1] == values[k]:
                boundary_users[k] += 1
    if duplicates:
        warnings.append("%s: %d duplicate (user, item) rows; kept the best-ranked "
                        "copy. Fix the recommender so lists have unique items."
                        % (path, duplicates))
    if tied_users:
        warnings.append("%s: %d users have tied %s values in the top %d; their "
                        "order falls back to file order." % (path, tied_users, key, top))
    for k in sorted(boundary_users):
        warnings.append("%s: %d users have a %s tie between positions %d and %d; "
                        "file order decides which item is in the top %d. Break ties "
                        "in the model output." % (path, boundary_users[k], key, k, k + 1, k))
    return result


def load_test(path, args):
    header, rows = read_rows(path, [args.user_col, args.item_col])
    graded = args.relevance_col is not None
    if graded and args.relevance_col not in header:
        raise InputError("%s: --relevance-col %r not found. Found: %s"
                         % (path, args.relevance_col, header))
    relevance = defaultdict(dict)
    for line_no, row in enumerate(rows, start=2):
        gain = 1.0
        if graded:
            try:
                gain = float(row[args.relevance_col])
            except ValueError:
                raise InputError("%s line %d: relevance %r is not a number."
                                 % (path, line_no, row[args.relevance_col]))
        user, item = row[args.user_col], row[args.item_col]
        # Keep the strongest signal if a user interacted with an item twice.
        relevance[user][item] = max(gain, relevance[user].get(item, gain))
    # Items with gain <= 0 are not relevant (for example, a 1-star rating
    # mapped to 0 by the caller).
    return {u: {i: g for i, g in items.items() if g > 0}
            for u, items in relevance.items()}


def user_metrics(ranked, relevant, k):
    """Metrics for one user. `relevant` maps item -> gain (> 0)."""
    top = ranked[:k]
    hits = [1 if item in relevant else 0 for item in top]
    n_hits = sum(hits)
    n_rel = len(relevant)
    dcg = sum(relevant.get(item, 0.0) / math.log2(pos + 2)
              for pos, item in enumerate(top))
    ideal = sorted(relevant.values(), reverse=True)[:k]
    idcg = sum(gain / math.log2(pos + 2) for pos, gain in enumerate(ideal))
    ap, seen_hits = 0.0, 0
    for pos, hit in enumerate(hits):
        if hit:
            seen_hits += 1
            ap += seen_hits / (pos + 1)
    first = next((pos for pos, hit in enumerate(hits) if hit), None)
    return {
        # Denominator is k even when the list is shorter: short lists are
        # penalised, as they would be on a page with k slots.
        "precision": n_hits / k,
        "recall": n_hits / n_rel,
        "hit_rate": 1.0 if n_hits else 0.0,
        "ndcg": dcg / idcg if idcg > 0 else 0.0,
        "map": ap / min(n_rel, k),
        "mrr": 1.0 / (first + 1) if first is not None else 0.0,
    }


METRIC_NAMES = ["precision", "recall", "hit_rate", "ndcg", "map", "mrr"]


def gini(values):
    """Gini index of non-negative counts (0 = perfectly even, 1 = one item)."""
    values = sorted(values)
    n = len(values)
    total = sum(values)
    if n == 0 or total == 0:
        return 0.0
    weighted = sum((i + 1) * v for i, v in enumerate(values))
    return (2.0 * weighted) / (n * total) - (n + 1.0) / n


def evaluate(recs, test, train_rows, args, warnings):
    eval_users = sorted(u for u, rel in test.items() if rel)
    if not eval_users:
        raise InputError("Test set has no users with relevant items.")
    missing = [u for u in eval_users if u not in recs]
    extra = [u for u in recs if u not in test]
    if missing:
        warnings.append(
            "%d of %d test users have no recommendations; they count as 0 "
            "(not dropped). Add a fallback (for example popularity) for them."
            % (len(missing), len(eval_users)))
    if extra:
        warnings.append("%d users in the recommendations are not in test; "
                        "ignored." % len(extra))

    seen = user_items(train_rows, args.user_col, args.item_col) if train_rows else {}
    popularity = Counter()
    if train_rows:
        pairs = {(r[args.user_col], r[args.item_col]) for r in train_rows}
        popularity = Counter(item for _, item in pairs)

    catalog = set(popularity)
    for rel in test.values():
        catalog.update(rel)
    max_k = max(args.k)
    recommended = {i for u in eval_users for i in recs.get(u, [])[:max_k]}
    unknown = recommended - catalog
    if unknown and train_rows is not None:
        warnings.append(
            "%d recommended item IDs never appear in train or test. Check the ID "
            "mapping between model and data (a common silent bug), or pass "
            "--catalog-size. They are counted as catalog items for coverage."
            % len(unknown))
    catalog |= unknown
    catalog_size = args.catalog_size or len(catalog)
    if args.catalog_size and len(recommended) > args.catalog_size:
        warnings.append("--catalog-size %d is smaller than the %d distinct items "
                        "recommended; coverage is capped at 1."
                        % (args.catalog_size, len(recommended)))

    head = set()
    if popularity:
        ranked_items = sorted(catalog, key=lambda i: (-popularity.get(i, 0), i))
        head = set(ranked_items[:max(1, int(len(ranked_items) * args.head_fraction))])

    report = {"users_evaluated": len(eval_users),
              "users_without_recommendations": len(missing),
              "catalog_size": catalog_size,
              "metrics": {}}
    per_user = defaultdict(dict)
    for k in args.k:
        sums = Counter()
        rec_counts = Counter()
        seen_slots = slots = 0
        rec_pop_sum = 0.0
        tail_slots = short_lists = 0
        for user in eval_users:
            ranked = recs.get(user, [])
            if user in recs and len(ranked) < k:
                short_lists += 1
            m = user_metrics(ranked, test[user], k)
            for name in METRIC_NAMES:
                sums[name] += m[name]
                per_user[user]["%s@%d" % (name, k)] = m[name]
            for item in ranked[:k]:
                slots += 1
                rec_counts[item] += 1
                if item in seen.get(user, ()):
                    seen_slots += 1
                if popularity:
                    rec_pop_sum += popularity.get(item, 0)
                    if item not in head:
                        tail_slots += 1
        block = {name: round(sums[name] / len(eval_users), 6)
                 for name in METRIC_NAMES}
        block["coverage"] = round(min(1.0, len(rec_counts) / catalog_size), 6)
        counts = [rec_counts.get(item, 0) for item in catalog]
        # Items of a larger real catalog that never appear count as zero exposure.
        counts += [0] * max(0, catalog_size - len(counts))
        block["gini"] = round(gini(counts), 6)
        block["users_with_short_lists"] = short_lists
        if train_rows:
            block["seen_item_rate"] = round(seen_slots / slots, 6) if slots else 0.0
            block["avg_rec_popularity"] = round(rec_pop_sum / slots, 6) if slots else 0.0
            block["long_tail_share"] = round(tail_slots / slots, 6) if slots else 0.0
        report["metrics"]["@%d" % k] = block

    if train_rows:
        test_pop = [popularity.get(i, 0) for u in eval_users for i in test[u]]
        report["avg_test_item_popularity"] = round(sum(test_pop) / len(test_pop), 6)
        rates = ["%.1f%% at %s" % (100 * b["seen_item_rate"], name)
                 for name, b in report["metrics"].items() if b["seen_item_rate"] > 0]
        if rates:
            warnings.append(
                "Recommended slots that are items the user already has in train: "
                "%s. Expected if the product shows repeats (--keep-repeats); "
                "otherwise filter them out before scoring." % ", ".join(rates))
        # A purely collaborative model trained on train cannot score items that
        # have no train interactions. Hits on them are the strongest leak signal.
        test_only = {i for i in recommended if i not in popularity and i in catalog
                     and i not in unknown}
        if test_only:
            hits = sum(1 for u in eval_users
                       for i in recs.get(u, [])[:max_k] if i in test_only and i in test[u])
            warnings.append(
                "%d recommended items have no interactions in train (they appear only "
                "in test); %d recommended slots with them are hits. A purely "
                "collaborative model trained before the cutoff cannot score them, so "
                "check its training cutoff. Expected for content-based, "
                "feature-based, fresh-item or exploration sources."
                % (len(test_only), hits))
    return report, per_user


def cmd_evaluate(args):
    warnings = []
    recs = load_recommendations(args.recs, args, warnings)
    test = load_test(args.test, args)
    train_rows = None
    if args.train:
        _, train_rows = read_rows(args.train, [args.user_col, args.item_col])
    else:
        warnings.append("No --train given: seen-item rate and popularity-bias "
                        "metrics are skipped.")
    report, per_user = evaluate(recs, test, train_rows, args, warnings)
    report["warnings"] = warnings
    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    if args.per_user:
        n_train = Counter(r[args.user_col] for r in train_rows) if train_rows else {}
        columns = sorted({c for row in per_user.values() for c in row})
        rows = []
        for user in sorted(per_user):
            row = {"user_id": user, "n_train": n_train.get(user, 0)}
            row.update(per_user[user])
            rows.append(row)
        write_rows(args.per_user, ["user_id", "n_train"] + columns, rows)
    return 0


def cmd_compare(args):
    warnings = []
    test = load_test(args.test, args)
    train_rows = None
    if args.train:
        _, train_rows = read_rows(args.train, [args.user_col, args.item_col])
    args.k = [args.at]
    _, per_a = evaluate(load_recommendations(args.recs_a, args, warnings),
                        test, train_rows, args, warnings)
    _, per_b = evaluate(load_recommendations(args.recs_b, args, warnings),
                        test, train_rows, args, warnings)
    key = "%s@%d" % (args.metric, args.at)
    users = sorted(per_a)
    diffs = [per_b[u][key] - per_a[u][key] for u in users]
    rng = random.Random(args.seed)
    n = len(diffs)
    means = []
    for _ in range(args.samples):
        means.append(sum(diffs[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    low = means[int(0.025 * (args.samples - 1))]
    high = means[int(0.975 * (args.samples - 1))]
    mean_a = sum(per_a[u][key] for u in users) / n
    mean_b = sum(per_b[u][key] for u in users) / n
    if n < MIN_USERS_FOR_BOOTSTRAP:
        warnings.append("Only %d users: the bootstrap interval is not reliable "
                        "below %d users." % (n, MIN_USERS_FOR_BOOTSTRAP))
    result = {
        "metric": key,
        "users": n,
        "a": round(mean_a, 6),
        "b": round(mean_b, 6),
        "b_minus_a": round(mean_b - mean_a, 6),
        "relative_change": round((mean_b - mean_a) / mean_a, 6) if mean_a else None,
        "ci95_b_minus_a": [round(low, 6), round(high, 6)],
        "users_better_in_b": sum(1 for d in diffs if d > 0),
        "users_worse_in_b": sum(1 for d in diffs if d < 0),
        "significant_at_95": low > 0 or high < 0,
        "warnings": sorted(set(warnings)),
    }
    print(json.dumps(result, indent=2))
    return 0


# ---------------------------------------------------------------- CLI

def add_columns(parser):
    parser.add_argument("--user-col", default="user_id")
    parser.add_argument("--item-col", default="item_id")


def add_metric_options(parser):
    parser.add_argument("--train", help="Train CSV; enables seen-item and popularity checks.")
    parser.add_argument("--rank-col", default="rank")
    parser.add_argument("--score-col", default="score")
    parser.add_argument("--relevance-col", default=None,
                        help="Graded relevance column in test (gain > 0 is relevant). "
                             "Default: every test interaction has gain 1.")
    parser.add_argument("--catalog-size", type=int, default=None,
                        help="Number of recommendable items. Default: items in train or test.")
    parser.add_argument("--head-fraction", type=float, default=DEFAULT_HEAD_FRACTION,
                        help="Share of most popular items treated as head (default 0.2).")


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("split", help="Global time-based train/test split.")
    p.add_argument("--interactions", required=True)
    p.add_argument("--out-dir", required=True)
    add_columns(p)
    p.add_argument("--time-col", default="timestamp")
    p.add_argument("--cutoff", default=None,
                   help="Timestamp; interactions before it go to train. "
                        "Overrides --test-fraction.")
    p.add_argument("--test-fraction", type=float, default=DEFAULT_TEST_FRACTION)
    p.add_argument("--keep-cold-users", action="store_true")
    p.add_argument("--keep-repeats", action="store_true")
    p.set_defaults(func=cmd_split)

    p = sub.add_parser("popularity", help="Most-popular baseline recommendations.")
    p.add_argument("--train", required=True)
    p.add_argument("--test", required=True, help="Users to recommend for.")
    p.add_argument("--out", required=True)
    p.add_argument("--k", type=int, default=10)
    p.add_argument("--keep-seen", action="store_true",
                   help="Do not remove the user's train items (repeat products).")
    p.add_argument("--personal-first", action="store_true",
                   help="User's own most frequent train items first, then popular "
                        "items ('buy again' baseline). Implies --keep-seen.")
    p.add_argument("--window-days", type=float, default=None,
                   help="Count popularity only in the last N days of train "
                        "(needs --time-col in epoch seconds or ISO-8601).")
    p.add_argument("--time-col", default="timestamp")
    add_columns(p)
    p.set_defaults(func=cmd_popularity)

    p = sub.add_parser("evaluate", help="Metrics for one recommendations file.")
    p.add_argument("--recs", required=True)
    p.add_argument("--test", required=True)
    p.add_argument("--k", type=int, nargs="+", default=[10])
    p.add_argument("--json", help="Also write the report to this file.")
    p.add_argument("--per-user", help="Write per-user metrics CSV (for segment analysis).")
    add_columns(p)
    add_metric_options(p)
    p.set_defaults(func=cmd_evaluate)

    p = sub.add_parser("compare", help="Paired bootstrap: is B better than A?")
    p.add_argument("--recs-a", required=True)
    p.add_argument("--recs-b", required=True)
    p.add_argument("--test", required=True)
    p.add_argument("--metric", choices=METRIC_NAMES, default="ndcg")
    p.add_argument("--at", type=int, default=10)
    p.add_argument("--samples", type=int, default=DEFAULT_BOOTSTRAP_SAMPLES)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    add_columns(p)
    add_metric_options(p)
    p.set_defaults(func=cmd_compare)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    k_values = getattr(args, "k", None)
    if isinstance(k_values, int):
        k_values = [k_values]
    for k in k_values or []:
        if k <= 0:
            print("error: --k values must be positive.", file=sys.stderr)
            return 2
    problems = []
    if hasattr(args, "head_fraction") and not 0 < args.head_fraction < 1:
        problems.append("--head-fraction must be between 0 and 1.")
    if getattr(args, "at", 1) <= 0:
        problems.append("--at must be positive.")
    if getattr(args, "samples", MIN_BOOTSTRAP_SAMPLES) < MIN_BOOTSTRAP_SAMPLES:
        problems.append("--samples must be at least %d." % MIN_BOOTSTRAP_SAMPLES)
    if getattr(args, "window_days", None) is not None and args.window_days <= 0:
        problems.append("--window-days must be positive.")
    if getattr(args, "catalog_size", None) is not None and args.catalog_size <= 0:
        problems.append("--catalog-size must be positive.")
    if problems:
        for problem in problems:
            print("error: %s" % problem, file=sys.stderr)
        return 2
    try:
        return args.func(args)
    except InputError as error:
        print("error: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
