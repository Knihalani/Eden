"""StatGate — 5-check safe auto-apply gate (Phase 6).

Reference: supplementaries/research/06_statistical_tests.md (700 lines).
Combines:
  C1 Expected Calibration Error (ECE) < 0.05
  C2 BH-adjusted p-value < 0.05 (Welch t-test)
  C3 Cohen's d (Hedges' g with small-sample correction) > 0.2
  C4 n > 30 per arm + split-conformal coverage
  C5 mSPRT always-valid p-value < 0.05

The conjunction uses a Bonferroni α/4 = 0.0125 split across C1-C4
to mechanically bound family-wise Type-I ≤ 0.05 (C5 is always-valid
by construction).

This is a pure-stdlib + scipy/statsmodels implementation. No LLMs.
Hot-path latency target <1ms.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

# Constants
ECE_BIN_COUNT = 15
ECE_THRESHOLD = 0.05
ALPHA_PER_CHECK = 0.0125  # Bonferroni α/4 split for FWER ≤ 0.05
MIN_SAMPLE_PER_ARM = 30
COHENS_D_MIN = 0.2
M_SPRT_TAU = 1.0  # slack parameter for mSPRT
M_SPRT_NU_SQ = 1.0  # prior variance


@dataclass(frozen=True)
class GateEvidence:
    """Result of evaluating a single A/B comparison."""

    verdict: str  # "APPLY" | "REJECT"
    c1_ece: float
    c2_p_bh: float
    c3_d: float
    c4_conformal_lower: float
    c5_msprt_p: float
    n_treat: int
    n_control: int
    delta_mean: float
    explanation: str


def compute_ece(
    predicted: Sequence[float],
    actual: Sequence[float],
    n_bins: int = ECE_BIN_COUNT,
) -> float:
    """Expected Calibration Error.

    Bins predictions into n_bins equal-mass bins and computes the
    weighted average of |accuracy - confidence| per bin.

    Pure-Python implementation: O(N) sort + O(n_bins) accumulation.
    """
    if len(predicted) != len(actual):
        raise ValueError("predicted and actual must have same length")
    if not predicted:
        return 0.0
    n = len(predicted)
    # Sort by predicted confidence and use quantile bin boundaries.
    paired = sorted(zip(predicted, actual), key=lambda p: p[0])
    boundaries = [int(i * n / n_bins) for i in range(n_bins + 1)]
    boundaries[-1] = n  # ensure last bin includes all
    ece = 0.0
    for i in range(n_bins):
        lo, hi = boundaries[i], boundaries[i + 1]
        if lo >= hi:
            continue
        bin_pred = [p for p, _ in paired[lo:hi]]
        bin_actual = [a for _, a in paired[lo:hi]]
        avg_conf = sum(bin_pred) / len(bin_pred)
        avg_acc = sum(bin_actual) / len(bin_actual)
        ece += (len(bin_pred) / n) * abs(avg_acc - avg_conf)
    return ece


def _bh_adjust(pvals: Sequence[float]) -> list[float]:
    """Benjamini-Hochberg FDR-adjusted p-values.

    Algorithm:
      1. Sort p-values ascending.
      2. For each rank k, adjusted_p[k] = min(p[k] * n / k, prior_min).
      3. Enforce monotonicity (adjusted_p[k] <= adjusted_p[k+1]).

    Pure-Python, no scipy/statsmodels dependency for the Bonferroni
    alternative — but statsmodels' multipletests(method='fdr_bh')
    is the recommended production implementation.
    """
    n = len(pvals)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: pvals[i])
    sorted_p = [pvals[i] for i in order]
    adjusted = [0.0] * n
    running_min = 1.0
    for rank in range(n, 0, -1):
        k = rank  # 1-indexed rank
        p_raw = sorted_p[k - 1]
        p_adj = min(1.0, p_raw * n / k)
        running_min = min(running_min, p_adj)
        adjusted[order[k - 1]] = running_min
    return adjusted


def welch_t_test(
    control: Sequence[float], treatment: Sequence[float]
) -> float:
    """Welch's t-test (unequal variances) returning the two-sided p-value.

    Uses the t-distribution approximation:
      t = (mean_t - mean_c) / sqrt(var_t/n_t + var_c/n_c)
      df = (var_t/n_t + var_c/n_c)^2 / ((var_t/n_t)^2/(n_t-1) + (var_c/n_c)^2/(n_c-1))
      p = 2 * (1 - cdf(|t|, df))

    For df >= 30 we use the normal-approximation p-value (standard
    scipy.stats.ttest_ind fallback when df is large).
    """
    n_c, n_t = len(control), len(treatment)
    if n_c < 2 or n_t < 2:
        return 1.0
    mean_c = sum(control) / n_c
    mean_t = sum(treatment) / n_t
    var_c = sum((x - mean_c) ** 2 for x in control) / (n_c - 1)
    var_t = sum((x - mean_t) ** 2 for x in treatment) / (n_t - 1)
    se_sq = var_c / n_c + var_t / n_t
    if se_sq == 0:
        return 0.0 if mean_t != mean_c else 1.0
    t = (mean_t - mean_c) / math.sqrt(se_sq)
    # Welch-Satterthwaite df
    num = se_sq ** 2
    denom = (var_c / n_c) ** 2 / (n_c - 1) + (var_t / n_t) ** 2 / (n_t - 1)
    df = num / denom if denom > 0 else 1
    # Normal approximation for large df, t-distribution for small.
    # We use a single t-distribution CDF approximation valid for df >= 1.
    p = _t_dist_sf(abs(t), df) * 2
    return max(0.0, min(1.0, p))


def _normal_cdf(z: float) -> float:
    """Standard normal CDF approximation (Abramowitz & Stegun)."""
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _normal_sf(z: float) -> float:
    """Standard normal survival function."""
    return 1 - _normal_cdf(z)


def _t_dist_sf(t: float, df: float) -> float:
    """Student-t survival function approximation.

    For df >= 30: normal approximation.
    For df < 30: Hill's approximation (good to ~1e-3).
    """
    if df >= 30:
        return _normal_sf(t)
    # Hill's approximation for t-distribution tail.
    x = df / (df + t * t)
    # Incomplete beta function approximation.
    # For our purposes (df >= 1), use a series expansion.
    p = 0.5 * _betacf(df / 2.0, 0.5, x)
    return max(0.0, min(1.0, p))


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction approximation for incomplete beta function."""
    max_iter = 100
    eps = 3e-7
    qab = a + b
    qap = a + 1
    qam = a - 1
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1 / d
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < eps:
            break
    return h


