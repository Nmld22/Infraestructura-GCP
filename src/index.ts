// ── Piloto: Infraestructura recortada ─────────────────────────────────────────
// Servicios desplegados:
//   ✅ VPC privada y pública
//   ✅ Artifact Registry
//   ✅ Cloud SQL (PostgreSQL)
//   ✅ Secret Manager (db-password, jwt-secret)
//   ✅ Cloud Run Autenticación
//   ✅ Cloud Run Grafana
//   ✅ Bastion Host
//   ✅ Compute Engine BC Processor (puerto 5001)
//   ✅ Compute Engine Codec Processor (puerto 5001)
//   ✅ NLB TCP (puerto 5001 en IP dedicada para Codec8)
//   ✅ Application Load Balancer (solo auth + grafana)
// ✂️ Servicios recortados del piloto:
//   ❌ API Gateway (removido por ser redundante en el piloto)
//   ❌ Cloud Run Datos
//   ❌ Cloud Run Gestión
//   ❌ Firestore
//   ❌ Firebase / Hosting

import "./vpc-private";
import "./vpc-public";
import "./cloud-sql";
import "./artifact-registry";
import "./secret-manager";
import "./cloud-run-auth";
import "./cloud-run-grafana";
import "./load-balancer";
import "./bastion";
import "./compute-engine-bc";
import "./compute-engine-codec";
import { tcpLbIp, codecTcpLbIp } from "./tcp-load-balancer";
import { loadBalancerForwardingRule } from "./load-balancer";
import { authService } from "./cloud-run-auth";
import { dockerRegistry } from "./artifact-registry";
import { region, project } from "./config";
import * as pulumi from "@pulumi/pulumi";

export const tcpLoadBalancerIp = tcpLbIp.address;
export const codecTcpLoadBalancerIp = codecTcpLbIp.address;
export const grafanaUrl = pulumi.interpolate`http://${loadBalancerForwardingRule.ipAddress}/grafana/`;

// Outputs requeridos por el Pipeline de CI/CD de autenticación:
export const authServiceName = authService.name;
export const artifactRegistryRepository = dockerRegistry.repositoryId;
export const artifactRegistryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${dockerRegistry.repositoryId}`;

export const message = "Infraestructura Piloto desplegada correctamente.";

