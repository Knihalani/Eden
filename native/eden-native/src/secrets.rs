//! The gitleaks half of `packages/redact/src/secrets.ts` (rules (a) only; Eden's own `eden-*` rules are not
//! ported, see the report), over the vendored gitleaks v8.30.1 config, applied as the TS gate applies it:
//! keyword gate, regex, secret group, entropy floor, global and per-rule allowlists. Text has no path, so a
//! path-only rule never runs and an allowlist's path condition never holds.
//!
//! Regexes run as `regex::bytes` with Unicode off: like Go's RE2 (and JavaScript without the `u` flag), `\w`, `\d`,
//! `\s` and `\b` are then ASCII-only; Rust's Unicode-aware defaults would match more and run slower.

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use regex::bytes::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Microseconds since an arbitrary origin; 0 in WebAssembly, where `std::time::Instant` is unavailable.
fn micros() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
        ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1e6
    }
    #[cfg(target_arch = "wasm32")]
    {
        0.0
    }
}

const GITLEAKS_TOML: &str = include_str!("../../../packages/redact/src/vendor/gitleaks/gitleaks.toml");
/// Generous compile limits: several gitleaks rules have large bounded repetitions.
const SIZE_LIMIT: usize = 256 << 20;

#[derive(Deserialize)]
struct Config {
    allowlist: AllowlistConfig,
    rules: Vec<RuleConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleConfig {
    id: String,
    regex: Option<String>,
    secret_group: Option<usize>,
    entropy: Option<f64>,
    keywords: Option<Vec<String>>,
    allowlists: Option<Vec<AllowlistConfig>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AllowlistConfig {
    regex_target: Option<String>,
    condition: Option<String>,
    regexes: Option<Vec<String>>,
    stopwords: Option<Vec<String>>,
    paths: Option<Vec<String>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Secret,
    Match,
    Line,
}

struct Allowlist {
    target: Target,
    and: bool,
    regexes: Vec<Regex>,
    stopwords: Vec<Vec<u8>>,
    has_paths: bool,
}

pub struct Rule {
    pub id: String,
    regex: Regex,
    secret_group: usize,
    entropy: f64,
    has_keywords: bool,
    allowlists: Vec<Allowlist>,
}

pub struct Scanner {
    pub rules: Vec<Rule>,
    global: Allowlist,
    keywords: AhoCorasick,
    /// Per keyword pattern, the rules it selects.
    keyword_rules: Vec<Vec<u32>>,
    /// Rules with no keywords, which always run.
    always: Vec<u32>,
    set: OnceLock<Option<RegexSet>>,
    /// How each regex fared, for the report.
    audit: Vec<Audit>,
    keyword_count: usize,
    report: OnceLock<String>,
}

struct Finding<'a> {
    matched: &'a [u8],
    secret: &'a [u8],
    line: &'a [u8],
}

/// Compiles the way the scanner runs regexes, with whether Unicode stayed off; the error is the `regex` crate's.
fn compile(pattern: &str) -> Result<(Regex, bool), String> {
    let build = |unicode: bool| {
        RegexBuilder::new(pattern)
            .unicode(unicode)
            .size_limit(SIZE_LIMIT)
            .dfa_size_limit(SIZE_LIMIT)
            .build()
    };
    // A pattern that needs Unicode (a non-ASCII literal or class) keeps it.
    build(false)
        .map(|regex| (regex, true))
        .or_else(|_| build(true).map(|regex| (regex, false)))
        .map_err(|err| err.to_string())
}

/// Go's RE2 reads a `{` that starts no valid repetition (`{n}`, `{n,}`, `{n,m}`) as a literal; Rust's `regex` rejects
/// it. Escapes such braces outside character classes; every other construct the vendored rules use is shared.
fn translate(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut in_class = false;
    let mut at = 0;
    while at < chars.len() {
        let ch = chars[at];
        if ch == '\\' {
            out.push(ch);
            if let Some(&next) = chars.get(at + 1) {
                out.push(next);
            }
            at += 2;
            continue;
        }
        if in_class {
            if ch == '[' && chars.get(at + 1) == Some(&':') {
                // A POSIX class `[:name:]` inside a bracket expression: copy through its closing `:]`.
                while at < chars.len() && !(chars[at] == ']' && chars[at - 1] == ':') {
                    out.push(chars[at]);
                    at += 1;
                }
                if at < chars.len() {
                    out.push(']');
                }
                at += 1;
                continue;
            } else if ch == ']' {
                in_class = false;
            }
        } else if ch == '[' {
            in_class = true;
            out.push(ch);
            at += 1;
            // A leading `^`, then a leading `]`, are part of the class, not its end.
            if chars.get(at) == Some(&'^') {
                out.push('^');
                at += 1;
            }
            if chars.get(at) == Some(&']') {
                out.push(']');
                at += 1;
            }
            continue;
        } else if ch == '{' && !is_repetition(&chars[at..]) {
            out.push_str("\\{");
            at += 1;
            continue;
        }
        out.push(ch);
        at += 1;
    }
    out
}

/// Whether `rest` (starting at a `{`) opens `{n}`, `{n,}` or `{n,m}`.
fn is_repetition(rest: &[char]) -> bool {
    let Some(end) = rest.iter().position(|&c| c == '}') else {
        return false;
    };
    let body: String = rest[1..end].iter().collect();
    let mut parts = body.splitn(2, ',');
    let low = parts.next().unwrap_or("");
    !low.is_empty()
        && low.bytes().all(|b| b.is_ascii_digit())
        && parts.next().is_none_or(|high| high.bytes().all(|b| b.is_ascii_digit()))
}

/// How one regex fared: compiled after `translate` in the scanner's mode, and (checked only when the report is
/// asked for, as it is slow) whether it compiles unchanged with `regex::Regex` defaults.
struct Audit {
    kind: &'static str,
    id: String,
    pattern: String,
    translated: bool,
    scanner_error: Option<String>,
    unicode_off: bool,
    compile_us: f64,
}

fn audit(kind: &'static str, id: &str, pattern: &str, entries: &mut Vec<Audit>) -> Option<Regex> {
    let translated = translate(pattern);
    let started = micros();
    let scanner = compile(&translated);
    let compile_us = micros() - started;
    entries.push(Audit {
        kind,
        id: id.to_string(),
        pattern: pattern.to_string(),
        translated: translated != pattern,
        scanner_error: scanner.as_ref().err().cloned(),
        unicode_off: scanner.as_ref().is_ok_and(|(_, unicode_off)| *unicode_off),
        compile_us,
    });
    scanner.ok().map(|(regex, _)| regex)
}

/// The audit as JSON, adding whether each pattern compiles unchanged with `regex::Regex` defaults (Unicode on,
/// default size limits). Slow: a pattern over the default size limit compiles until it hits it.
fn audit_json(entries: &[Audit], rules: usize, keywords: usize) -> String {
    let json_str = |s: &str| format!("{:?}", s);
    let null_or = |value: Option<&String>| value.map(|e| json_str(e)).unwrap_or_else(|| "null".into());
    let items: Vec<String> = entries
        .iter()
        .map(|entry| {
            let default = regex::Regex::new(&entry.pattern).err().map(|err| err.to_string());
            format!(
                "{{\"kind\":{},\"id\":{},\"pattern\":{},\"translated\":{},\"defaultOk\":{},\"defaultError\":{},\
                 \"scannerOk\":{},\"unicodeOff\":{},\"compileUs\":{:.0},\"scannerError\":{}}}",
                json_str(entry.kind),
                json_str(&entry.id),
                json_str(&entry.pattern),
                entry.translated,
                default.is_none(),
                null_or(default.as_ref()),
                entry.scanner_error.is_none(),
                entry.unicode_off,
                entry.compile_us,
                null_or(entry.scanner_error.as_ref()),
            )
        })
        .collect();
    format!(
        "{{\"rules\":{},\"keywords\":{},\"entries\":[{}]}}",
        rules,
        keywords,
        items.join(",")
    )
}

fn allowlist(config: &AllowlistConfig, owner: &str, entries: &mut Vec<Audit>) -> Allowlist {
    Allowlist {
        target: match config.regex_target.as_deref() {
            Some("match") => Target::Match,
            Some("line") => Target::Line,
            _ => Target::Secret,
        },
        and: config.condition.as_deref() == Some("AND"),
        regexes: config
            .regexes
            .iter()
            .flatten()
            .filter_map(|pattern| audit("allowlist", owner, pattern, entries))
            .collect(),
        stopwords: config
            .stopwords
            .iter()
            .flatten()
            .map(|word| word.to_lowercase().into_bytes())
            .collect(),
        has_paths: config.paths.as_ref().is_some_and(|paths| !paths.is_empty()),
    }
}

/// Shannon entropy in bits per char as the TS gate computes it: counts per code point over the UTF-16 length.
fn shannon(secret: &[u8]) -> f64 {
    let text = String::from_utf8_lossy(secret);
    if text.is_empty() {
        return 0.0;
    }
    let mut counts: HashMap<char, u32> = HashMap::new();
    let mut length = 0usize;
    for ch in text.chars() {
        *counts.entry(ch).or_insert(0) += 1;
        length += ch.len_utf16();
    }
    let length = length as f64;
    counts.values().fold(0.0, |entropy, &count| {
        let share = count as f64 / length;
        entropy - share * share.log2()
    })
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|window| window == needle)
}

