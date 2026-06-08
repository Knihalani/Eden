//! Event payload builders.
//!
//! The SDK accepts a free-form [`EventBuilder`] so call sites can attach
//! metrics, tags, attributes, and a payload without knowing the wire
//! schema. The builder is converted into a `serde_json::Value` on `.send()`
//! and POSTed to the configured ingest endpoint.

use crate::errors::Result;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Realm (lifecycle phase) the event belongs to.
///
/// Mirrors the canonical `realm` column on `telemetry_events`. The SDK
/// defaults to [`Realm::Production`] for agent call sites; environment
/// generation and benchmark runs should pass [`Realm::Environment`].
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Realm {
    /// Generated environments / synthetic evaluation runs.
    Environment,
    /// Live agent calls in production.
    Production,
}

impl Default for Realm {
    fn default() -> Self {
        Realm::Production
    }
}

/// Outcome bucket — recorded as the `outcome` column.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The wrapped call completed without raising.
    Success,
    /// The wrapped call raised an exception.
    Failure,
    /// The wrapped call was cancelled or hit a timeout.
    Cancelled,
}

impl Outcome {
    /// String form used on the wire.
    pub fn as_str(&self) -> &'static str {
        match self {
            Outcome::Success => "success",
            Outcome::Failure => "failure",
            Outcome::Cancelled => "cancelled",
        }
    }
}

/// Fluent builder for a single telemetry event.
///
/// Use one of the `*_call` constructors for a typed starting point, then
/// attach tags / attributes / metrics / payload as needed.
#[derive(Debug, Clone)]
pub struct EventBuilder {
    name: String,
    event_type: String,
    realm: Realm,
    outcome: Option<Outcome>,
    tags: Vec<String>,
    attributes: BTreeMap<String, String>,
    metrics: BTreeMap<String, f64>,
    payload: Map<String, Value>,
    duration_ms: Option<u64>,
    environment_id: Option<String>,
    agent_id: Option<String>,
    source_format: String,
}

impl EventBuilder {
    /// Start an `agent_call` event — the canonical shape produced by
    /// `#[trace_agent]` on the Python side and `@traceAgent` on the TS side.
    pub fn agent_call(name: impl Into<String>) -> Self {
        Self::new(name, "agent_call")
    }

    /// Start an `llm_completion` event with a known provider.
    pub fn llm_completion(name: impl Into<String>, provider: impl AsRef<str>) -> Self {
        Self::new(name, "llm_completion").add_tag(provider.as_ref())
    }