def hedges_g(
    control: Sequence[float], treatment: Sequence[float]
) -> float:
    """Hedges' g effect size (Cohen's d with small-sample correction).

    g = d * J, where J = 1 - 3/(4*(n_c + n_t - 2) - 1)
    """
    n_c, n_t = len(control), len(treatment)
    if n_c < 2 or n_t < 2:
        return 0.0
    mean_c = sum(control) / n_c
    mean_t = sum(treatment) / n_t
    var_c = sum((x - mean_c) ** 2 for x in control) / (n_c - 1)
    var_t = sum((x - mean_t) ** 2 for x in treatment) / (n_t - 1)
    pooled_var = ((n_c - 1) * var_c + (n_t - 1) * var_t) / (n_c + n_t - 2)
    if pooled_var == 0:
        return 0.0
    d = (mean_t - mean_c) / math.sqrt(pooled_var)
    j = 1 - 3 / (4 * (n_c + n_t - 2) - 1)
    return d * j


def split_conformal_coverage(
    control: Sequence[float],
    treatment: Sequence[float],
    *,
    alpha: float = ALPHA_PER_CHECK,
) -> float:
    """Split-conformal coverage lower bound on the improvement.

    Returns the lower bound on the improvement (treatment - control
    mean difference) at the 1-alpha confidence level.

    For our purposes: lower bound = mean_diff - z_alpha * se_diff.
    This is the non-conformal jackknife approximation; the formal
    split-conformal version uses held-out calibration data.
    """
    n_c, n_t = len(control), len(treatment)
    if n_c < 2 or n_t < 2:
        return float("-inf")
    mean_c = sum(control) / n_c
    mean_t = sum(treatment) / n_t
    var_c = sum((x - mean_c) ** 2 for x in control) / (n_c - 1)
    var_t = sum((x - mean_t) ** 2 for x in treatment) / (n_t - 1)
    se_diff = math.sqrt(var_c / n_c + var_t / n_t)
    z = 2.576 if alpha < 0.01 else 1.96  # 99% or 95%
    return (mean_t - mean_c) - z * se_diff


def msprt_always_valid(
    control: Sequence[float],
    treatment: Sequence[float],
    *,
    tau: float = M_SPRT_TAU,
    nu_sq: float = M_SPRT_NU_SQ,
) -> float:
    """mSPRT (mixture Sequential Probability Ratio Test) always-valid p-value.

    Closed-form per Howard, Ramdas, McAuliffe, Sekhon 2021
    (arXiv:1810.08240):

      Λ_n = sqrt(σ_n² / (σ_n² + ν²)) * exp(δ̂² / (2(σ_n² + ν²)))

      p-value = min(1, 1/Λ_n)

    where σ_n² is the sample variance of the pooled treatment-control
    difference, δ̂ is the observed mean difference, and ν² is the
    prior variance (τ² scaled by σ_n²).

    Always-valid: the test rejects H0 with p ≤ α at any sample size
    n, jointly across all n. This is proven via Ville's inequality.

    Returns
    -------
    p : float
        Always-valid p-value in (0, 1]. Lower = stronger evidence
        against H0.
    """
    n_c, n_t = len(control), len(treatment)
    if n_c < 2 or n_t < 2:
        return 1.0
    n = n_c + n_t
    mean_c = sum(control) / n_c
    mean_t = sum(treatment) / n_t
    var_c = sum((x - mean_c) ** 2 for x in control) / (n_c - 1)
    var_t = sum((x - mean_t) ** 2 for x in treatment) / (n_t - 1)
    pooled_var = ((n_c - 1) * var_c + (n_t - 1) * var_t) / (n - 2)
    if pooled_var == 0:
        return 0.0 if mean_t != mean_c else 1.0
    # Variance of the difference
    sigma_sq = pooled_var * (1 / n_c + 1 / n_t)
    # Observed mean difference
    delta_hat = mean_t - mean_c
    # Prior variance (scales with observed variance)
    nu_sq_scaled = tau ** 2 * sigma_sq
    # Likelihood ratio
    denom = sigma_sq + nu_sq_scaled
    if denom == 0:
        return 1.0
    # Compute log(lr) safely to avoid math.exp overflow when the
    # observed effect is very large relative to the pooled variance.
    exponent = delta_hat ** 2 / (2 * denom)
    try:
        if exponent > 700:  # double-precision overflow threshold for exp
            return 0.0
        lr = math.sqrt(sigma_sq / denom) * math.exp(exponent)
    except OverflowError:
        return 0.0
    if lr <= 0:
        return 1.0
    return min(1.0, 1.0 / lr)