impl Allowlist {
    /// gitleaks `checkFindingAllowed` with no file path or commit, as the TS `allows`.
    fn allows(&self, finding: &Finding) -> bool {
        let target = match self.target {
            Target::Match => finding.matched,
            Target::Line => finding.line,
            Target::Secret => finding.secret,
        };
        let regex_allowed = self.regexes.iter().any(|regex| regex.is_match(target));
        let stopword = !self.stopwords.is_empty() && {
            let lower = finding.secret.to_ascii_lowercase();
            self.stopwords.iter().any(|word| contains(&lower, word))
        };
        if !self.and {
            return regex_allowed || stopword;
        }
        if self.has_paths || (self.regexes.is_empty() && self.stopwords.is_empty()) {
            return false;
        }
        (self.regexes.is_empty() || regex_allowed) && (self.stopwords.is_empty() || stopword)
    }
}

/// The line of `text` holding byte `index`.
fn line_at(text: &[u8], index: usize) -> &[u8] {
    let start = text[..index].iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
    let end = text[index..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(text.len(), |at| index + at);
    &text[start..end]
}

impl Rule {
    /// Whether the rule finds at least one secret in `text`.
    fn fires(&self, text: &[u8], global: &Allowlist) -> bool {
        for found in self.regex.find_iter(text) {
            let raw = found.as_bytes();
            // Trim line breaks at the match's ends, as gitleaks (and the TS gate) do before re-matching.
            let lead = raw.iter().take_while(|&&b| b == b'\n').count();
            let trail = raw[lead..].iter().rev().take_while(|&&b| b == b'\n').count();
            let matched = &raw[lead..raw.len() - trail];
            let Some(secret) = self.secret_in(matched) else {
                continue;
            };
            if self.entropy > 0.0 && shannon(secret) <= self.entropy {
                continue;
            }
            let finding = Finding {
                matched,
                secret,
                line: line_at(text, found.start()),
            };
            if global.allows(&finding) || self.allowlists.iter().any(|list| list.allows(&finding)) {
                continue;
            }
            return true;
        }
        false
    }

    /// The secret within a match: the rule's group, else the first non-empty group, else the whole match; `None`
    /// when the rule's group did not take part.
    fn secret_in<'a>(&self, matched: &'a [u8]) -> Option<&'a [u8]> {
        let Some(caps) = self.regex.captures(matched) else {
            return Some(matched);
        };
        if caps.len() < 2 {
            return Some(matched);
        }
        if self.secret_group > 0 {
            return caps.get(self.secret_group).map(|group| group.as_bytes());
        }
        Some(
            caps.iter()
                .skip(1)
                .flatten()
                .find(|group| !group.is_empty())
                .map_or(matched, |group| group.as_bytes()),
        )
    }
}

