import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { region, project, minInstanceCount, stage, name, stack } from "./config";
import { sqlInstance, sqlUser, sqlDatabase } from "./cloud-sql";
import { dockerRegistry } from "./artifact-registry";
import { privateVpc, privateSubnet } from "./vpc-private";
import { dbPasswordSecretVersion, jwtSecretVersion } from "./secret-manager";

// Direct VPC Egress: conecta Cloud Run directamente a la subred privada
// sin necesitar VMs intermedias (VPC Connectors). Requiere Cloud Run v2.

const authSa = new gcp.serviceaccount.Account("auth-sa", {
    accountId: `wm-auth-sa-${stack}`,
    displayName: "Cloud Run Auth Service Account",
});

const authDbSecretAccess = new gcp.secretmanager.SecretIamMember("auth-db-secret-access", {
    secretId: dbPasswordSecretVersion.secret,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${authSa.email}`,
});

const authJwtSecretAccess = new gcp.secretmanager.SecretIamMember("auth-jwt-secret-access", {
    secretId: jwtSecretVersion.secret,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${authSa.email}`,
});

const pulumiConfig = new pulumi.Config();
const customAuthImage = pulumiConfig.get("authImage");
const bootstrapImage = "us-docker.pkg.dev/cloudrun/container/hello:latest";
export const initialAuthImage = customAuthImage || bootstrapImage;

export const authService = new gcp.cloudrunv2.Service("memoria-autenticacion", {
    name: name("autenticacion"),
    location: region,
    // Solo acepta tráfico del Load Balancer — impide acceso directo vía URL .run.app
    ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    template: {
        serviceAccount: authSa.email,
        containers: [{
            image: initialAuthImage,
            envs: [
                // DB — valores no sensibles en texto plano
                { name: "DB_HOST", value: sqlInstance.privateIpAddress },
                { name: "DB_PORT", value: "5432" },
                // Unificado a DB_USER — leído por TypeORM (database.module.ts) y configuration.ts
                { name: "DB_USER", value: sqlUser.name },
                { name: "DB_NAME", value: sqlDatabase.name },
                { name: "DB_SSL", value: "false" },
                { name: "DB_SSL_REJECT_UNAUTHORIZED", value: "false" },
                // JWT — valor no sensible
                { name: "AUTH_JWT_EXPIRES_IN", value: "15m" },
                // App
                { name: "STAGE", value: stage },
                { name: "APP_PATH_PREFIX", value: "/api/v1" },
                // DB Password — desde Secret Manager
                {
                    name: "DB_PASSWORD",
                    valueSource: {
                        secretKeyRef: {
                            secret: dbPasswordSecretVersion.secret,
                            version: "latest",
                        },
                    },
                },
                // JWT Secret — leído directamente como JWT_SECRET por auth.service.ts
                {
                    name: "JWT_SECRET",
                    valueSource: {
                        secretKeyRef: {
                            secret: jwtSecretVersion.secret,
                            version: "latest",
                        },
                    },
                },
            ],
            ports: [{ containerPort: 3000 }],
        }],
        scaling: {
            minInstanceCount,
        },
        vpcAccess: {
            // Direct VPC Egress — sin VPC Connector, sin VMs intermedias
            networkInterfaces: [{
                network: privateVpc.id,
                subnetwork: privateSubnet.id,
            }],
            egress: "ALL_TRAFFIC",
        },
    },
}, {
    dependsOn: [authDbSecretAccess, authJwtSecretAccess],
    // Desacopla la infraestructura del pipeline de la aplicación:
    // El pipeline de CI/CD compilará y actualizará la imagen en Cloud Run sin que
    // ejecuciones subsecuentes de Pulumi intenten revertir el contenedor a la imagen bootstrap.
    ignoreChanges: ["template.containers[0].image"],
});

export const authInvoker = new gcp.cloudrunv2.ServiceIamMember("auth-invoker", {
    location: authService.location,
    name: authService.name,
    role: "roles/run.invoker",
    member: "allUsers",
});
