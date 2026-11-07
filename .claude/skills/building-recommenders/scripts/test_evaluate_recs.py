#!/usr/bin/env python3
"""Tests for evaluate_recs.py. Run: python3 -m unittest test_evaluate_recs -v
(from the scripts folder). Expected values are computed by hand in comments."""

import contextlib
import csv
import io
import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import evaluate_recs as er  # noqa: E402


def write_csv(path, header, rows):
    with open(path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = er.main(argv)
    return code, out.getvalue(), err.getvalue()


class UserMetricsTest(unittest.TestCase):
    def test_binary_at_4(self):
        # ranked a b c d, relevant b d -> hits at positions 2 and 4
        m = er.user_metrics(["a", "b", "c", "d"], {"b": 1.0, "d": 1.0}, 4)
        dcg = 1 / math.log2(3) + 1 / math.log2(5)
        idcg = 1 + 1 / math.log2(3)
        self.assertAlmostEqual(m["precision"], 0.5)
        self.assertAlmostEqual(m["recall"], 1.0)
        self.assertAlmostEqual(m["hit_rate"], 1.0)
        self.assertAlmostEqual(m["ndcg"], dcg / idcg)          # 0.650921
        self.assertAlmostEqual(m["map"], (1 / 2 + 2 / 4) / 2)  # 0.5
        self.assertAlmostEqual(m["mrr"], 0.5)

    def test_binary_at_2(self):
        m = er.user_metrics(["a", "b", "c", "d"], {"b": 1.0, "d": 1.0}, 2)
        self.assertAlmostEqual(m["precision"], 0.5)
        self.assertAlmostEqual(m["recall"], 0.5)
        self.assertAlmostEqual(m["ndcg"], (1 / math.log2(3)) / (1 + 1 / math.log2(3)))
        self.assertAlmostEqual(m["map"], 0.5 / 2)  # AP divides by min(|rel|, k) = 2

    def test_short_list_is_penalised(self):
        m = er.user_metrics(["b"], {"b": 1.0}, 10)
        self.assertAlmostEqual(m["precision"], 0.1)
        self.assertAlmostEqual(m["recall"], 1.0)
        self.assertAlmostEqual(m["ndcg"], 1.0)

    def test_graded_ndcg(self):
        # gains: x=3, y=1. ranked y x -> DCG = 1/1 + 3/log2(3); ideal = 3 + 1/log2(3)
        m = er.user_metrics(["y", "x"], {"x": 3.0, "y": 1.0}, 2)
        self.assertAlmostEqual(m["ndcg"], (1 + 3 / math.log2(3)) / (3 + 1 / math.log2(3)))

    def test_no_hit(self):
        m = er.user_metrics(["a"], {"z": 1.0}, 5)
        for name in er.METRIC_NAMES:
            self.assertEqual(m[name], 0.0)


class GiniTest(unittest.TestCase):
    def test_even(self):
        self.assertAlmostEqual(er.gini([1, 1, 1, 1]), 0.0)

    def test_concentrated(self):
        self.assertAlmostEqual(er.gini([0, 0, 0, 4]), 0.75)  # (n-1)/n for n=4


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def path(self, name):
        return os.path.join(self.dir, name)

    def test_split_is_time_safe(self):
        rows = [
            ["u1", "a", 1], ["u1", "b", 2], ["u2", "a", 3], ["u2", "c", 4],
            ["u1", "c", 5], ["u1", "a", 6],   # u1 repeats a after cutoff
            ["u3", "b", 7],                   # u3 is a cold-start user
            ["u2", "d", 8],                   # d is a cold-start item
        ]
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"], rows)
        code, out, _ = run(["split", "--interactions", self.path("log.csv"),
                            "--out-dir", self.path("split"), "--cutoff", "5"])
        self.assertEqual(code, 0)
        report = json.loads(out)
        with open(self.path("split/train.csv")) as handle:
            train = list(csv.DictReader(handle))
        with open(self.path("split/test.csv")) as handle:
            test = list(csv.DictReader(handle))
        self.assertTrue(all(float(r["timestamp"]) < 5 for r in train))
        self.assertEqual({(r["user_id"], r["item_id"]) for r in test},
                         {("u1", "c"), ("u2", "d")})
        self.assertEqual(report["dropped_repeat_rows"], 1)
        self.assertEqual(report["dropped_cold_user_rows"], 1)
        self.assertEqual(report["test_rows_with_cold_items"], 1)

    def test_split_iso_timestamps(self):
        rows = [["u1", "a", "2024-01-01T00:00:00"], ["u1", "b", "2024-01-02T00:00:00Z"],
                ["u1", "c", "2024-01-03T00:00:00"]]
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"], rows)
        code, out, _ = run(["split", "--interactions", self.path("log.csv"),
                            "--out-dir", self.path("s"), "--cutoff", "2024-01-03"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["test_rows"], 1)

    def test_bad_column_gives_clear_error(self):
        write_csv(self.path("log.csv"), ["user", "item", "ts"], [["u", "i", 1]])
        code, _, err = run(["split", "--interactions", self.path("log.csv"),
                            "--out-dir", self.path("s")])
        self.assertEqual(code, 1)
        self.assertIn("missing column", err)
        self.assertIn("--user-col", err)

    def write_eval_files(self):
        write_csv(self.path("train.csv"), ["user_id", "item_id"],
                  [["u1", "a"], ["u1", "b"], ["u2", "a"], ["u3", "a"], ["u3", "c"]])
        write_csv(self.path("test.csv"), ["user_id", "item_id"],
                  [["u1", "c"], ["u2", "b"], ["u3", "d"]])
        # u1 gets a seen item first; u3 has no recommendations at all.
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "score"],
                  [["u1", "a", 0.9], ["u1", "c", 0.5], ["u2", "b", 0.7], ["u2", "c", 0.1]])

    def test_evaluate_counts_missing_users_and_seen_items(self):
        self.write_eval_files()
        code, out, _ = run(["evaluate", "--recs", self.path("recs.csv"),
                            "--test", self.path("test.csv"),
                            "--train", self.path("train.csv"), "--k", "2"])
        self.assertEqual(code, 0)
        report = json.loads(out)
        m = report["metrics"]["@2"]
        self.assertEqual(report["users_evaluated"], 3)
        self.assertEqual(report["users_without_recommendations"], 1)
        # recall: u1 1, u2 1, u3 0 -> 2/3
        self.assertAlmostEqual(m["recall"], 2 / 3, places=5)
        # mrr: u1 1/2, u2 1, u3 0 -> 0.5
        self.assertAlmostEqual(m["mrr"], 0.5, places=5)
        # 1 of 4 recommended slots is a train item of that user
        self.assertAlmostEqual(m["seen_item_rate"], 0.25, places=5)
        # catalog = a b c d; recommended a b c
        self.assertAlmostEqual(m["coverage"], 0.75, places=5)
        self.assertTrue(any("no recommendations" in w for w in report["warnings"]))

    def test_popularity_excludes_seen(self):
        self.write_eval_files()
        code, _, _ = run(["popularity", "--train", self.path("train.csv"),
                          "--test", self.path("test.csv"),
                          "--out", self.path("pop.csv"), "--k", "2"])
        self.assertEqual(code, 0)
        with open(self.path("pop.csv")) as handle:
            rows = list(csv.DictReader(handle))
        by_user = {}
        for row in rows:
            by_user.setdefault(row["user_id"], []).append(row["item_id"])
        self.assertEqual(by_user["u1"], ["c"])        # a, b seen; only c left
        self.assertEqual(by_user["u2"], ["b", "c"])   # a seen; b and c tie, sorted by id

    def test_compare_detects_clear_win(self):
        users = ["u%d" % i for i in range(30)]
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [[u, "x"] for u in users])
        write_csv(self.path("a.csv"), ["user_id", "item_id", "rank"], [[u, "y", 1] for u in users])
        write_csv(self.path("b.csv"), ["user_id", "item_id", "rank"], [[u, "x", 1] for u in users])
        code, out, _ = run(["compare", "--recs-a", self.path("a.csv"),
                            "--recs-b", self.path("b.csv"), "--test", self.path("test.csv"),
                            "--metric", "hit_rate", "--at", "1", "--samples", "200"])
        self.assertEqual(code, 0)
        result = json.loads(out)
        self.assertEqual(result["b_minus_a"], 1.0)
        self.assertTrue(result["significant_at_95"])
        self.assertEqual(result["warnings"], [])

    def test_compare_warns_on_few_users(self):
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "x"]])
        write_csv(self.path("a.csv"), ["user_id", "item_id", "rank"], [["u1", "y", 1]])
        write_csv(self.path("b.csv"), ["user_id", "item_id", "rank"], [["u1", "x", 1]])
        _, out, _ = run(["compare", "--recs-a", self.path("a.csv"),
                         "--recs-b", self.path("b.csv"), "--test", self.path("test.csv")])
        self.assertTrue(any("not reliable" in w for w in json.loads(out)["warnings"]))

    # ---- tests added after the review

    def write_repeat_files(self):
        # u1 bought a twice and b once; c is popular with others.
        write_csv(self.path("train.csv"), ["user_id", "item_id", "timestamp"],
                  [["u1", "a", 1], ["u1", "a", 2], ["u1", "b", 3],
                   ["u2", "c", 4], ["u3", "c", 5], ["u2", "b", 6]])
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "a"]])

    def read_lists(self, name):
        with open(self.path(name)) as handle:
            rows = list(csv.DictReader(handle))
        lists = {}
        for row in rows:
            lists.setdefault(row["user_id"], []).append(row["item_id"])
        return lists

    def test_popularity_keep_seen_does_not_filter(self):
        self.write_repeat_files()
        code, _, _ = run(["popularity", "--train", self.path("train.csv"),
                          "--test", self.path("test.csv"), "--out", self.path("p.csv"),
                          "--k", "3", "--keep-seen"])
        self.assertEqual(code, 0)
        # distinct-user counts: b 2, c 2, a 1 -> b, c, a; nothing removed
        self.assertEqual(self.read_lists("p.csv")["u1"], ["b", "c", "a"])

    def test_popularity_personal_first(self):
        self.write_repeat_files()
        run(["popularity", "--train", self.path("train.csv"), "--test", self.path("test.csv"),
             "--out", self.path("p.csv"), "--k", "3", "--personal-first"])
        # own counts a 2, b 1 first, then global c
        self.assertEqual(self.read_lists("p.csv")["u1"], ["a", "b", "c"])

    def test_popularity_window_days(self):
        day = 86400
        write_csv(self.path("train.csv"), ["user_id", "item_id", "timestamp"],
                  [["u1", "old", 0], ["u2", "old", 1], ["u3", "old", 2],
                   ["u4", "new", 30 * day], ["u9", "x", 31 * day]])
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u5", "new"]])
        run(["popularity", "--train", self.path("train.csv"), "--test", self.path("test.csv"),
             "--out", self.path("p.csv"), "--k", "1", "--window-days", "7"])
        # within the last 7 days only "new" and "x" count; tie broken by id
        self.assertEqual(self.read_lists("p.csv")["u5"], ["new"])

    def test_split_writes_cold_users_and_counts_repeats(self):
        rows = [["u1", "a", 1], ["u1", "a", 6], ["u1", "a", 7], ["u1", "b", 8],
                ["u9", "a", 9]]
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"], rows)
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("s"), "--cutoff", "5"])
        report = json.loads(out)
        self.assertEqual(report["dropped_repeat_rows"], 2)
        self.assertEqual(report["cold_test_users"], 1)
        self.assertEqual(self.read_lists("s/test_cold_users.csv"), {"u9": ["a"]})
        # 2 of 4 later rows are repeats = 50%, not above the 50% threshold
        self.assertFalse(any("repeat-driven" in w for w in report["warnings"]))
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("k"), "--cutoff", "5", "--keep-repeats"])
        self.assertEqual(json.loads(out)["dropped_repeat_rows"], 0)
        self.assertEqual(self.read_lists("k/test.csv"), {"u1": ["a", "a", "b"]})

    def test_split_warns_on_mostly_repeats(self):
        rows = [["u1", "a", 1], ["u1", "a", 6], ["u1", "a", 7], ["u1", "b", 8]]
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"], rows)
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("s"), "--cutoff", "5"])
        self.assertTrue(any("repeat-driven" in w for w in json.loads(out)["warnings"]))

    def test_split_warns_on_mixed_seconds_and_ms(self):
        rows = [["u1", "a", 1700000000], ["u1", "b", 1700000500000], ["u1", "c", 1700000900]]
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"], rows)
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("s"), "--cutoff", "1700000800"])
        self.assertTrue(any("millisecond" in w for w in json.loads(out)["warnings"]))

    def test_split_empty_side_shows_data_range(self):
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"],
                  [["u1", "a", "2024-01-01T00:00:00.5Z"], ["u1", "b", "2024-01-02T00:00:00"]])
        code, _, err = run(["split", "--interactions", self.path("log.csv"),
                            "--out-dir", self.path("s"), "--cutoff", "20240311"])
        self.assertEqual(code, 1)
        self.assertIn("Data times run from", err)  # also proves .5Z parsed

    def test_evaluate_unknown_items_and_coverage_cap(self):
        write_csv(self.path("train.csv"), ["user_id", "item_id"], [["u1", "a"], ["u2", "b"]])
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "b"]])
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "rank"],
                  [["u1", "x1", 1], ["u1", "x2", 2], ["u1", "x3", 3], ["u1", "b", 4]])
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"), "--test",
                         self.path("test.csv"), "--train", self.path("train.csv"), "--k", "4"])
        report = json.loads(out)
        self.assertLessEqual(report["metrics"]["@4"]["coverage"], 1.0)
        self.assertEqual(report["catalog_size"], 5)  # a, b + 3 unknown
        self.assertTrue(any("never appear in train or test" in w for w in report["warnings"]))
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"), "--test",
                         self.path("test.csv"), "--train", self.path("train.csv"),
                         "--k", "4", "--catalog-size", "2"])
        report = json.loads(out)
        self.assertEqual(report["metrics"]["@4"]["coverage"], 1.0)
        self.assertTrue(any("capped at 1" in w for w in report["warnings"]))

    def test_gini_uses_catalog_size(self):
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "a"], ["u2", "a"]])
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "rank"],
                  [["u1", "a", 1], ["u2", "a", 1]])
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"), "--test",
                         self.path("test.csv"), "--k", "1", "--catalog-size", "4"])
        # counts [2, 0, 0, 0] -> Gini 0.75 instead of 0 for a 1-item catalog
        self.assertAlmostEqual(json.loads(out)["metrics"]["@1"]["gini"], 0.75)

    def test_nan_and_inf_scores_rejected(self):
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "a"]])
        for bad in ["nan", "inf"]:
            write_csv(self.path("recs.csv"), ["user_id", "item_id", "score"], [["u1", "a", bad]])
            code, _, err = run(["evaluate", "--recs", self.path("recs.csv"),
                                "--test", self.path("test.csv")])
            self.assertEqual(code, 1)
            self.assertIn("NaN or infinite", err)

    def test_tied_scores_and_short_lists_reported(self):
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "a"], ["u2", "a"]])
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "score"],
                  [["u1", "a", 1], ["u1", "b", 1], ["u1", "c", 0.5], ["u2", "a", 1]])
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"),
                         "--test", self.path("test.csv"), "--k", "3"])
        report = json.loads(out)
        self.assertTrue(any("tied" in w for w in report["warnings"]))
        self.assertEqual(report["metrics"]["@3"]["users_with_short_lists"], 1)

    def test_tie_at_k_boundary_is_reported(self):
        # a=3, b=2, c=2, k=2: the b/c tie at positions 2 and 3 decides the list
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "c"]])
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "score"],
                  [["u1", "a", 3], ["u1", "b", 2], ["u1", "c", 2]])
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"),
                         "--test", self.path("test.csv"), "--k", "2"])
        warnings = json.loads(out)["warnings"]
        self.assertTrue(any("between positions 2 and 3" in w for w in warnings))
        self.assertFalse(any("values in the top 2" in w for w in warnings))  # no tie inside top 2

    def test_split_without_cold_users_writes_no_cold_file(self):
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"],
                  [["u1", "a", 1], ["u1", "b", 6]])
        cold = self.path("s/test_cold_users.csv")
        os.makedirs(self.path("s"))
        with open(cold, "w") as handle:  # stale file from an earlier run
            handle.write("user_id,item_id,timestamp\nold,x,1\n")
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("s"), "--cutoff", "5"])
        report = json.loads(out)
        self.assertEqual(report["cold_test_users"], 0)
        self.assertIsNone(report["cold_users_file"])
        self.assertFalse(os.path.exists(cold))

    def test_cold_users_flow_with_their_own_popularity_file(self):
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"],
                  [["u1", "a", 1], ["u2", "a", 2], ["u3", "b", 3],
                   ["u1", "b", 6], ["u9", "a", 7]])
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("s"), "--cutoff", "5"])
        self.assertTrue(json.loads(out)["cold_users_file"].endswith("test_cold_users.csv"))
        run(["popularity", "--train", self.path("s/train.csv"),
             "--test", self.path("s/test_cold_users.csv"), "--out", self.path("pc.csv"),
             "--k", "1"])
        _, out, _ = run(["evaluate", "--recs", self.path("pc.csv"),
                         "--test", self.path("s/test_cold_users.csv"), "--k", "1"])
        report = json.loads(out)
        self.assertEqual(report["users_without_recommendations"], 0)
        self.assertEqual(report["metrics"]["@1"]["hit_rate"], 1.0)  # a is most popular

    def test_seen_item_warning_names_each_k(self):
        write_csv(self.path("train.csv"), ["user_id", "item_id"], [["u1", "a"], ["u2", "b"]])
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "b"]])
        # seen item a at position 2: 0% of slots at @1, 50% at @2
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "rank"],
                  [["u1", "b", 1], ["u1", "a", 2]])
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"), "--test",
                         self.path("test.csv"), "--train", self.path("train.csv"),
                         "--k", "1", "2"])
        warning = [w for w in json.loads(out)["warnings"] if "already has in train" in w][0]
        self.assertIn("50.0% at @2", warning)
        self.assertNotIn("@1", warning)

    def test_items_without_train_interactions_are_flagged(self):
        write_csv(self.path("train.csv"), ["user_id", "item_id"], [["u1", "a"], ["u2", "b"]])
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "new"]])
        write_csv(self.path("recs.csv"), ["user_id", "item_id", "rank"], [["u1", "new", 1]])
        _, out, _ = run(["evaluate", "--recs", self.path("recs.csv"), "--test",
                         self.path("test.csv"), "--train", self.path("train.csv"), "--k", "1"])
        warning = [w for w in json.loads(out)["warnings"] if "no interactions in train" in w]
        self.assertEqual(len(warning), 1)
        self.assertIn("1 recommended items", warning[0])
        self.assertIn("1 recommended slots with them are hits", warning[0])
        self.assertIn("fresh-item or exploration sources", warning[0])

    def test_bad_cli_values_give_clean_errors(self):
        write_csv(self.path("test.csv"), ["user_id", "item_id"], [["u1", "a"]])
        write_csv(self.path("r.csv"), ["user_id", "item_id", "rank"], [["u1", "a", 1]])
        base = ["compare", "--recs-a", self.path("r.csv"), "--recs-b", self.path("r.csv"),
                "--test", self.path("test.csv")]
        for extra, text in [(["--at", "0"], "--at"), (["--samples", "0"], "--samples")]:
            code, out, err = run(base + extra)
            self.assertEqual(code, 2)
            self.assertIn(text, err)
            self.assertNotIn("Traceback", err)

    def test_split_warns_when_test_users_are_mostly_cold(self):
        rows = [["u1", "a", 1], ["u2", "a", 10], ["u3", "b", 11], ["u4", "c", 12]]
        write_csv(self.path("log.csv"), ["user_id", "item_id", "timestamp"], rows)
        _, out, _ = run(["split", "--interactions", self.path("log.csv"),
                         "--out-dir", self.path("s"), "--cutoff", "5"])
        self.assertTrue(json.loads(out)["warnings"])


if __name__ == "__main__":
    unittest.main()
