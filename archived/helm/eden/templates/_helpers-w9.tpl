{{- define "eden.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}
{{- end }}

{{/*
ClickHouse URL — external when set.
*/}}
{{- define "eden.clickhouseUrl" -}}
{{- if .Values.externalClickhouse }}
{{- .Values.externalClickhouse }}
{{- else if .Values.clickhouse.enabled }}
{{- printf "http://%s-clickhouse:8123" (include "eden.fullname" .) }}
{{- else }}
{{- end }}
{{- end }}

{{/*
Typesense host — external when set.
*/}}
{{- define "eden.typesenseHost" -}}
{{- if .Values.externalTypesense.host }}
{{- .Values.externalTypesense.host }}
{{- else if .Values.typesense.enabled }}
{{- printf "%s-typesense" (include "eden.fullname" .) }}
{{- else }}
{{- end }}
{{- end }}
