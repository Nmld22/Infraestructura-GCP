import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { name } from "./config";
import { sqlUser } from "./cloud-sql";

// ─── Crear secrets en Secret Manager ─────────────────────────────────────────
// PILOTO: se mantienen db-password y jwt-secret.
// Se omite internal-secret (comunicación datos ↔ gestión no requerida en el piloto).

// 1. DB Password
const dbPasswordSecret = new gcp.secretmanager.Secret("secret-db-password", {
    secretId: name("db-password"),
    replication: { auto: {} },
});

export const dbPasswordSecretVersion = new gcp.secretmanager.SecretVersion(
    "secret-db-password-version",
    {
        secret: dbPasswordSecret.id,
        secretData: sqlUser.password.apply(p => p ?? ""),
    },
);

// 2. JWT Secret (compartido entre auth y dispositivos)
const jwtSecretValue = new pulumi.Config().getSecret("jwtSecret") ?? pulumi.secret("supersecretjwt-CHANGE-ME");

const jwtSecret = new gcp.secretmanager.Secret("secret-jwt", {
    secretId: name("jwt-secret"),
    replication: { auto: {} },
});

export const jwtSecretVersion = new gcp.secretmanager.SecretVersion(
    "secret-jwt-version",
    {
        secret: jwtSecret.id,
        secretData: jwtSecretValue,
    },
);

// ─── Exports de los resource names para usar en Cloud Run ────────────────────
export const dbPasswordSecretName = dbPasswordSecretVersion.name;
export const jwtSecretName = jwtSecretVersion.name;