    /// Start a custom event with an explicit type. Prefer the typed
    /// constructors where they apply.
    pub fn new(name: impl Into<String>, event_type: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            event_type: event_type.into(),
            realm: Realm::default(),
            outcome: None,
            tags: Vec::new(),
            attributes: BTreeMap::new(),
            metrics: BTreeMap::new(),
            payload: Map::new(),
            duration_ms: None,
            environment_id: None,
            agent_id: None,
            source_format: "eden_sdk".to_string(),
        }
    }

    /// Attach a free-form tag (e.g. `production`, `model:gpt-4o`).
    pub fn add_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Replace the tag list wholesale.
    pub fn with_tags<I, S>(mut self, tags: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.tags = tags.into_iter().map(Into::into).collect();
        self
    }

    /// Set a string attribute (the `attributes` map is string → string).
    pub fn set_attr(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.attributes.insert(key.into(), value.into());
        self
    }

    /// Set a numeric metric (the `metrics` map is string → float).
    pub fn set_metric(mut self, key: impl Into<String>, value: f64) -> Self {
        self.metrics.insert(key.into(), value);
        self
    }

    /// Merge a JSON value into the payload under `key`.
    pub fn set_payload<K>(mut self, key: K, value: Value) -> Self
    where
        K: Into<String>,
    {
        self.payload.insert(key.into(), value);
        self
    }

    /// Set the duration explicitly. Wrappers compute this for you.
    pub fn with_duration_ms(mut self, ms: u64) -> Self {
        self.duration_ms = Some(ms);
        self
    }

    /// Set the realm.
    pub fn with_realm(mut self, realm: Realm) -> Self {
        self.realm = realm;
        self
    }

    /// Set the outcome.
    pub fn with_outcome(mut self, outcome: Outcome) -> Self {
        self.outcome = Some(outcome);
        self
    }

    /// Attach the originating environment id (for `realm=environment`).
    pub fn with_environment_id(mut self, env_id: impl Into<String>) -> Self {
        self.environment_id = Some(env_id.into());
        self
    }

    /// Attach the agent id (e.g. a deployment tag).
    pub fn with_agent_id(mut self, agent_id: impl Into<String>) -> Self {
        self.agent_id = Some(agent_id.into());
        self
    }

    /// Override the `source_format` stamp.
    pub fn with_source_format(mut self, fmt: impl Into<String>) -> Self {
        self.source_format = fmt.into();
        self
    }

    /// Read-only access to the event name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Read-only access to the event type.
    pub fn event_type(&self) -> &str {
        &self.event_type
    }

    /// Convert the builder into a `serde_json::Value` matching the wire
    /// schema. The returned value is a top-level object with the same
    /// shape the Python and TS SDKs emit.
    pub fn into_value(self) -> Result<Value> {
        let mut obj = Map::new();
        obj.insert("event_id".into(), Value::String(format!("evt_{}", Uuid::new_v4())));
        obj.insert("event_type".into(), Value::String(self.event_type));
        obj.insert("name".into(), Value::String(self.name));
        obj.insert("realm".into(), serde_json::to_value(self.realm)?);
        if let Some(outcome) = self.outcome {
            obj.insert("outcome".into(), Value::String(outcome.as_str().into()));
        }
        if let Some(ms) = self.duration_ms {
            obj.insert("duration_ms".into(), json!(ms));
        }
        if let Some(env_id) = self.environment_id {
            obj.insert("environment_id".into(), Value::String(env_id));
        }
        if let Some(agent_id) = self.agent_id {
            obj.insert("agent_id".into(), Value::String(agent_id));
        }
        if !self.tags.is_empty() {
            obj.insert(
                "tags".into(),
                Value::Array(self.tags.into_iter().map(Value::String).collect()),
            );
        }
        if !self.attributes.is_empty() {
            let map: Map<String, Value> = self
                .attributes
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            obj.insert("attributes".into(), Value::Object(map));
        }
        if !self.metrics.is_empty() {
            let map: Map<String, Value> = self
                .metrics
                .into_iter()
                .map(|(k, v)| (k, json!(v)))
                .collect();
            obj.insert("metrics".into(), Value::Object(map));
        }
        if !self.payload.is_empty() {
            obj.insert("payload".into(), Value::Object(self.payload));
        }
        obj.insert(
            "source_format".into(),
            Value::String(self.source_format),
        );
        Ok(Value::Object(obj))
    }
}

/// Top-level alias for the builder. Kept short for call-site ergonomics.
pub type Event = EventBuilder;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_serialises_with_required_fields() {
        let v = Event::agent_call("my_agent")
            .add_tag("production")
            .set_metric("input_tokens", 12.0)
            .with_duration_ms(42)
            .into_value()
            .unwrap();
        assert_eq!(v["event_type"], "agent_call");
        assert_eq!(v["name"], "my_agent");
        assert_eq!(v["realm"], "production");
        assert_eq!(v["metrics"]["input_tokens"], 12.0);
        assert_eq!(v["duration_ms"], 42);
        assert!(v["event_id"].as_str().unwrap().starts_with("evt_"));
    }

    #[test]
    fn builder_rejects_when_serialised() {
        // Outcomes are typed; just sanity-check the wire string form.
        assert_eq!(Outcome::Success.as_str(), "success");
        assert_eq!(Outcome::Failure.as_str(), "failure");
    }
}
