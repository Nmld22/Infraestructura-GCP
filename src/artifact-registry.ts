import * as gcp from "@pulumi/gcp";
import { name, region } from "./config";

export const dockerRegistry = new gcp.artifactregistry.Repository("memoria-registry", {
    location: region,
    repositoryId: name("registry"),
    format: "DOCKER",
    description: "Docker repository for memoria microservices (piloto)",
});
