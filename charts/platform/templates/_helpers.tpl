{{/* ---------- names and labels ---------- */}}

{{- define "platform.labels" -}}
app.kubernetes.io/part-of: platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* Our own images get the optional registry prefix; public images (mysql, ...) don't. */}}
{{- define "platform.image" -}}
{{- $img := index . 0 -}}{{- $root := index . 1 -}}
{{- if $root.Values.global.imageRegistry -}}
{{ $root.Values.global.imageRegistry }}/{{ $img.repository }}:{{ $img.tag }}
{{- else -}}
{{ $img.repository }}:{{ $img.tag }}
{{- end -}}
{{- end }}

{{- define "platform.podDefaults" -}}
# No component talks to the Kubernetes API, so no pod gets an API token (least privilege:
# a compromised container can't use one to query or change the cluster).
automountServiceAccountToken: false
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* Locked-down container defaults for our own (non-root) images. */}}
{{- define "platform.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]
{{- end }}

{{- define "platform.storageClass" -}}
{{- if .Values.global.storageClass }}
storageClassName: {{ .Values.global.storageClass }}
{{- end }}
{{- end }}

{{- define "platform.siteUrl" -}}
{{ if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ .Values.store.host }}
{{- end }}

{{- define "platform.publicUrl" -}}
{{ if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ .Values.gateway.host }}
{{- end }}

{{/* ---------- generated secrets ----------
  Returns the value for one key of one Secret:
    1. the value already stored in the cluster (lookup), so upgrades never change it;
    2. otherwise a fixed value if given (e.g. an email address);
    3. otherwise a new random value.
  Results are cached for the rest of this render, so the same value can be written into
  two Secrets (the notes token lives in mcp-servers AND in gateway).
  Usage: include "platform.secretValue" (dict "root" $ "ns" "store" "name" "x" "key" "y" "gen" "alnum32") */}}
{{- define "platform.secretValue" -}}
{{- $root := .root -}}
{{- if not (hasKey $root.Values "_generated") }}{{- $_ := set $root.Values "_generated" dict -}}{{- end -}}
{{- $cache := $root.Values._generated -}}
{{- $id := printf "%s/%s/%s" .ns .name .key -}}
{{- if not (hasKey $cache $id) -}}
  {{- $value := "" -}}
  {{- $existing := lookup "v1" "Secret" .ns .name -}}
  {{- if and $existing $existing.data (hasKey $existing.data .key) -}}
    {{- $value = index $existing.data .key | b64dec -}}
  {{- else if .value -}}
    {{- $value = .value -}}
  {{- else if eq .gen "bytes32" -}}
    {{- $value = randBytes 32 -}}
  {{- else if eq .gen "ck" -}}
    {{- $value = printf "ck_%s" (randAlphaNum 40 | lower) -}}
  {{- else if eq .gen "cs" -}}
    {{- $value = printf "cs_%s" (randAlphaNum 40 | lower) -}}
  {{- else -}}
    {{- $value = randAlphaNum 32 -}}
  {{- end -}}
  {{- $_ := set $cache $id $value -}}
{{- end -}}
{{- index $cache $id -}}
{{- end }}

{{/* ---------- NetworkPolicy building blocks ---------- */}}

{{- define "platform.fromIngressController" -}}
- namespaceSelector:
    matchLabels: { kubernetes.io/metadata.name: {{ .Values.ingress.controller.namespace }} }
  podSelector:
    matchLabels:
      {{- toYaml .Values.ingress.controller.podLabels | nindent 6 }}
{{- end }}

{{- define "platform.fromGateway" -}}
- namespaceSelector:
    matchLabels: { kubernetes.io/metadata.name: {{ .Values.namespaces.gateway }} }
  podSelector:
    matchLabels: { app: gateway }
{{- end }}

{{/* Default deny + DNS egress for every pod of a namespace. */}}
{{- define "platform.namespaceBaseline" -}}
{{- $root := index . 0 -}}{{- $ns := index . 1 -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: {{ $ns }}
  labels: {{- include "platform.labels" $root | nindent 4 }}
spec:
  podSelector: {}                 # every pod in the namespace
  policyTypes: [Ingress, Egress]  # nothing in, nothing out, unless another policy allows it
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: {{ $ns }}
  labels: {{- include "platform.labels" $root | nindent 4 }}
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: {{ $root.Values.networkPolicies.dns.namespace }} }
          podSelector:
            matchLabels:
              {{- toYaml $root.Values.networkPolicies.dns.podLabels | nindent 14 }}
      ports:
        - { port: 53, protocol: UDP }
        - { port: 53, protocol: TCP }
{{- end }}

{{/* The public internet, minus private and metadata ranges. */}}
{{- define "platform.internet" -}}
- ipBlock:
    cidr: 0.0.0.0/0
    except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10]
{{- end }}
