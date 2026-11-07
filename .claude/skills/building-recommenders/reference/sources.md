# Sources

The guidance in this skill is a synthesis in our own words. Use these when the user asks
where a rule comes from or wants to read further.

## Foundations
- Google for Developers, Recommendation Systems course (candidate generation, matrix
  factorization and WALS, softmax and two-tower models, retrieval, scoring, re-ranking).
  developers.google.com/machine-learning/recommendation
- Ekstrand, Riedl, Konstan. Collaborative Filtering Recommender Systems. Foundations and
  Trends in HCI 4(2), 2011. DOI 10.1561/1100000009. (User-user and item-item CF details,
  normalisation, damping, offline evaluation structure, diversity and serendipity.)
- Aggarwal. Recommender Systems: The Textbook. Springer, 2016. (Topic map.)
- Koren, Bell, Volinsky. Matrix Factorization Techniques for Recommender Systems. IEEE
  Computer 42(8), 2009. DOI 10.1109/MC.2009.263. (Biased MF, SGD vs ALS, implicit
  signals, temporal dynamics.)

## Models
- Hu, Koren, Volinsky. Collaborative Filtering for Implicit Feedback Datasets. ICDM 2008.
  (Preference vs confidence, weighted ALS, time-based evaluation.)
- Rendle, Freudenthaler, Gantner, Schmidt-Thieme. BPR: Bayesian Personalized Ranking from
  Implicit Feedback. UAI 2009, arXiv 1205.2618. (Pairwise ranking loss, bootstrap
  sampling.)
- Rendle, Krichene, Zhang, Anderson. Neural Collaborative Filtering vs. Matrix
  Factorization Revisited. RecSys 2020, arXiv 2005.09683. (Dot product as a strong
  default.)
- Steck. Embarrassingly Shallow Autoencoders for Sparse Data (EASE). WWW 2019, arXiv
  1905.03375. (Closed-form linear item-item model, strong on implicit data.)
- Ning, Karypis. SLIM: Sparse Linear Methods for Top-N Recommender Systems. ICDM 2011.
- Ludewig, Jannach. Evaluation of Session-based Recommendation Algorithms. User Modeling
  and User-Adapted Interaction 2018, arXiv 1803.09587. (Session-kNN often matches or beats
  GRU4Rec.)
- Covington, Adams, Sargin. Deep Neural Networks for YouTube Recommendations. RecSys 2016.
  (Two-stage system, next-item prediction, example age, per-user example caps.)
- Yi et al. Sampling-Bias-Corrected Neural Modeling for Large Corpus Item
  Recommendations. RecSys 2019. (In-batch negatives and frequency correction.)

## Evaluation
- Li, Jullien, Ariannezhad, de Rijke. A Next Basket Recommendation Reality Check. ACM
  TOIS 41(4), 2023, DOI 10.1145/3587153, arXiv 2109.14233. (Separates repeat and new
  items when evaluating next-basket models; re-checks reported gains.)
- Krichene, Rendle. On Sampled Metrics for Item Recommendation. KDD 2020. (Sampled
  metrics are inconsistent.)
- Ji, Sun, Zhang, Li. A Critical Study on Data Leakage in Recommender System Offline
  Evaluation. arXiv 2010.11060. (Global-timeline leakage.)
- Ferrari Dacrema, Cremonesi, Jannach. Are We Really Making Much Progress? RecSys 2019,
  arXiv 1907.06902. (Tuned simple baselines vs neural methods.)

## Libraries mentioned
- implicit (github.com/benfred/implicit), LightFM (github.com/lyst/lightfm), RecBole
  (github.com/RUCAIBox/RecBole), Microsoft Recommenders
  (github.com/recommenders-team/recommenders), Spark MLlib ALS.