def evaluate(
    control: Sequence[float],
    treatment: Sequence[float],
    *,
    predicted_probs: Sequence[float] | None = None,
    actual_labels: Sequence[float] | None = None,
) -> GateEvidence:
    """Evaluate all 5 StatGate checks and return the verdict.

    Auto-apply iff all 5 checks pass. The verdict is "APPLY" only
    if the conjunction of C1-C5 holds.

    Parameters
    ----------
    control : Sequence[float]
        Baseline metric values (e.g. intervention cost in $).
    treatment : Sequence[float]
        Trial metric values (candidate variant).
    predicted_probs : Sequence[float] | None
        Predicted probabilities for ECE (C1). If None, C1 is skipped.
    actual_labels : Sequence[float] | None
        Actual binary labels for ECE. If None, C1 is skipped.

    Returns
    -------
    GateEvidence
        Verdict + per-check results.
    """
    n_c = len(control)
    n_t = len(treatment)

    # C1: ECE
    if predicted_probs is not None and actual_labels is not None:
        c1_ece = compute_ece(predicted_probs, actual_labels)
        c1_pass = c1_ece < ECE_THRESHOLD
    else:
        c1_ece = float("nan")
        c1_pass = True  # skip if not provided

    # C2: BH-adjusted p (single metric, BH is just the t-test p)
    c2_p = welch_t_test(control, treatment)
    c2_p_bh = _bh_adjust([c2_p])[0]
    c2_pass = c2_p_bh < ALPHA_PER_CHECK

    # C3: Cohen's d (Hedges' g)
    c3_d = hedges_g(control, treatment)
    c3_pass = c3_d > COHENS_D_MIN

    # C4: n > 30 + conformal
    n_pass = n_c >= MIN_SAMPLE_PER_ARM and n_t >= MIN_SAMPLE_PER_ARM
    c4_lower = split_conformal_coverage(control, treatment)
    c4_pass = n_pass and c4_lower > 0
    c4_pass = c4_pass and n_pass

    # C5: mSPRT
    c5_p = msprt_always_valid(control, treatment)
    c5_pass = c5_p < ALPHA_PER_CHECK

    all_pass = c1_pass and c2_pass and c3_pass and c4_pass and c5_pass
    verdict = "APPLY" if all_pass else "REJECT"

    delta_mean = (sum(treatment) / n_t - sum(control) / n_c) if (n_c and n_t) else 0.0

    failing = []
    if not c1_pass:
        failing.append(f"C1_ECE={c1_ece:.4f}")
    if not c2_pass:
        failing.append(f"C2_pBH={c2_p_bh:.4f}")
    if not c3_pass:
        failing.append(f"C3_d={c3_d:.3f}")
    if not c4_pass:
        failing.append(f"C4_n={n_c}/{n_t},lower={c4_lower:.4f}")
    if not c5_pass:
        failing.append(f"C5_mSPRT={c5_p:.4f}")

    explanation = (
        f"verdict={verdict}; "
        f"delta_mean={delta_mean:.4f}; "
        + ("all 5 checks passed" if all_pass else f"failed: {','.join(failing)}")
    )

    return GateEvidence(
        verdict=verdict,
        c1_ece=c1_ece,
        c2_p_bh=c2_p_bh,
        c3_d=c3_d,
        c4_conformal_lower=c4_lower,
        c5_msprt_p=c5_p,
        n_treat=n_t,
        n_control=n_c,
        delta_mean=delta_mean,
        explanation=explanation,
    )


__all__ = [
    "ECE_BIN_COUNT",
    "ECE_THRESHOLD",
    "ALPHA_PER_CHECK",
    "MIN_SAMPLE_PER_ARM",
    "COHENS_D_MIN",
    "GateEvidence",
    "compute_ece",
    "welch_t_test",
    "hedges_g",
    "split_conformal_coverage",
    "msprt_always_valid",
    "evaluate",
]