impl Scanner {
    pub fn new() -> Scanner {
        let config: Config = toml::from_str(GITLEAKS_TOML).expect("vendored gitleaks.toml parses");
        let mut entries = Vec::new();
        let global = allowlist(&config.allowlist, "(global)", &mut entries);
        let mut rules = Vec::new();
        let mut patterns: Vec<String> = Vec::new();
        let mut pattern_ids: HashMap<String, usize> = HashMap::new();
        let mut keyword_rules: Vec<Vec<u32>> = Vec::new();
        let mut always = Vec::new();
        for rule in &config.rules {
            let Some(pattern) = rule.regex.as_deref() else {
                continue;
            };
            let Some(regex) = audit("rule", &rule.id, pattern, &mut entries) else {
                continue;
            };
            let index = rules.len() as u32;
            let keywords: Vec<String> = rule.keywords.iter().flatten().map(|word| word.to_lowercase()).collect();
            if keywords.is_empty() {
                always.push(index);
            }
            for word in &keywords {
                let id = *pattern_ids.entry(word.clone()).or_insert_with(|| {
                    patterns.push(word.clone());
                    keyword_rules.push(Vec::new());
                    patterns.len() - 1
                });
                keyword_rules[id].push(index);
            }
            rules.push(Rule {
                id: rule.id.clone(),
                regex,
                secret_group: rule.secret_group.unwrap_or(0),
                entropy: rule.entropy.unwrap_or(0.0),
                has_keywords: !keywords.is_empty(),
                allowlists: rule
                    .allowlists
                    .iter()
                    .flatten()
                    .map(|list| allowlist(list, &rule.id, &mut entries))
                    .collect(),
            });
        }
        let keywords = AhoCorasickBuilder::new()
            .ascii_case_insensitive(true)
            .match_kind(MatchKind::Standard)
            .build(&patterns)
            .expect("keyword automaton");
        let keyword_count = patterns.len();
        Scanner {
            rules,
            global,
            keywords,
            keyword_rules,
            always,
            set: OnceLock::new(),
            audit: entries,
            keyword_count,
            report: OnceLock::new(),
        }
    }

