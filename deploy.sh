#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Despliegue de Infraestructura Memoria en GCP ("Infra Primero")
# =============================================================================
# Flujo desacoplado:
#   1. Despliegue autónomo de Infraestructura (Pulumi up completo).
#      Cloud Run arranca con una imagen bootstrap oficial de Google Cloud Run
#      sin requerir que la imagen de la app exista previamente en Artifact Registry.
#   2. Build y Push de la aplicación hacia Artifact Registry y actualización
#      de Cloud Run (simulando o integrando el pipeline de CI/CD).
#
# Soporte Multi-Stack / Nuevo Entorno:
#   - Permite desplegar en un stack nuevo (ej: dev, alternativa, piloto) sin
#     solaparse ni sobreescribir los recursos del stack 'pruebas' existente.
#
# Uso:
#   ./deploy.sh [nombre-stack] [--infra-only | --all]
#   Ejemplos:
#     ./deploy.sh dev --infra-only   # Despliega solo infraestructura en stack 'dev'
#     ./deploy.sh dev                # Despliega infraestructura y luego la app
#     ./deploy.sh pruebas            # Usa stack 'pruebas' existente
# =============================================================================
set -euo pipefail

# ── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}${BOLD}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}${BOLD}  ✔${NC} $*"; }
warn() { echo -e "${YELLOW}${BOLD}  ⚠${NC} $*"; }
fail() { echo -e "${RED}${BOLD}   ERROR:${NC} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}══════════════════════════════════════${NC}"; echo -e "${BOLD}  $*${NC}"; echo -e "${BOLD}${BLUE}══════════════════════════════════════${NC}"; }

require_adc() {
  if ! gcloud auth application-default print-access-token > /dev/null 2>&1; then
    fail "Pulumi/GCP necesita credenciales ADC válidas. Ejecuta 'gcloud auth application-default login' antes de volver a correr ./deploy.sh."
  fi
}

wait_for_api() {
  local api="$1"
  local attempts=45
  local sleep_seconds=4

  for ((i=1; i<=attempts; i++)); do
    if gcloud services list --enabled --project="$PROJECT" --format="json" 2>/dev/null \
      | grep -q "\"name\": *\"${api}\""; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  fail "La API ${api} no quedó habilitada después de esperar. Revisa el proyecto '${PROJECT}' y vuelve a intentarlo."
}

# ── Parámetros de entrada ─────────────────────────────────────────────────────
STACK="${1:-pruebas}"
MODE="${2:---all}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

export PULUMI_CONFIG_PASSPHRASE=""
cd "$SCRIPT_DIR"

# ─────────────────────────────────────────────────────────────────────────────
step "PREPARACIÓN — Selección e Inicialización del Stack Pulumi: '$STACK'"
# ─────────────────────────────────────────────────────────────────────────────

if pulumi stack ls 2>/dev/null | grep -qE "^${STACK}([[:space:]*]|$)"; then
  pulumi stack select "$STACK" --non-interactive 2>/dev/null || true
  ok "Stack '$STACK' seleccionado"
else
  log "Stack '$STACK' no existe. Inicializando stack..."
  pulumi stack init "$STACK" --non-interactive
  ok "Stack '$STACK' creado"
fi

# Configuración automática de variables si es un stack nuevo
if ! pulumi config get gcp:project --stack "$STACK" >/dev/null 2>&1; then
  DEFAULT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "tracking-and-telemetry")
  log "Configurando gcp:project = $DEFAULT_PROJECT en stack '$STACK'..."
  pulumi config set gcp:project "$DEFAULT_PROJECT" --stack "$STACK"
fi

if ! pulumi config get gcp:region --stack "$STACK" >/dev/null 2>&1; then
  pulumi config set gcp:region "us-central1" --stack "$STACK"
fi

if ! pulumi config get gcp:zone --stack "$STACK" >/dev/null 2>&1; then
  pulumi config set gcp:zone "us-central1-a" --stack "$STACK"
fi

