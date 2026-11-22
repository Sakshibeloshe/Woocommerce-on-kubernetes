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
if [ -d ~/Woocommerce-on-kubernetes/.git ]; then git -C ~/Woocommerce-on-kubernetes pull --ff-only; else git clone https://github.com/Sakshibeloshe/Woocommerce-on-kubernetes.git ~/Woocommerce-on-kubernetes; fi
cd ~/Woocommerce-on-kubernetes || exit 1

step "4. image pulls"
FAILED=0
for i in mcp-notes:0.1.1 mcp-toolbox:0.1.1 mcp-woocommerce:0.1.2 mcp-gateway:0.3.2 mcp-dashboard:0.1.3; do
  if sudo k3s crictl pull ghcr.io/sakshibeloshe/$i >/dev/null 2>&1; then echo "ok     $i"; else echo "FAILED $i"; FAILED=1; fi
done
[ $FAILED = 0 ] || { echo "FAIL: make those GHCR packages Public (and arm64). Stopping."; exit 1; }

step "5. values-oracle.yaml"
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
  llm:
    baseUrl: ""
    model: ""
    timeoutMs: 60000
    existingSecret: ""
  extraEgress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10]
      ports:
        - { port: 443, protocol: TCP }
  postgres:
    storage: 5Gi
EOF
head -3 charts/platform/values-oracle.yaml

step "6. helm install (5-15 min)"
helm upgrade --install platform charts/platform -f charts/platform/values-oracle.yaml --timeout 15m --wait
RC=$?
echo "helm exit code: $RC"

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
