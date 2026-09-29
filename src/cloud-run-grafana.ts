import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { name, region, project, stack } from "./config";
import { privateVpc, privateSubnet } from "./vpc-private";
import { sqlInstance, grafanaDatabase, grafanaUser } from "./cloud-sql";

// ── 1. Service Account para el Cloud Run de Grafana ───────────────────────────
const grafanaSa = new gcp.serviceaccount.Account("grafana-sa", {
    accountId: `wm-grafana-sa-${stack}`,
    displayName: "Grafana Cloud Run Service Account",
});


const grafanaMonitoringAccess = new gcp.projects.IAMMember("grafana-monitoring-viewer", {
    project,
    role: "roles/monitoring.viewer",
    member: pulumi.interpolate`serviceAccount:${grafanaSa.email}`,
});

// ── 2. Secret Manager: contraseña admin de Grafana ────────────────────────────
const grafanaAdminPasswordSecret = new gcp.secretmanager.Secret("grafana-admin-password-secret", {
    secretId: name("grafana-admin-password"),
    replication: { auto: {} },
});

const grafanaAdminPasswordVersion = new gcp.secretmanager.SecretVersion(
    "grafana-admin-password-version",
    {
        secret: grafanaAdminPasswordSecret.id,
        secretData: pulumi.secret("grafana-CHANGE-ME-on-first-deploy"),
    },
);

// Secret para la contraseña de BD de Grafana (leída desde pulumi config grafanaDbPassword)
const grafanaDbPasswordSecret = new gcp.secretmanager.Secret("grafana-db-password-secret", {
    secretId: name("grafana-db-password"),
    replication: { auto: {} },
});

const grafanaDbPasswordVersion = new gcp.secretmanager.SecretVersion(
    "grafana-db-password-version",
    {
        secret: grafanaDbPasswordSecret.id,
        secretData: grafanaUser.password.apply(p => p ?? ""),
    },
);

// Acceso a ambos secrets desde la Service Account de Cloud Run
const grafanaAdminSecretAccess = new gcp.secretmanager.SecretIamMember("grafana-admin-secret-access", {
    secretId: grafanaAdminPasswordSecret.id,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${grafanaSa.email}`,
});

const grafanaDbSecretAccess = new gcp.secretmanager.SecretIamMember("grafana-db-secret-access", {
    secretId: grafanaDbPasswordSecret.id,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${grafanaSa.email}`,
});


export const grafanaService = new gcp.cloudrunv2.Service("memoria-grafana", {
    name: name("grafana"),
    location: region,
    ingress: "INGRESS_TRAFFIC_ALL",
    template: {
        serviceAccount: grafanaSa.email,
        containers: [{
            // Imagen oficial de Docker Hub (v11.x).
            // Plugin Google Cloud Monitoring ya incluido — no requiere GF_INSTALL_PLUGINS.
            image: "grafana/grafana:latest",
            envs: [
                // ── Servidor ─────────────────────────────────────────────────────
                { name: "GF_SERVER_ROOT_URL", value: "%(protocol)s://%(domain)s/grafana/" },
                { name: "GF_SERVER_SERVE_FROM_SUB_PATH", value: "true" },
                // ── Base de datos PostgreSQL (Cloud SQL vía IP privada) ───────────
                // Direct VPC Egress permite alcanzar la IP privada de Cloud SQL.
                { name: "GF_DATABASE_TYPE", value: "postgres" },
                { name: "GF_DATABASE_HOST", value: pulumi.interpolate`${sqlInstance.privateIpAddress}:5432` },
                { name: "GF_DATABASE_NAME", value: grafanaDatabase.name },
                { name: "GF_DATABASE_USER", value: grafanaUser.name },
                { name: "GF_DATABASE_SSL_MODE", value: "disable" }, // Red privada, SSL no requerido
                {
                    name: "GF_DATABASE_PASSWORD",
                    valueSource: {
                        secretKeyRef: {
                            secret: grafanaDbPasswordSecret.secretId,
                            version: "latest",
                        },
                    },
                },
                // ── Credenciales del administrador de Grafana ─────────────────────
                { name: "GF_SECURITY_ADMIN_USER", value: "admin" },
                {
                    name: "GF_SECURITY_ADMIN_PASSWORD",
                    valueSource: {
                        secretKeyRef: {
                            secret: grafanaAdminPasswordSecret.secretId,
                            version: "latest",
                        },
                    },
                },
            ],
            ports: [{ containerPort: 3000 }],
            resources: {
                limits: {
                    cpu: "1",
                    memory: "1024Mi",
                },
            },
            startupProbe: {
                initialDelaySeconds: 10,
                timeoutSeconds: 5,
                periodSeconds: 5,
                failureThreshold: 36, // Hasta 3 minutos para iniciar y correr migraciones
                tcpSocket: {
                    port: 3000,
                },
            },
        }],
        scaling: {
            minInstanceCount: 1, // Contenedor siempre activo, sin cold starts
            maxInstanceCount: 1, // Una instancia — PostgreSQL soporta múltiples conexiones si se necesita escalar
        },
        // Direct VPC Egress: permite que Cloud Run alcance la IP privada de Cloud SQL
        vpcAccess: {
            networkInterfaces: [{
                network: privateVpc.id,
                subnetwork: privateSubnet.id,
            }],
            egress: "PRIVATE_RANGES_ONLY",
        },
    },
}, {
    dependsOn: [
        grafanaMonitoringAccess,
        grafanaAdminSecretAccess,
        grafanaDbSecretAccess,
        grafanaAdminPasswordVersion,
        grafanaDbPasswordVersion,
    ],
});

// Acceso público sin autenticación de Cloud Run — el ALB gestiona el enrutamiento
new gcp.cloudrunv2.ServiceIamMember("grafana-invoker", {
    location: grafanaService.location,
    name: grafanaService.name,
    role: "roles/run.invoker",
    member: "allUsers",
});