if ! pulumi config get memoria-gcp-iac-piloto:environment --stack "$STACK" >/dev/null 2>&1; then
  pulumi config set memoria-gcp-iac-piloto:environment "$STACK" --stack "$STACK"
fi

# Generar contraseñas seguras iniciales si no existen
if ! pulumi config get memoria-gcp-iac-piloto:dbPassword --stack "$STACK" >/dev/null 2>&1; then
  PASS=$(openssl rand -base64 16 2>/dev/null || echo "DbPass_${STACK}_123456")
  pulumi config set memoria-gcp-iac-piloto:dbPassword "$PASS" --secret --stack "$STACK"
fi

if ! pulumi config get memoria-gcp-iac-piloto:jwtSecret --stack "$STACK" >/dev/null 2>&1; then
  JWT=$(openssl rand -base64 32 2>/dev/null || echo "JwtSecret_${STACK}_1234567890123456")
  pulumi config set memoria-gcp-iac-piloto:jwtSecret "$JWT" --secret --stack "$STACK"
fi

if ! pulumi config get memoria-gcp-iac-piloto:grafanaDbPassword --stack "$STACK" >/dev/null 2>&1; then
  GPASS=$(openssl rand -base64 16 2>/dev/null || echo "GrafanaPass_${STACK}_123456")
  pulumi config set memoria-gcp-iac-piloto:grafanaDbPassword "$GPASS" --secret --stack "$STACK"
fi

PROJECT=$(pulumi config get gcp:project --stack "$STACK")
REGION=$(pulumi config get gcp:region   --stack "$STACK")

# Función de naming que garantiza aislamiento total entre stacks
wm_name() {
  if [[ "$STACK" == "prod" ]]; then
    echo "memoria-${1}-prod"
  elif [[ "$STACK" == "pruebas" ]]; then
    echo "memoria-${1}"
  else
    echo "memoria-${1}-${STACK}"
  fi
}

REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/$(wm_name registry)"

log "Stack       : $STACK"
log "Project     : $PROJECT"
log "Region      : $REGION"
log "Registry    : $REGISTRY"
log "Naming test : auth=$(wm_name autenticacion) | registry=$(wm_name registry) | db=$(wm_name postgres-db)"
require_adc

# ─────────────────────────────────────────────────────────────────────────────
step "PASO 1/4 — Habilitar APIs de GCP requeridas"
# ─────────────────────────────────────────────────────────────────────────────
APIS=(
  "run.googleapis.com"                  # Cloud Run
  "compute.googleapis.com"              # Compute / VPC / LB / Bastion
  "servicenetworking.googleapis.com"    # Private Service Networking (Cloud SQL)
  "sqladmin.googleapis.com"             # Cloud SQL Admin
  "artifactregistry.googleapis.com"     # Artifact Registry
  "secretmanager.googleapis.com"        # Secret Manager
  "vpcaccess.googleapis.com"            # Serverless VPC Access
  "iam.googleapis.com"                  # IAM
  "iap.googleapis.com"                  # Identity-Aware Proxy (bastion SSH)
  "cloudresourcemanager.googleapis.com" # Resource Manager
  "monitoring.googleapis.com"           # Cloud Monitoring (métricas VMs para Grafana)
  "storage.googleapis.com"              # Cloud Storage
)

log "Habilitando ${#APIS[@]} APIs (puede tardar 1-2 min)..."
gcloud services enable "${APIS[@]}" --project="$PROJECT" --quiet
wait_for_api "servicenetworking.googleapis.com"
wait_for_api "sqladmin.googleapis.com"
ok "APIs habilitadas"

# ─────────────────────────────────────────────────────────────────────────────
step "PASO 2/4 — Despliegue de Infraestructura Completo (Infra Primero)"
# ─────────────────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"
log "Ejecutando 'pulumi up' completo para stack '$STACK'..."
log "Nota: Cloud Run inicializa con imagen bootstrap oficial; no requiere build previo en Artifact."

pulumi up \
  --stack "$STACK" \
  --yes \
  --non-interactive \
  2>&1

