import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const gcpConfig = new pulumi.Config("gcp");

export const stack = pulumi.getStack(); // "pruebas" | "prod"

export const project = gcpConfig.require("project");
export const region = gcpConfig.require("region");
export const zone = gcpConfig.get("zone") || `${region}-b`;
export const environment = config.get("environment") || stack;

export const isProd = environment === "prod" || stack === "prod";
export const stage = isProd ? "production" : (stack === "pruebas" ? "staging" : stack);
export const minInstanceCount = 1;

export const name = (service: string) => {
    if (isProd) {
        return `memoria-${service}-prod`;
    }
    if (stack === "pruebas") {
        return `memoria-${service}`;
    }
    return `memoria-${service}-${stack}`;
};

// Cloud SQL
export const sqlCreate = config.getBoolean("sqlCreate") ?? true;
export const sqlInstanceName = config.get("sqlInstanceName") || name("postgres-db");

