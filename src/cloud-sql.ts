import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { privateVpc } from "./vpc-private";
import { isProd, region, name, project, sqlCreate, sqlInstanceName, stack } from "./config";


// Reserve an internal IP range for private services
const privateIpRange = new gcp.compute.GlobalAddress("private-ip-range", {
    name: stack === "pruebas" ? undefined : name("private-ip-range"),
    purpose: "VPC_PEERING",
    addressType: "INTERNAL",
    prefixLength: 16,
    network: privateVpc.id,
});

// Create a private connection
const privateVpcConnection = new gcp.servicenetworking.Connection("private-vpc-connection", {
    network: privateVpc.id,
    service: "servicenetworking.googleapis.com",
    reservedPeeringRanges: [privateIpRange.name],
});

// Cloud SQL instance (create or reuse)
const sqlInstanceResource = sqlCreate ? new gcp.sql.DatabaseInstance("memoria-postgres-db", {
    name: sqlInstanceName,
    databaseVersion: "POSTGRES_15",
    region: region,
    settings: {
        tier: isProd ? "db-custom-2-7680" : "db-f1-micro",
        ipConfiguration: {
            ipv4Enabled: false,
            privateNetwork: privateVpc.id,
        },
        databaseFlags: [{
            name: "cloudsql.iam_authentication",
            value: "on",
        }],
        backupConfiguration: {
            enabled: true,
        },
    },
    deletionProtection: isProd,
}, { dependsOn: [privateVpcConnection] }) : undefined;

const existingSqlInstance = sqlCreate ? undefined : gcp.sql.getDatabaseInstanceOutput({
    name: sqlInstanceName,
    project,
});

export const sqlInstance = {
    name: sqlCreate ? sqlInstanceResource!.name : existingSqlInstance!.name,
    privateIpAddress: sqlCreate ? sqlInstanceResource!.privateIpAddress : existingSqlInstance!.privateIpAddress,
};

export const sqlDatabase = new gcp.sql.Database("auth_db", {
    instance: sqlInstance.name,
    name: name("auth-db"),
}, { dependsOn: sqlInstanceResource ? [sqlInstanceResource] : [] });

export const sqlUser = new gcp.sql.User("root-user", {
    name: `root`,
    instance: sqlInstance.name,
    password: new pulumi.Config().requireSecret("dbPassword"),
}, { dependsOn: sqlInstanceResource ? [sqlInstanceResource] : [] });

// ── Base de datos y usuario dedicados para Grafana ────────────────────────────
// Completamente independientes del auth_db y root-user existentes.
// Grafana usará PostgreSQL como backend en lugar de SQLite,
// resolviendo la incompatibilidad de GCS FUSE con escrituras aleatorias.
export const grafanaDatabase = new gcp.sql.Database("grafana-db", {
    instance: sqlInstance.name,
    name: name("grafana-db"),
}, { dependsOn: sqlInstanceResource ? [sqlInstanceResource] : [] });

export const grafanaUser = new gcp.sql.User("grafana-user", {
    name: "grafana",
    instance: sqlInstance.name,
    password: new pulumi.Config().requireSecret("grafanaDbPassword"),
}, { dependsOn: sqlInstanceResource ? [sqlInstanceResource] : [] });