ok "Infraestructura desplegada exitosamente sin dependencias de build previo."

# ─────────────────────────────────────────────────────────────────────────────
step "PASO 3/4 — Pipeline de Aplicación: Build y Despliegue de Autenticación"
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "--infra-only" ]]; then
  log "Modo '--infra-only' especificado. Omitiendo build local."
  log "La infraestructura está lista para recibir despliegues desde el pipeline de CI/CD."
  log "Comandos que ejecutará el pipeline:"
  log "  1. docker build -t ${REGISTRY}/autenticacion:latest ../Autenticacion-alternativa"
  log "  2. docker push ${REGISTRY}/autenticacion:latest"
  log "  3. gcloud run deploy $(wm_name autenticacion) --image ${REGISTRY}/autenticacion:latest --region $REGION --project $PROJECT"
else
  log "Construyendo y publicando imagen de autenticación hacia Artifact Registry..."
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

  SERVICE_DIR="$ROOT_DIR/Autenticacion-alternativa"
  IMAGE="${REGISTRY}/autenticacion:latest"

  [[ -d "$SERVICE_DIR" ]] || fail "Directorio no encontrado: $SERVICE_DIR"
  [[ -f "$SERVICE_DIR/Dockerfile" ]] || fail "Dockerfile no encontrado en: $SERVICE_DIR"

  log "Build: Autenticacion-alternativa → $IMAGE"
  docker build \
    --platform linux/amd64 \
    --tag "$IMAGE" \
    --file "$SERVICE_DIR/Dockerfile" \
    "$SERVICE_DIR"

  log "Push: $IMAGE"
  docker push "$IMAGE"
  ok "Imagen publicada en Artifact Registry: $IMAGE"

  log "Desplegando imagen en Cloud Run ($(wm_name autenticacion))..."
  gcloud run deploy "$(wm_name autenticacion)" \
    --image "$IMAGE" \
    --region "$REGION" \
    --project "$PROJECT" \
    --quiet
  ok "Servicio Cloud Run actualizado con la imagen de aplicación"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PASO 4/4 — Verificación post-despliegue"
# ─────────────────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"

log "Outputs del stack:"
pulumi stack output --stack "$STACK" 2>/dev/null || warn "No hay outputs disponibles"

AUTH_SVC=$(wm_name autenticacion)
AUTH_URL=$(gcloud run services describe "$AUTH_SVC" \
  --region="$REGION" --project="$PROJECT" \
  --format="value(status.url)" 2>/dev/null || echo "N/A")

TCP_LB_IP=$(pulumi stack output tcpLoadBalancerIp --stack "$STACK" 2>/dev/null || echo "N/A")
CODEC_TCP_LB_IP=$(pulumi stack output codecTcpLoadBalancerIp --stack "$STACK" 2>/dev/null || echo "N/A")
GRAFANA_URL=$(pulumi stack output grafanaUrl --stack "$STACK" 2>/dev/null || echo "N/A")

echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  DESPLIEGUE FINALIZADO EXITOSAMENTE ✔  ${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo -e "  Proyecto        : ${BOLD}$PROJECT${NC}"
echo -e "  Stack           : ${BOLD}$STACK${NC}"
echo -e "  Auth Cloud Run  : ${BOLD}$AUTH_URL${NC}"
echo -e "  TCP LB IP (BC)  : ${BOLD}$TCP_LB_IP${NC}:5001"
echo -e "  TCP LB IP Codec : ${BOLD}$CODEC_TCP_LB_IP${NC}:5001"
echo -e "  Grafana         : ${BOLD}${GRAFANA_URL}${NC}  (usuario: admin)"
echo ""
log "Para ver el estado completo: pulumi stack --stack $STACK"
log "Para acceder al Bastion via IAP:"
log "  gcloud compute ssh $(wm_name bastion) --project=$PROJECT --zone=$(pulumi config get gcp:zone --stack $STACK 2>/dev/null || echo 'us-central1-a') --tunnel-through-iap"
