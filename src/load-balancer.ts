import * as gcp from "@pulumi/gcp";
import { region, name } from "./config";
import { authService } from "./cloud-run-auth";
import { grafanaService } from "./cloud-run-grafana";

// PILOTO: Solo se exponen los backends de Autenticación y Grafana.
// Los backends de datos y gestión han sido removidos del piloto.

const authNeg = new gcp.compute.RegionNetworkEndpointGroup("auth-neg", {
    name: name("auth-neg"),
    region,
    networkEndpointType: "SERVERLESS",
    cloudRun: {
        service: authService.name,
    },
});

const grafanaNeg = new gcp.compute.RegionNetworkEndpointGroup("grafana-neg", {
    name: name("grafana-neg"),
    region,
    networkEndpointType: "SERVERLESS",
    cloudRun: {
        service: grafanaService.name,
    },
});

const authBackend = new gcp.compute.BackendService("auth-backend", {
    name: name("auth-backend"),
    protocol: "HTTP",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    backends: [{ group: authNeg.id }],
});

const grafanaBackend = new gcp.compute.BackendService("grafana-backend", {
    name: name("grafana-backend"),
    protocol: "HTTP",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    backends: [{ group: grafanaNeg.id }],
});

// URL Map (routing) — Solo auth y grafana
const urlMap = new gcp.compute.URLMap("lb-url-map", {
    name: name("url-map"),
    defaultService: authBackend.id,
    hostRules: [{
        hosts: ["*"],
        pathMatcher: "all-paths",
    }],
    pathMatchers: [{
        name: "all-paths",
        defaultService: authBackend.id,
        pathRules: [
            // ── Autenticación ─────────────────────────────────────────────────
            {
                paths: ["/api/v1/auth/*", "/api/v1/auth"],
                service: authBackend.id,
            },
            // ── Grafana Monitoring ─────────────────────────────────────────────
            {
                paths: ["/grafana", "/grafana/*"],
                service: grafanaBackend.id,
            },
        ],
    }],
});

// Target HTTP Proxy
const targetProxy = new gcp.compute.TargetHttpProxy("lb-http-proxy", {
    name: name("http-proxy"),
    urlMap: urlMap.id,
});

// Global Forwarding Rule
export const loadBalancerForwardingRule = new gcp.compute.GlobalForwardingRule("lb-forwarding-rule", {
    name: name("forwarding-rule"),
    target: targetProxy.id,
    portRange: "80",
    loadBalancingScheme: "EXTERNAL_MANAGED",
});
