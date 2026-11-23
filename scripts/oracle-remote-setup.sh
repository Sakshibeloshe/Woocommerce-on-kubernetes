#!/usr/bin/env bash
# Runs ON the Oracle VM. Copied + started by oracle-deploy.bat. Safe to re-run.
set -uo pipefail
step() { echo; echo "=== $* ==="; }
IP=129.154.239.224

step "1. helm + kubectl access"
command -v helm >/dev/null || curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version --short
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown ubuntu:ubuntu ~/.kube/config
grep -q 'KUBECONFIG=~/.kube/config' ~/.bashrc || echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
export KUBECONFIG=~/.kube/config
kubectl get nodes || { echo "FAIL: k3s not ready"; exit 1; }

step "2. firewall check (iptables 80/443)"
sudo iptables -L INPUT -n --line-numbers | grep -E 'dpt:(80|443)' || echo "WARN: no iptables ACCEPT for 80/443"

step "3. repo"
if [ -d ~/Woocommerce-on-kubernetes/.git ]; then
  git -C ~/Woocommerce-on-kubernetes fetch -q origin && git -C ~/Woocommerce-on-kubernetes reset -q --hard origin/main
else
  git clone https://github.com/Sakshibeloshe/Woocommerce-on-kubernetes.git ~/Woocommerce-on-kubernetes
fi
cd ~/Woocommerce-on-kubernetes || exit 1
# Charts uploaded by oracle-update.bat win over GitHub, so the VM runs exactly what is on your PC.
if [ -f ~/charts.tgz ]; then
  rm -rf charts   # replace, don't merge (tar refuses to overwrite some files)
  if tar --warning=no-unknown-keyword -xzf ~/charts.tgz -C ~/Woocommerce-on-kubernetes; then echo "using charts uploaded from your PC"
  else echo "WARN: chart upload unreadable, using GitHub's charts"; git checkout -q -- charts; fi
  rm -f ~/charts.tgz
fi
git log -1 --format='repo at %h %s' 

step "4. image pulls"
FAILED=0
for i in mcp-notes:0.1.1 mcp-toolbox:0.1.1 mcp-woocommerce:0.1.2 mcp-gateway:${GATEWAY_TAG:-0.3.2} mcp-dashboard:${DASHBOARD_TAG:-0.1.3} ${PROVISIONER_TAG:+store-provisioner:$PROVISIONER_TAG}; do
  if sudo k3s crictl pull ghcr.io/sakshibeloshe/$i >/dev/null 2>&1; then echo "ok     $i"; else echo "FAILED $i"; FAILED=1; fi
done
[ $FAILED = 0 ] || { echo "FAIL: make those GHCR packages Public (and arm64). Stopping."; exit 1; }

step "5. chat (LLM key)"
# ~/llm-key.txt is uploaded by oracle-update.bat when you paste a Groq key; never stored in git.
LLM_RESTART=0
if [ -s ~/llm-key.txt ]; then
  KEYVAL=$(tr -d '\r\n ' < ~/llm-key.txt); rm -f ~/llm-key.txt
  MODELS=$(curl -s -H "Authorization: Bearer $KEYVAL" https://api.groq.com/openai/v1/models)
  if echo "$MODELS" | grep -q '"id"'; then
    MODEL=""
    for m in llama-3.3-70b-versatile openai/gpt-oss-120b openai/gpt-oss-20b; do
      echo "$MODELS" | grep -q "\"$m\"" && { MODEL=$m; break; }
    done
    [ -n "$MODEL" ] || MODEL=$(echo "$MODELS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    printf '%s' "$KEYVAL" > /tmp/k && kubectl create namespace gateway --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    kubectl -n gateway create secret generic llm-api-key --from-file=api-key=/tmp/k --dry-run=client -o yaml | kubectl apply -f -
    rm -f /tmp/k; echo "$MODEL" > ~/.llm-model; LLM_RESTART=1
    echo "Groq key OK, model: $MODEL"
  else
    echo "WARN: Groq rejected the key, chat not changed: $(echo "$MODELS" | head -c 200)"
  fi
fi
unset KEYVAL MODELS
if kubectl -n gateway get secret llm-api-key >/dev/null 2>&1 && [ -s ~/.llm-model ]; then
  LLM_BLOCK="  llm:
    baseUrl: https://api.groq.com/openai/v1
    model: $(cat ~/.llm-model)
    timeoutMs: 60000
    existingSecret: llm-api-key"
  echo "chat: on ($(cat ~/.llm-model))"
else
  LLM_BLOCK="  llm:
    baseUrl: \"\"
    model: \"\"
    existingSecret: \"\""
  echo "chat: off (no key yet)"
fi

step "5b. values-oracle.yaml"
cat > charts/platform/values-oracle.yaml <<EOF
global:
  storageClass: local-path
  imageRegistry: ghcr.io/sakshibeloshe
  imagePullPolicy: IfNotPresent
namespaces:
  create: true
secrets:
  generate: true
ingress:
  className: traefik
  tls:
    enabled: false
store:
  host: store.$IP.nip.io
  adminEmail: admin@store.example.com
  mysql:
    storage: 10Gi
  wordpress:
    storage: 10Gi
    resources:
      requests: { cpu: 200m, memory: 384Mi }
      limits: { cpu: "1", memory: 768Mi }
gateway:
  host: dashboard.$IP.nip.io
  adminEmail: admin@example.com
  replicas: 1
$LLM_BLOCK
  extraEgress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10]
      ports:
        - { port: 443, protocol: TCP }
  postgres:
    storage: 5Gi
provisioner:
  enabled: true
EOF
head -3 charts/platform/values-oracle.yaml

step "6. helm install (5-15 min)"
helm upgrade --install platform charts/platform -f charts/platform/values-oracle.yaml ${DASHBOARD_TAG:+--set dashboard.image.tag=$DASHBOARD_TAG} ${GATEWAY_TAG:+--set gateway.image.tag=$GATEWAY_TAG} ${PROVISIONER_TAG:+--set provisioner.image.tag=$PROVISIONER_TAG} --timeout 15m --wait
RC=$?
echo "helm exit code: $RC"
[ $LLM_RESTART = 1 ] && kubectl -n gateway rollout restart deploy/gateway && kubectl -n gateway rollout status deploy/gateway --timeout=180s
echo "dashboard image: $(kubectl -n gateway get deploy dashboard -o jsonpath='{.spec.template.spec.containers[0].image}')"

step "7. status"
kubectl get pods -A
kubectl get ingress -A
if [ $RC != 0 ]; then
  for p in $(kubectl get pods -A --no-headers | awk '$4!="Running" && $4!="Completed"{print $1"/"$2}'); do
    echo "--- describe $p"; kubectl -n "${p%/*}" describe pod "${p#*/}" | tail -25
  done
fi
echo; echo "store:     http://store.$IP.nip.io"
echo "dashboard: http://dashboard.$IP.nip.io"
echo "=== DONE ==="
