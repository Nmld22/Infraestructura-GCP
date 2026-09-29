import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { name, zone, stack, project } from "./config";
import { privateVpc, privateSubnet } from "./vpc-private";
import { loadBalancerForwardingRule } from "./load-balancer";

// Service account for the BC Processor VM
const bcProcessorSa = new gcp.serviceaccount.Account("bc-processor-sa", {
    accountId: `wm-bc-processor-${stack}`,
    displayName: "BC Processor Service Account",
});

export const bcProcessorInvokerRole = new gcp.projects.IAMMember("bc-processor-invoker-role", {
    project: project,
    role: "roles/run.invoker",
    member: bcProcessorSa.email.apply(email => `serviceAccount:${email}`),
});


const startupScript = pulumi.interpolate`#!/bin/bash
set -euo pipefail

# ── 1. Variables de entorno — apuntan al Load Balancer HTTP ───────────────────
# Cloud Run tiene ingress=INTERNAL_LOAD_BALANCER, así que las peticiones de la VM
# pasan por NAT → LB HTTP (IP pública GCP) → Cloud Run (red interna de Google).
# PILOTO: DATOS_SERVICE_URL definido pero el servicio de datos no está desplegado.
#         Las llamadas de telemetría retornarán 404, la autenticación funcionará.
mkdir -p /opt/servidor-gps
cat > /etc/servidor-gps.env << ENVEOF
AUTH_SERVICE_URL=http://${loadBalancerForwardingRule.ipAddress}/api/v1/auth/devices/login
DATOS_SERVICE_URL=http://${loadBalancerForwardingRule.ipAddress}/api/v1/datos
AES_KEY=30baf03e88717c478c12a80b3b848eb4ed03cead30ef8d5a2a80e4d7e3014f6f
ENVEOF
chmod 600 /etc/servidor-gps.env

# ── 2. Servicio systemd (idempotente) ─────────────────────────────────────────
cat > /etc/systemd/system/servidor-gps.service << 'SVCEOF'
[Unit]
Description=Servidor GPS Codec 8 (Teltonika)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/servidor-gps.env
ExecStart=/opt/servidor-gps/servidor-gps
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=servidor-gps

[Install]
WantedBy=multi-user.target
SVCEOF

# ── 3. Habilitar servicio ──────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable servidor-gps

# Arrancar solo si el binario ya existe en la VM
if [ -f /opt/servidor-gps/servidor-gps ]; then
    chmod +x /opt/servidor-gps/servidor-gps
    systemctl restart servidor-gps
fi

# ── 4. Instalar Google Cloud Ops Agent (idempotente) ─────────────────────────
# Permite que Grafana vea métricas de RAM y Disco de esta VM en Cloud Monitoring.
# CPU y tráfico de red ya los reporta el hipervisor GCP sin agente adicional.
# El guard evita reinstalar si la VM ya lo tiene (útil en reinicios de script).
if ! systemctl is-active --quiet google-cloud-ops-agent 2>/dev/null; then
    curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
    bash add-google-cloud-ops-agent-repo.sh --also-install
    systemctl enable --now google-cloud-ops-agent
fi
`;

// Compute Engine VM
export const bcProcessorVm = new gcp.compute.Instance("bc-processor-vm", {
    name: name("bc-processor"),
    machineType: "e2-micro",
    zone,
    bootDisk: {
        initializeParams: {
            image: "ubuntu-os-cloud/ubuntu-2204-lts",
        },
    },
    networkInterfaces: [{
        network: privateVpc.id,
        subnetwork: privateSubnet.id,
        // Sin IP externa: acceso solo vía TCP Load Balancer o IAP
    }],
    serviceAccount: {
        email: bcProcessorSa.email,
        scopes: ["cloud-platform"],
    },
    tags: ["bc-processor"],
    metadata: {
        "startup-script": startupScript,
    },
});

// Unmanaged Instance Group required for Regional Network Load Balancer (TCP)
export const bcProcessorGroup = new gcp.compute.InstanceGroup("bc-processor-group", {
    name: name("bc-processor-group"),
    zone,
    network: privateVpc.id,
    instances: [bcProcessorVm.id],
    namedPorts: [{
        name: "codec8-tcp",
        port: 5001,
    }],
});
