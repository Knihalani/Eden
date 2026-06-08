package eden

import "encoding/json"

// jsonMarshal is a thin wrapper around encoding/json. Subpackages
// in this module use the standard encoding/json directly; this file
// is kept as a single place to swap the JSON implementation (e.g.
// json-iterator) without touching every call site.
func jsonMarshal(v any) ([]byte, error)  { return json.Marshal(v) }
func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
