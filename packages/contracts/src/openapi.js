"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOpenApiDocument = buildOpenApiDocument;
const zod_to_json_schema_1 = require("zod-to-json-schema");
const health_1 = require("./schemas/health");
const errors_1 = require("./schemas/errors");
/**
 * OpenAPI 3.1 document generated from the shared Zod contracts (spec: "a
 * single OpenAPI description generated from the request and response schemas,
 * so the web client and future public API cannot drift"). Served at
 * `/v1/openapi.json` and snapshot-tested.
 */
function buildOpenApiDocument() {
    return {
        openapi: "3.1.0",
        info: {
            title: "Form API",
            version: "0.1.0",
            description: "REST API under /v1. JSON, camelCase, ISO-8601 UTC timestamps. Errors use RFC 9457 Problem Details with a stable code.",
        },
        servers: [{ url: "/v1" }],
        tags: [
            { name: "operations", description: "Health and OpenAPI" },
        ],
        paths: {
            "/v1/health": {
                get: {
                    operationId: "getHealth",
                    tags: ["operations"],
                    summary: "Liveness and database reachability",
                    responses: {
                        "200": {
                            description: "Process is alive; `db` reports reachability",
                            content: {
                                "application/json": {
                                    schema: (0, zod_to_json_schema_1.zodToJsonSchema)(health_1.healthResponseSchema, {
                                        target: "openApi3",
                                    }),
                                },
                            },
                        },
                        "500": {
                            description: "Unexpected failure",
                            content: {
                                "application/problem+json": {
                                    schema: (0, zod_to_json_schema_1.zodToJsonSchema)(errors_1.problemDetailsSchema, {
                                        target: "openApi3",
                                    }),
                                },
                            },
                        },
                    },
                },
            },
            "/v1/openapi.json": {
                get: {
                    operationId: "getOpenApiDocument",
                    tags: ["operations"],
                    summary: "This document",
                    responses: {
                        "200": {
                            description: "OpenAPI 3.1 document",
                            content: {
                                "application/json": {
                                    schema: { type: "object" },
                                },
                            },
                        },
                    },
                },
            },
        },
        components: {
            schemas: {
                HealthResponse: (0, zod_to_json_schema_1.zodToJsonSchema)(health_1.healthResponseSchema, {
                    target: "openApi3",
                }),
                ProblemDetails: (0, zod_to_json_schema_1.zodToJsonSchema)(errors_1.problemDetailsSchema, {
                    target: "openApi3",
                }),
            },
        },
    };
}
//# sourceMappingURL=openapi.js.map