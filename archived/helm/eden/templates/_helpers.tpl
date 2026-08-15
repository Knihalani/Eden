{{/*
Expand the name of the chart.
*/}}
{{- define "eden.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "eden.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "eden.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "eden.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "eden.selectorLabels" -}}
app.kubernetes.io/name: {{ include "eden.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Postgres URL. Uses the external connection if set, else the
in-chart service.
*/}}
{{- define "eden.postgresUrl" -}}
{{- if .Values.externalPostgres }}
{{- .Values.externalPostgres }}
{{- else }}
{{- printf "postgresql://%s:%s@%s-postgres:5432/%s" .Values.postgres.user .Values.postgres.password (include "eden.fullname" .) .Values.postgres.db }}
{{- end }}
{{- end }}

{{/*
Redis URL.
*/}}
{{- define "eden.redisUrl" -}}
{{- if .Values.externalRedis }}
{{- .Values.externalRedis }}
{{- else }}
{{- printf "redis://%s-redis:6379/0" (include "eden.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Qdrant URL.
*/}}
{{- define "eden.qdrantUrl" -}}
{{- if .Values.externalQdrant }}
{{- .Values.externalQdrant }}
{{- else }}
{{- printf "http://%s-qdrant:6333" (include "eden.fullname" .) }}
{{- end }}
{{- end }}
