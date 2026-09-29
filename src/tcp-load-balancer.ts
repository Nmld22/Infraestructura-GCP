import * as gcp from "@pulumi/gcp";
import { name, region } from "./config";
import { bcProcessorGroup } from "./compute-engine-bc";
import { codecProcessorGroup } from "./compute-engine-codec";

// BC keeps its existing address and port.
export const tcpLbIp = new gcp.compute.Address("tcp-lb-ip", {
    name: name("tcp-lb-ip"),
    region,
    networkTier: "PREMIUM",
});

// Codec8 also listens on 5001, so it needs a dedicated address to avoid
// colliding with BC's tcpLbIp:5001 forwarding rule.
export const codecTcpLbIp = new gcp.compute.Address("codec-tcp-lb-ip", {
    name: name("codec-tcp-lb-ip"),
    region,
    networkTier: "PREMIUM",
});

const tcpHealthCheck = new gcp.compute.RegionHealthCheck("tcp-health-check", {
    name: name("tcp-health-check"),
    region,
    tcpHealthCheck: { port: 5001 },
});

const tcpBackendService = new gcp.compute.RegionBackendService("tcp-backend-service", {
    name: name("tcp-backend-service"),
    region,
    loadBalancingScheme: "EXTERNAL",
    protocol: "TCP",
    healthChecks: tcpHealthCheck.id,
    backends: [{ group: bcProcessorGroup.id }],
});

export const tcpForwardingRule = new gcp.compute.ForwardingRule("tcp-forwarding-rule", {
    name: name("tcp-forwarding-rule"),
    region,
    ipAddress: tcpLbIp.id,
    loadBalancingScheme: "EXTERNAL",
    ipProtocol: "TCP",
    ports: ["5001"],
    backendService: tcpBackendService.id,
});

const codecTcpHealthCheck = new gcp.compute.RegionHealthCheck("codec-tcp-health-check", {
    name: name("codec-tcp-health-check"),
    region,
    tcpHealthCheck: { port: 5001 },
});

const codecTcpBackendService = new gcp.compute.RegionBackendService("codec-tcp-backend-service", {
    name: name("codec-tcp-backend-service"),
    region,
    loadBalancingScheme: "EXTERNAL",
    protocol: "TCP",
    healthChecks: codecTcpHealthCheck.id,
    backends: [{ group: codecProcessorGroup.id }],
});

export const codecTcpForwardingRule = new gcp.compute.ForwardingRule("codec-tcp-forwarding-rule", {
    name: name("codec-tcp-forwarding-rule"),
    region,
    ipAddress: codecTcpLbIp.id,
    loadBalancingScheme: "EXTERNAL",
    ipProtocol: "TCP",
    ports: ["5001"],
    backendService: codecTcpBackendService.id,
});
