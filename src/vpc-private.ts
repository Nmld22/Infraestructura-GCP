import * as gcp from "@pulumi/gcp";
import { name, region } from "./config";

export const privateVpc = new gcp.compute.Network("vpc-memoria-private", {
    name: name("vpc-private"),
    autoCreateSubnetworks: false,
});

export const privateSubnet = new gcp.compute.Subnetwork("subnet-private-services", {
    name: name("subnet-private"),
    ipCidrRange: "10.10.0.0/24",
    region,
    network: privateVpc.id,
    privateIpGoogleAccess: true,
});

const router = new gcp.compute.Router("memoria-private-router", {
    name: name("private-router"),
    region,
    network: privateVpc.id,
});

export const nat = new gcp.compute.RouterNat("memoria-private-nat", {
    name: name("private-nat"),
    router: router.name,
    region,
    natIpAllocateOption: "AUTO_ONLY",
    sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
});

export const allowIapSsh = new gcp.compute.Firewall("allow-iap-ssh", {
    name: name("allow-iap-ssh"),
    network: privateVpc.id,
    allows: [{
        protocol: "tcp",
        ports: ["22"],
    }],
    sourceRanges: ["35.235.240.0/20"],
    targetTags: ["bastion"],
});

export const allowAllInternal = new gcp.compute.Firewall("allow-all-internal", {
    name: name("allow-all-internal"),
    network: privateVpc.id,
    allows: [{
        protocol: "all",
    }],
    sourceRanges: ["10.10.0.0/24"],
});

export const allowBcProcessorTcp = new gcp.compute.Firewall("allow-bc-processor-tcp", {
    name: name("allow-bc-processor-tcp"),
    network: privateVpc.id,
    allows: [{
        protocol: "tcp",
        ports: ["22", "5001"],
    }],
    // Allow GCP health checks and external internet for the TCP Load Balancer
    sourceRanges: ["130.211.0.0/22", "35.191.0.0/16", "0.0.0.0/0"],
    targetTags: ["bc-processor"],
});

export const allowCodecProcessorTcp = new gcp.compute.Firewall("allow-codec-processor-tcp", {
    name: name("allow-codec-processor-tcp"),
    network: privateVpc.id,
    allows: [{
        protocol: "tcp",
        ports: ["5001"],
    }],
    // Device traffic and Google TCP load balancer health checks.
    sourceRanges: ["130.211.0.0/22", "35.191.0.0/16", "0.0.0.0/0"],
    targetTags: ["codec-processor"],
});

export const allowCodecProcessorIapSsh = new gcp.compute.Firewall("allow-codec-processor-iap-ssh", {
    name: name("allow-codec-processor-iap-ssh"),
    network: privateVpc.id,
    allows: [{
        protocol: "tcp",
        ports: ["22"],
    }],
    sourceRanges: ["35.235.240.0/20"],
    targetTags: ["codec-processor"],
});
