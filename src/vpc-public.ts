import * as gcp from "@pulumi/gcp";
import { name, region } from "./config";

export const publicVpc = new gcp.compute.Network("vpc-memoria-public", {
    name: name("vpc-public"),
    autoCreateSubnetworks: false,
});

export const publicSubnet = new gcp.compute.Subnetwork("subnet-public-gateway", {
    name: name("subnet-public"),
    ipCidrRange: "10.20.0.0/24",
    region,
    network: publicVpc.id,
});

export const allowHttpsIngress = new gcp.compute.Firewall("allow-https-ingress", {
    name: name("allow-https"),
    network: publicVpc.id,
    allows: [{
        protocol: "tcp",
        ports: ["443", "80"],
    }],
    sourceRanges: ["0.0.0.0/0"],
});