    /// The compile report as JSON (see `audit_json`), built on first use.
    pub fn report(&self) -> &str {
        self.report
            .get_or_init(|| audit_json(&self.audit, self.rules.len(), self.keyword_count))
    }

    /// The RegexSet over every rule's regex, built on first use (so its compile time is measured on its own);
    /// `None` when it does not compile.
    pub fn regex_set(&self) -> Option<&RegexSet> {
        self.set
            .get_or_init(|| {
                RegexSetBuilder::new(self.rules.iter().map(|rule| rule.regex.as_str()))
                    .unicode(false)
                    .size_limit(SIZE_LIMIT)
                    .dfa_size_limit(SIZE_LIMIT)
                    .build()
                    .ok()
            })
            .as_ref()
    }

    /// The indices of the rules that fire, ascending.
    pub fn scan(&self, text: &[u8], use_set: bool) -> Vec<u32> {
        let mut candidate = vec![false; self.rules.len()];
        for &index in &self.always {
            candidate[index as usize] = true;
        }
        for found in self.keywords.find_overlapping_iter(text) {
            for &index in &self.keyword_rules[found.pattern().as_usize()] {
                candidate[index as usize] = true;
            }
        }
        if use_set {
            if let Some(set) = self.regex_set() {
                let matched = set.matches(text);
                for (index, flag) in candidate.iter_mut().enumerate() {
                    *flag = *flag && matched.matched(index);
                }
            }
        }
        let mut hits = Vec::new();
        for (index, rule) in self.rules.iter().enumerate() {
            debug_assert!(rule.has_keywords || candidate[index]);
            if candidate[index] && rule.fires(text, &self.global) {
                hits.push(index as u32);
            }
        }
        hits
    }
}
