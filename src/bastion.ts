import * as gcp from "@pulumi/gcp";
import { name, zone, stack } from "./config";
import { privateVpc, privateSubnet } from "./vpc-private";


const bastionSa = new gcp.serviceaccount.Account("bastion-sa", {
    accountId: `wm-bastion-sa-${stack}`,
    displayName: "Bastion Host Service Account",
});

export const bastionHost = new gcp.compute.Instance("bastion-host", {
    name: name("bastion"),
    machineType: "e2-small",
    zone,
    allowStoppingForUpdate: true,
    bootDisk: {
        initializeParams: {
            image: "debian-cloud/debian-12",
        },
    },
    networkInterfaces: [{
        network: privateVpc.id,
        subnetwork: privateSubnet.id,
    }],
    serviceAccount: {
        email: bastionSa.email,
        scopes: ["cloud-platform"],
    },
    metadataStartupScript: `#!/bin/bash
set -e
apt-get update
apt-get install -y postgresql-client
`,
    tags: ["bastion"],
});
