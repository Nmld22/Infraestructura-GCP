import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { name, zone, stack, project } from "./config";
import { privateVpc, privateSubnet } from "./vpc-private";
import { loadBalancerForwardingRule } from "./load-balancer";

// Service account for the Codec Processor VM
const codecProcessorSa = new gcp.serviceaccount.Account("codec-processor-sa", {
    accountId: `wm-codec-processor-${stack}`,
    displayName: "Codec Processor Service Account",
});

export const codecProcessorInvokerRole = new gcp.projects.IAMMember("codec-processor-invoker-role", {
    project: project,
    role: "roles/run.invoker",
    member: codecProcessorSa.email.apply(email => `serviceAccount:${email}`),
});


const startupScript = pulumi.interpolate`#!/bin/bash
set -euo pipefail

# ── 1. Variables de entorno — apuntan al Load Balancer HTTP ───────────────────
# Cloud Run tiene ingress=INTERNAL_LOAD_BALANCER, así que las peticiones de la VM
# pasan por NAT → LB HTTP (IP pública GCP) → Cloud Run (red interna de Google).
# Codec8 autentica el IMEI y escribe el JSON procesado en stdout/journal.
mkdir -p /opt/servidor-gps
cat > /etc/servidor-gps.env << ENVEOF
AUTH_SERVICE_URL=http://${loadBalancerForwardingRule.ipAddress}/api/v1/auth/devices/login
AUTH_VALIDATE_URL=http://${loadBalancerForwardingRule.ipAddress}/api/v1/auth/validate
PORT=5001
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
export const codecProcessorVm = new gcp.compute.Instance("codec-processor-vm", {
    name: name("codec-processor"),
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
        email: codecProcessorSa.email,
        scopes: ["cloud-platform"],
    },
    tags: ["codec-processor"],
    metadata: {
        "startup-script": startupScript,
    },
});

// Unmanaged Instance Group required for Regional Network Load Balancer (TCP)
export const codecProcessorGroup = new gcp.compute.InstanceGroup("codec-processor-group", {
    name: name("codec-processor-group"),
    zone,
    network: privateVpc.id,
    instances: [codecProcessorVm.id],
    namedPorts: [{
        name: "codec8-tcp",
        port: 5001,
    }],
});
