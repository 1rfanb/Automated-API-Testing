import "dotenv/config";

import express from "express";
import path from "path";
import fs from "fs";
import * as yaml from "js-yaml";
import axios from "axios";
import { fileURLToPath } from "url";
import crypto from "crypto";

import upload from "./uploads.js";
import db from "./database/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// =====================================================
// MYSQL CONNECTION
// =====================================================

// const db = mysql.createConnection({
//     host: process.env.DB_HOST || "localhost",
//     user: process.env.DB_USER || "root",
//    password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME || "api_testing"
// });

// db.connect((err) => {
//     if (err) {
//         console.error(
//             "❌ MySQL connection failed:",
//             err.message
//         );
//         return;
//     }

//     console.log("✅ MySQL connected successfully!");
// });

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
    express.static(
        path.join(__dirname, "../frontend")
    )
);

// =====================================================
// FAVICON
// =====================================================

app.get("/favicon.ico", (req, res) => {
    res.status(204).end();
});

// =====================================================
// HOME PAGE
// =====================================================

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            "../frontend/index.html"
        )
    );
});

// =====================================================
// TEST BACKEND
// =====================================================

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "Backend API is working!"
    });
});

// =====================================================
// GET ALL IMPORTED APIS
// =====================================================
//
// Supports optional ?testRunId=... filter so the frontend
// can scope the API list down to a single upload/import
// session instead of always seeing every API ever imported.
// =====================================================

app.get("/api/apis", (req, res) => {

    // -----------------------------------------------------
    // RESOLVE WHICH TEST_RUN_ID TO FILTER BY
    //
    // Priority:
    //   1. An explicit ?testRunId=... from the frontend.
    //   2. The server's currently active upload/import
    //      session (app.locals.testRunId).
    //   3. If neither exists (e.g. nothing has ever been
    //      uploaded this session) AND ?all=true was not
    //      passed, we still fall through to "no filter"
    //      below - this only happens before any upload has
    //      occurred, so the table is effectively empty or
    //      holds legacy data the user can inspect via ?all.
    //
    // This is the actual fix for "Imported APIs section
    // fetches everything instead of only the current
    // upload's APIs": previously this endpoint ignored
    // app.locals.testRunId entirely and only filtered when
    // the frontend remembered to pass the param explicitly.
    // -----------------------------------------------------

    const showAll =
        req.query.all === "true" ||
        req.query.all === "1";

    const requestedTestRunId =
        req.query.testRunId;

    const effectiveTestRunId =
        showAll
            ? null
            : (
                requestedTestRunId ||
                app.locals.testRunId ||
                null
            );

    let sql = `
        SELECT
            ID AS id,
            NAME AS name,
            METHOD AS method,
            ENDPOINTS AS endpoints,
            TEST_RUN_ID AS test_run_id,
            CREATE_AT AS created_at
        FROM apis
    `;

    const params = [];

    if (effectiveTestRunId) {
        sql += ` WHERE TEST_RUN_ID = ? `;
        params.push(effectiveTestRunId);
    }

    sql += ` ORDER BY ID DESC `;

    db.query(sql, params, (err, results) => {

        if (err) {
            console.error(
                "MYSQL API FETCH ERROR:",
                err.message
            );

            return res.status(500).json({
                success: false,
                error: "Database query failed",
                details: err.message
            });
        }

        res.json({
            success: true,
            testRunId:
                effectiveTestRunId,
            apis: results
        });
    });
});

// =====================================================
// ADD API MANUALLY
// =====================================================

app.post("/api/apis", (req, res) => {

    const {
        name,
        method,
        endpoint
    } = req.body;

    if (!name || !method || !endpoint) {
        return res.status(400).json({
            success: false,
            error:
                "Name, method and endpoint are required"
        });
    }

    const cleanMethod =
        String(method).toUpperCase();

    const cleanEndpoint =
        String(endpoint).trim();

    const checkSQL = `
        SELECT ID
        FROM apis
        WHERE METHOD = ?
        AND ENDPOINTS = ?
    `;

    db.query(
        checkSQL,
        [
            cleanMethod,
            cleanEndpoint
        ],
        (checkError, existing) => {

            if (checkError) {
                return res.status(500).json({
                    success: false,
                    error: "Database check failed",
                    details:
                        checkError.message
                });
            }

            if (existing.length > 0) {
                return res.status(409).json({
                    success: false,
                    duplicate: true,
                    message:
                        "API already exists",
                    id: existing[0].ID
                });
            }

            const sql = `
                INSERT INTO apis
                (NAME, METHOD, ENDPOINTS)
                VALUES (?, ?, ?)
            `;

            db.query(
                sql,
                [
                    name,
                    cleanMethod,
                    cleanEndpoint
                ],
                (err, result) => {

                    if (err) {
                        console.error(
                            "MYSQL INSERT ERROR:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            error:
                                "Failed to add API",
                            details:
                                err.message
                        });
                    }

                    res.status(201).json({
                        success: true,
                        message:
                            "API added successfully",
                        id:
                            result.insertId
                    });
                }
            );
        }
    );
});

// =====================================================
// UPLOAD OPENAPI FILE
// =====================================================
//
// Generates a single TEST_RUN_ID for this upload session,
// tags every imported `apis` row with it (see
// importEndpoints), and returns it to the frontend so it
// can be reused for /api/apis, /api/run-test and
// /api/report.
// =====================================================

app.post(
    "/api/upload",
    upload.single("apiFile"),
    async (req, res) => {

        try {

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error:
                        "No API specification file uploaded"
                });
            }

            console.log(
                "📁 File received:",
                req.file.originalname
            );

            const fileData =
                fs.readFileSync(
                    req.file.path,
                    "utf8"
                );

            const apiSpec =
                parseSpecification(
                    fileData,
                    req.file.originalname
                );

            if (
                !apiSpec ||
                !apiSpec.paths
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid API specification: paths not found"
                });
            }

            const serverUrl =
                getServerUrl(apiSpec);

            const endpoints =
                extractEndpoints(apiSpec);

            const testRunId =
                generateTestRunId();

            console.log(
                "🌐 Server URL:",
                serverUrl || "Not specified"
            );

            console.log(
                "🔗 Detected endpoints:",
                endpoints.length
            );

            console.log(
                "🆔 Test Run ID:",
                testRunId
            );

            // Keep current specification in memory
            // for the currently uploaded session.
            app.locals.apiSpec = apiSpec;
            app.locals.endpoints = endpoints;
            app.locals.serverUrl = serverUrl;
            app.locals.testRunId = testRunId;

            if (endpoints.length === 0) {
                return res.json({
                    success: true,
                    message:
                        "API specification uploaded successfully",
                    filename:
                        req.file.originalname,
                    serverUrl:
                        serverUrl,
                    testRunId:
                        testRunId,
                    totalEndpoints: 0,
                    imported: 0,
                    duplicates: 0,
                    endpoints: []
                });
            }

            const importResult =
                await importEndpoints(
                    endpoints,
                    testRunId
                );

            res.json({
                success: true,
                message:
                    "API specification uploaded successfully",
                filename:
                    req.file.originalname,
                serverUrl:
                    serverUrl,
                testRunId:
                    testRunId,
                totalEndpoints:
                    endpoints.length,
                imported:
                    importResult.imported,
                duplicates:
                    importResult.duplicates,
                endpoints:
                    endpoints
            });

        } catch (error) {

            console.error(
                "❌ UPLOAD ERROR:",
                error
            );

            res.status(400).json({
                success: false,
                error:
                    "Unable to parse API specification",
                details:
                    error.message
            });
        }
    }
);

// =====================================================
// PARSE UPLOADED FILE
// =====================================================

app.get(
    "/api/parse/:filename",
    (req, res) => {

        const filePath =
            path.join(
                __dirname,
                "../uploads",
                req.params.filename
            );

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: "File not found"
            });
        }

        try {

            const fileContent =
                fs.readFileSync(
                    filePath,
                    "utf8"
                );

            const apiSpec =
                parseSpecification(
                    fileContent,
                    req.params.filename
                );

            if (
                !apiSpec ||
                !apiSpec.paths
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid API specification: paths not found"
                });
            }

            const endpoints =
                extractEndpoints(apiSpec);

            res.json({
                success: true,
                message:
                    "API specification parsed successfully",
                serverUrl:
                    getServerUrl(apiSpec),
                endpoints:
                    endpoints
            });

        } catch (error) {

            console.error(
                "PARSE ERROR:",
                error.message
            );

            res.status(400).json({
                success: false,
                error:
                    "Invalid API specification",
                details:
                    error.message
            });
        }
    }
);

// =====================================================
// IMPORT APIS
// =====================================================
//
// Also generates its own TEST_RUN_ID (this route is a
// separate entry point from /api/upload) and returns it,
// so a re-import via /api/import/:filename can be filtered
// on its own run just like a fresh upload can.
// =====================================================

app.post(
    "/api/import/:filename",
    async (req, res) => {

        const filePath =
            path.join(
                __dirname,
                "../uploads",
                req.params.filename
            );

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({
                success: false,
                error: "File not found"
            });
        }

        try {

            const fileContent =
                fs.readFileSync(
                    filePath,
                    "utf8"
                );

            const apiSpec =
                parseSpecification(
                    fileContent,
                    req.params.filename
                );

            if (
                !apiSpec ||
                !apiSpec.paths
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "Invalid API specification"
                });
            }

            const endpoints =
                extractEndpoints(apiSpec);

            if (endpoints.length === 0) {
                return res.status(400).json({
                    success: false,
                    error:
                        "No API endpoints found"
                });
            }

            const testRunId =
                generateTestRunId();

            app.locals.apiSpec =
                apiSpec;

            app.locals.endpoints =
                endpoints;

            app.locals.serverUrl =
                getServerUrl(apiSpec);

            app.locals.testRunId =
                testRunId;

            const result =
                await importEndpoints(
                    endpoints,
                    testRunId
                );

            res.status(201).json({
                success: true,
                message:
                    "APIs imported successfully",
                testRunId:
                    testRunId,
                imported:
                    result.imported,
                duplicates:
                    result.duplicates,
                total:
                    endpoints.length,
                endpoints:
                    endpoints
            });

        } catch (error) {

            console.error(
                "IMPORT ERROR:",
                error.message
            );

            res.status(400).json({
                success: false,
                error:
                    "Invalid API specification",
                details:
                    error.message
            });
        }
    }
);

// =====================================================
// GET API DETAILS
// =====================================================

app.get(
    "/api/apis/:id/details",
    (req, res) => {

        const apiId =
            req.params.id;

        const sql = `
            SELECT
                a.ID AS id,
                a.NAME AS name,
                a.METHOD AS method,
                a.ENDPOINTS AS endpoint
            FROM apis a
            WHERE a.ID = ?
        `;

        db.query(
            sql,
            [apiId],
            (err, results) => {

                if (err) {
                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to fetch API details",
                        details:
                            err.message
                    });
                }

                if (results.length === 0) {
                    return res.status(404).json({
                        success: false,
                        error:
                            "API not found"
                    });
                }

                const api =
                    results[0];

                const spec =
                    app.locals.apiSpec;

                let operation = null;

                if (
                    spec &&
                    spec.paths &&
                    spec.paths[api.endpoint]
                ) {

                    operation =
                        spec.paths[
                            api.endpoint
                        ][
                            api.method.toLowerCase()
                        ];
                }

                const parameters =
                    getParameters(
                        spec,
                        api.endpoint,
                        operation
                    );

                const requestBody =
                    getRequestBody(
                        operation,
                        spec
                    );

                const security =
                    getSecurityInfo(
                        spec,
                        operation
                    );

                const responses =
                    getResponseDefinitions(
                        operation
                    );

                res.json({
                    success: true,

                    api: {
                        id:
                            api.id,
                        name:
                            api.name,
                        method:
                            api.method,
                        endpoint:
                            api.endpoint
                    },

                    parameters:
                        parameters,

                    requestBody:
                        requestBody,

                    security:
                        security,

                    responses:
                        responses
                });
            }
        );
    }
);

// =====================================================
// DASHBOARD STATISTICS
// =====================================================

app.get(
    "/api/dashboard-stats",
    (req, res) => {

        const sql = `
            SELECT

                (SELECT COUNT(*)
                 FROM apis) AS totalApis,

                (SELECT COUNT(*)
                 FROM test_cases) AS totalTestCases,

                (SELECT COUNT(*)
                 FROM test_results
                 WHERE result = 'PASS') AS passedTests,

                (SELECT COUNT(*)
                 FROM test_results
                 WHERE result = 'FAIL') AS failedTests,

                (SELECT COALESCE(
                    ROUND(AVG(response_time)),
                    0
                 )
                 FROM test_results) AS averageResponseTime
        `;

        db.query(
            sql,
            (err, results) => {

                if (err) {
                    console.error(
                        "DASHBOARD STATS ERROR:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to load dashboard statistics",
                        details:
                            err.message
                    });
                }

                const stats =
                    results[0];

                const totalTests =
                    Number(
                        stats.passedTests
                    ) +
                    Number(
                        stats.failedTests
                    );

                const passRate =
                    totalTests === 0
                        ? 0
                        : Math.round(
                            (
                                Number(
                                    stats.passedTests
                                ) /
                                totalTests
                            ) * 100
                        );

                res.json({
                    success: true,

                    totalApis:
                        Number(
                            stats.totalApis
                        ),

                    totalTestCases:
                        Number(
                            stats.totalTestCases
                        ),

                    passedTests:
                        Number(
                            stats.passedTests
                        ),

                    failedTests:
                        Number(
                            stats.failedTests
                        ),

                    totalTests:
                        totalTests,

                    passRate:
                        passRate,

                    averageResponseTime:
                        Number(
                            stats.averageResponseTime
                        )
                });
            }
        );
    }
);

// =====================================================
// GENERATE ADVANCED TEST CASE
// =====================================================

app.post(
    "/api/generate-tests",
    (req, res) => {

        const {
            apiId,
            testName,
            expectedStatus,
            pathParams,
            queryParams,
            requestBody
        } = req.body;

        if (!apiId) {
            return res.status(400).json({
                success: false,
                error:
                    "API ID is required"
            });
        }

        const name =
            testName ||
            "Status Code Test";

        const expected =
            Number(expectedStatus) || 200;

        const pathData =
            normaliseObject(
                pathParams
            );

        const queryData =
            normaliseObject(
                queryParams
            );

        const bodyData =
            requestBody === undefined ||
            requestBody === null ||
            requestBody === ""
                ? null
                : requestBody;

        const pathJSON =
            JSON.stringify(pathData);

        const queryJSON =
            JSON.stringify(queryData);

        const bodyJSON =
            bodyData === null
                ? null
                : typeof bodyData === "string"
                    ? bodyData
                    : JSON.stringify(
                        bodyData
                    );

        const checkSQL = `
            SELECT id
            FROM test_cases
            WHERE AIP_ID = ?
            AND TEST_NAME = ?
            AND EXPECTED_STATUS = ?
        `;

        db.query(
            checkSQL,
            [
                apiId,
                name,
                expected
            ],
            (checkError, existing) => {

                if (checkError) {
                    console.error(
                        "TEST CASE CHECK ERROR:",
                        checkError.message
                    );

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to check existing test case",
                        details:
                            checkError.message
                    });
                }

                if (existing.length > 0) {
                    return res.status(200).json({
                        success: true,
                        duplicate: true,
                        message:
                            "Test case already exists",
                        testCaseId:
                            existing[0].id
                    });
                }

                const sql = `
                    INSERT INTO test_cases
                    (
                        AIP_ID,
                        TEST_NAME,
                        EXPECTED_STATUS,
                        PATH_PARAMS,
                        QUERY_PARAMS,
                        REQUEST_BODY
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                `;

                db.query(
                    sql,
                    [
                        apiId,
                        name,
                        expected,
                        pathJSON,
                        queryJSON,
                        bodyJSON
                    ],
                    (err, result) => {

                        if (err) {
                            console.error(
                                "TEST CASE INSERT ERROR:",
                                err.message
                            );

                            return res.status(500).json({
                                success: false,
                                error:
                                    "Failed to create test case",
                                details:
                                    err.message
                            });
                        }

                        res.status(201).json({
                            success: true,
                            duplicate: false,
                            message:
                                "Advanced test case generated successfully",

                            testCaseId:
                                result.insertId,

                            pathParams:
                                pathData,

                            queryParams:
                                queryData,

                            requestBody:
                                bodyData
                        });
                    }
                );
            }
        );
    }
);

// =====================================================
// AUTO GENERATE TESTS FROM API
// =====================================================

app.post(
    "/api/generate-tests/auto",
    async (req, res) => {

        try {

            const {
                apiId,
                includeNegative = true
            } = req.body;

            if (!apiId) {
                return res.status(400).json({
                    success: false,
                    error:
                        "API ID is required"
                });
            }

            const api =
                await getApiById(
                    apiId
                );

            if (!api) {
                return res.status(404).json({
                    success: false,
                    error:
                        "API not found"
                });
            }

            const spec =
                app.locals.apiSpec;

            if (
                !spec ||
                !spec.paths ||
                !spec.paths[api.endpoint]
            ) {

                return res.status(400).json({
                    success: false,
                    error:
                        "OpenAPI specification for this API is not available in the current server session"
                });
            }

            const operation =
                spec.paths[
                    api.endpoint
                ][
                    api.method.toLowerCase()
                ];

            if (!operation) {
                return res.status(400).json({
                    success: false,
                    error:
                        "OpenAPI operation not found"
                });
            }

            const parameters =
                getParameters(
                    spec,
                    api.endpoint,
                    operation
                );

            const requestBody =
                getRequestBody(
                    operation,
                    spec
                );

            const responses =
                getResponseDefinitions(
                    operation
                );

            const generated = [];

            const expected =
                getPreferredExpectedStatus(
                    responses
                );

            const pathParams = {};

            const queryParams = {};

            for (
                const parameter
                of parameters
            ) {

                const value =
                    parameter.example !== undefined
                        ? parameter.example
                        : parameter.generatedValue;

                if (
                    parameter.in === "path"
                ) {

                    pathParams[
                        parameter.name
                    ] = value;

                }

                else if (
                    parameter.in === "query"
                ) {

                    queryParams[
                        parameter.name
                    ] = value;

                }
            }

            let generatedBody =
                requestBody?.example ??
                null;

            const positiveName =
                `Verify ${api.method} ${api.endpoint}`;

            const positiveId =
                await createTestCaseIfNeeded({
                    apiId,
                    testName:
                        positiveName,
                    expectedStatus:
                        expected,
                    pathParams,
                    queryParams,
                    requestBody:
                        generatedBody
                });

            generated.push({
                type: "positive",
                testName:
                    positiveName,
                expectedStatus:
                    expected,
                testCaseId:
                    positiveId
            });

            if (
                includeNegative
            ) {

                const negativeStatus =
                    getNegativeExpectedStatus(
                        responses,
                        api.method
                    );

                if (
                    negativeStatus
                ) {

                    const negativeName =
                        `Negative test ${api.method} ${api.endpoint}`;

                    const negativePath =
                        createNegativePathParams(
                            parameters
                        );

                    const negativeQuery =
                        createNegativeQueryParams(
                            parameters
                        );

                    const negativeId =
                        await createTestCaseIfNeeded({
                            apiId,
                            testName:
                                negativeName,
                            expectedStatus:
                                negativeStatus,
                            pathParams:
                                negativePath,
                            queryParams:
                                negativeQuery,
                            requestBody:
                                generatedBody
                        });

                    generated.push({
                        type: "negative",
                        testName:
                            negativeName,
                        expectedStatus:
                            negativeStatus,
                        testCaseId:
                            negativeId
                    });
                }
            }

            res.status(201).json({
                success: true,
                message:
                    "Automatic test cases generated successfully",
                totalGenerated:
                    generated.length,
                tests:
                    generated
            });

        } catch (error) {

            console.error(
                "AUTO TEST GENERATION ERROR:",
                error
            );

            res.status(500).json({
                success: false,
                error:
                    "Failed to automatically generate tests",
                details:
                    error.message
            });
        }
    }
);

// =====================================================
// GET ALL TEST CASES
// =====================================================

app.get(
    "/api/test-cases",
    (req, res) => {

        const sql = `
            SELECT
                id,
                AIP_ID AS api_id,
                TEST_NAME AS test_name,
                EXPECTED_STATUS AS expected_status,
                PATH_PARAMS AS path_params,
                QUERY_PARAMS AS query_params,
                REQUEST_BODY AS request_body,
                CREATEED_AT AS created_at
            FROM test_cases
            ORDER BY id DESC
        `;

        db.query(
            sql,
            (err, results) => {

                if (err) {
                    console.error(
                        "TEST CASE FETCH ERROR:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to fetch test cases",
                        details:
                            err.message
                    });
                }

                res.json({
                    success: true,
                    testCases:
                        results
                });
            }
        );
    }
);

// =====================================================
// GET SINGLE TEST CASE
// =====================================================

app.get(
    "/api/test-cases/:id",
    async (req, res) => {

        try {

            const testCase =
                await getTestCase(
                    req.params.id
                );

            if (!testCase) {
                return res.status(404).json({
                    success: false,
                    error:
                        "Test case not found"
                });
            }

            res.json({
                success: true,
                testCase:
                    testCase
            });

        } catch (error) {

            res.status(500).json({
                success: false,
                error:
                    "Failed to fetch test case",
                details:
                    error.message
            });
        }
    }
);

// =====================================================
// RUN API TEST
// =====================================================

app.post(
    "/api/run-test",
    async (req, res) => {

        const startTime =
            Date.now();

        try {

            let {
                method,
                url,
                expectedStatus,
                testCaseId,

                // =================================================
                // TEST RUN ID
                // =================================================
                testRunId,

                pathParams,
                queryParams,
                requestBody,
                headers,
                auth,
                validateResponse,
                expectedContentType,
                expectedBody
            } = req.body;


            console.log(
                "===================================="
            );

            console.log(
                "🧪 API TEST REQUEST"
            );

            console.log(
                "Method:",
                method
            );

            console.log(
                "URL:",
                url
            );

            console.log(
                "Expected:",
                expectedStatus
            );

            console.log(
                "Test Case ID:",
                testCaseId
            );

            console.log(
                "Test Run ID:",
                testRunId
            );


            // =================================================
            // VALIDATE METHOD + URL
            // =================================================

            if (!method || !url) {

                return res.status(400).json({

                    success: false,

                    result: "FAIL",

                    actualStatus:
                        "ERROR",

                    expectedStatus:
                        Number(
                            expectedStatus
                        ) || 200,

                    responseTime:
                        Date.now() -
                        startTime,

                    testRunId:
                        testRunId ||
                        null,

                    error:
                        "Method and URL are required"
                });
            }


            // =================================================
            // LOAD TEST CASE DATA
            // =================================================

            if (
                testCaseId &&
                (
                    pathParams === undefined ||
                    queryParams === undefined ||
                    requestBody === undefined
                )
            ) {

                const testCase =
                    await getTestCase(
                        testCaseId
                    );


                if (testCase) {


                    // -----------------------------------------
                    // PATH PARAMETERS
                    // -----------------------------------------

                    if (
                        pathParams === undefined
                    ) {

                        pathParams =
                            parseStoredJSON(
                                testCase.path_params
                            );
                    }


                    // -----------------------------------------
                    // QUERY PARAMETERS
                    // -----------------------------------------

                    if (
                        queryParams === undefined
                    ) {

                        queryParams =
                            parseStoredJSON(
                                testCase.query_params
                            );
                    }


                    // -----------------------------------------
                    // REQUEST BODY
                    // -----------------------------------------

                    if (
                        requestBody === undefined
                    ) {

                        requestBody =
                            parseStoredJSON(
                                testCase.request_body
                            );
                    }


                    // -----------------------------------------
                    // EXPECTED STATUS
                    // -----------------------------------------

                    if (
                        expectedStatus ===
                        undefined
                    ) {

                        expectedStatus =
                            testCase.EXPECTED_STATUS;
                    }
                }
            }


            // =================================================
            // FALL BACK TO THE ACTIVE UPLOAD'S TEST RUN ID
            // IF THE FRONTEND DIDN'T PASS ONE EXPLICITLY
            // =================================================

            if (!testRunId && app.locals.testRunId) {

                testRunId =
                    app.locals.testRunId;
            }


            // =================================================
            // NORMALISE DATA
            // =================================================

            pathParams =
                normaliseObject(
                    pathParams
                );

            queryParams =
                normaliseObject(
                    queryParams
                );


            // =================================================
            // EXPECTED STATUS
            // =================================================

            const expected =
                Number(
                    expectedStatus
                );


            if (
                Number.isNaN(
                    expected
                )
            ) {

                return res.status(400).json({

                    success: false,

                    result: "FAIL",

                    actualStatus:
                        "ERROR",

                    expectedStatus:
                        200,

                    responseTime:
                        Date.now() -
                        startTime,

                    testRunId:
                        testRunId ||
                        null,

                    error:
                        "Expected status must be a number"
                });
            }


            // =================================================
            // BUILD URL
            // =================================================

            let testUrl =
                String(url);


            for (
                const key
                of Object.keys(
                    pathParams
                )
            ) {

                const value =
                    pathParams[key];


                testUrl =
                    testUrl.replace(

                        new RegExp(
                            `\\{${escapeRegExp(key)}\\}`,
                            "g"
                        ),

                        encodeURIComponent(
                            String(value)
                        )
                    );
            }


            // =================================================
            // FALLBACK FOR UNRESOLVED
            // OPENAPI PATH PARAMETERS
            // =================================================

            testUrl =
                testUrl.replace(
                    /\{[^}]+\}/g,
                    "1"
                );


            // =================================================
            // PARSE URL
            // =================================================

            let parsedUrl;


            try {

                parsedUrl =
                    new URL(
                        testUrl
                    );

            } catch {

                return res.status(400).json({

                    success: false,

                    result: "FAIL",

                    actualStatus:
                        "ERROR",

                    expectedStatus:
                        expected,

                    responseTime:
                        Date.now() -
                        startTime,

                    testRunId:
                        testRunId ||
                        null,

                    error:
                        "Invalid URL. The API specification must contain a valid server URL or an absolute URL must be supplied."
                });
            }


            // =================================================
            // QUERY PARAMETERS
            // =================================================

            for (
                const key
                of Object.keys(
                    queryParams
                )
            ) {

                const value =
                    queryParams[key];


                if (
                    value !== undefined &&
                    value !== null &&
                    value !== ""
                ) {


                    // -----------------------------------------
                    // ARRAY QUERY PARAMETER
                    // -----------------------------------------

                    if (
                        Array.isArray(
                            value
                        )
                    ) {

                        parsedUrl.searchParams.delete(
                            key
                        );


                        value.forEach(
                            item => {

                                parsedUrl.searchParams.append(
                                    key,
                                    String(item)
                                );

                            }
                        );


                    } else {


                        // -------------------------------------
                        // NORMAL QUERY PARAMETER
                        // -------------------------------------

                        parsedUrl.searchParams.set(
                            key,
                            String(value)
                        );
                    }
                }
            }


            // =================================================
            // HEADERS
            // =================================================

            const requestHeaders = {

                Accept:
                    "application/json"
            };


            if (
                headers &&
                typeof headers === "object" &&
                !Array.isArray(headers)
            ) {

                Object.assign(
                    requestHeaders,
                    headers
                );
            }


            // =================================================
            // AUTHENTICATION
            // =================================================

            applyAuthentication(
                requestHeaders,
                auth
            );


            // =================================================
            // REQUEST BODY
            // =================================================

            let finalBody =
                requestBody;


            if (
                typeof finalBody ===
                "string"
            ) {

                try {

                    finalBody =
                        JSON.parse(
                            finalBody
                        );

                } catch {

                    // Keep raw string.
                }
            }


            // =================================================
            // HTTP METHOD
            // =================================================

            const cleanMethod =
                String(
                    method
                ).toUpperCase();


            // =================================================
            // AXIOS CONFIG
            // =================================================

            const axiosConfig = {

                method:
                    cleanMethod.toLowerCase(),

                url:
                    parsedUrl.href,

                timeout:
                    Number(
                        req.body.timeout
                    ) > 0

                        ? Number(
                            req.body.timeout
                        )

                        : 10000,

                validateStatus:
                    () => true,

                headers:
                    requestHeaders
            };


            // =================================================
            // REQUEST BODY
            // =================================================

            if (
                finalBody !== undefined &&
                finalBody !== null &&
                finalBody !== ""
            ) {

                axiosConfig.data =
                    finalBody;


                if (
                    !hasHeader(
                        requestHeaders,
                        "Content-Type"
                    )
                ) {

                    requestHeaders[
                        "Content-Type"
                    ] =
                        "application/json";
                }
            }


            // =================================================
            // DEBUG LOGGING
            // =================================================

            console.log(
                "Final URL:",
                parsedUrl.href
            );

            console.log(
                "Headers:",
                requestHeaders
            );

            console.log(
                "Body:",
                finalBody
            );

            console.log(
                "Test Run ID:",
                testRunId
            );


            // =================================================
            // SEND REQUEST
            // =================================================

            let response;


            try {

                response =
                    await axios(
                        axiosConfig
                    );


            } catch (
                axiosError
            ) {

                const responseTime =
                    Date.now() -
                    startTime;


                console.error(
                    "❌ AXIOS ERROR:",
                    axiosError.message
                );


                // =================================================
                // AXIOS RESPONSE ERROR
                // =================================================

                if (
                    axiosError.response
                ) {

                    const actual =
                        Number(
                            axiosError
                                .response
                                .status
                        );


                    // ---------------------------------------------
                    // VALIDATE RESPONSE
                    // ---------------------------------------------

                    const validation =
                        validateApiResponse({

                            response:
                                axiosError.response,

                            expectedStatus:
                                expected,

                            expectedContentType,

                            expectedBody,

                            validateResponse
                        });


                    const result =
                        validation.valid
                            ? "PASS"
                            : "FAIL";


                    // ---------------------------------------------
                    // SAVE RESULT
                    // ---------------------------------------------

                    await saveTestResult(

                        testCaseId,

                        actual,

                        result,

                        responseTime,

                        testRunId
                    );


                    // ---------------------------------------------
                    // RESPONSE
                    // ---------------------------------------------

                    return res.json({

                        success: true,

                        method:
                            cleanMethod,

                        url:
                            parsedUrl.href,

                        expectedStatus:
                            expected,

                        actualStatus:
                            actual,

                        responseTime:
                            responseTime,

                        result:
                            result,

                        testRunId:
                            testRunId,

                        pathParams:
                            pathParams,

                        queryParams:
                            queryParams,

                        requestBody:
                            finalBody,

                        responseHeaders:
                            axiosError
                                .response
                                .headers,

                        responseBody:
                            axiosError
                                .response
                                .data,

                        validation:
                            validation
                    });
                }


                // =================================================
                // NETWORK ERROR
                // =================================================

                return res.status(502).json({

                    success: false,

                    result:
                        "FAIL",

                    actualStatus:
                        "ERROR",

                    expectedStatus:
                        expected,

                    responseTime:
                        responseTime,

                    testRunId:
                        testRunId,

                    error:
                        getAxiosErrorMessage(
                            axiosError
                        ),

                    code:
                        axiosError.code ||
                        null
                });
            }


            // =================================================
            // RESPONSE TIME
            // =================================================

            const responseTime =
                Date.now() -
                startTime;


            // =================================================
            // ACTUAL STATUS
            // =================================================

            const actual =
                Number(
                    response.status
                );


            // =================================================
            // RESPONSE VALIDATION
            // =================================================

            const validation =
                validateApiResponse({

                    response,

                    expectedStatus:
                        expected,

                    expectedContentType,

                    expectedBody,

                    validateResponse
                });


            const result =
                validation.valid
                    ? "PASS"
                    : "FAIL";


            // =================================================
            // LOG RESULT
            // =================================================

            console.log(
                "Actual:",
                actual
            );

            console.log(
                "Response Time:",
                responseTime,
                "ms"
            );

            console.log(
                "Validation:",
                validation
            );

            console.log(
                "Result:",
                result
            );

            console.log(
                "Test Run ID:",
                testRunId
            );


            // =================================================
            // SAVE RESULT + REPORT
            // =================================================

            await saveTestResult(

                testCaseId,

                actual,

                result,

                responseTime,

                testRunId
            );


            // =================================================
            // RESPONSE
            // =================================================

            res.json({

                success: true,

                method:
                    cleanMethod,

                url:
                    parsedUrl.href,

                expectedStatus:
                    expected,

                actualStatus:
                    actual,

                responseTime:
                    responseTime,

                result:
                    result,

                testRunId:
                    testRunId,

                pathParams:
                    pathParams,

                queryParams:
                    queryParams,

                requestBody:
                    finalBody,

                responseHeaders:
                    response.headers,

                responseBody:
                    response.data,

                validation:
                    validation
            });


            console.log(
                "===================================="
            );


        } catch (
            error
        ) {

            const responseTime =
                Date.now() -
                startTime;


            console.error(
                "❌ TEST ERROR:",
                error
            );


            res.status(500).json({

                success: false,

                result:
                    "FAIL",

                actualStatus:
                    "ERROR",

                expectedStatus:
                    Number(
                        req.body.expectedStatus
                    ) || 200,

                responseTime:
                    responseTime,

                testRunId:
                    req.body.testRunId ||
                    null,

                error:
                    "Unable to execute API test",

                details:
                    error.message,

                code:
                    error.code ||
                    null
            });
        }
    }
);


// =====================================================
// SAVE TEST RESULT + REPORT
// =====================================================

function saveTestResult(

    testCaseId,

    actualStatus,

    result,

    responseTime,

    testRunId

) {

    return new Promise(
        (resolve) => {


            // =================================================
            // TEST CASE ID CHECK
            // =================================================

            if (!testCaseId) {

                console.log(
                    "⚠️ No testCaseId supplied. Result not saved."
                );

                return resolve();
            }


            // =================================================
            // TEST RUN ID CHECK
            // =================================================

            if (!testRunId) {

                console.log(
                    "⚠️ No testRunId supplied."
                );
            }


            // =================================================
            // GET TEST CASE DATA
            // =================================================

            const getSQL = `

                SELECT

                    tc.TEST_NAME AS test_name,

                    tc.EXPECTED_STATUS AS expected_status,

                    a.METHOD AS method,

                    a.ENDPOINTS AS endpoint

                FROM test_cases tc

                LEFT JOIN apis a

                    ON tc.AIP_ID = a.ID

                WHERE tc.id = ?

            `;


            db.query(

                getSQL,

                [
                    testCaseId
                ],

                (getError, rows) => {


                    // =================================================
                    // TEST CASE FETCH ERROR
                    // =================================================

                    if (getError) {

                        console.error(

                            "❌ TEST CASE FETCH ERROR:",

                            getError.message

                        );

                        return resolve();
                    }


                    // =================================================
                    // TEST CASE NOT FOUND
                    // =================================================

                    if (
                        rows.length === 0
                    ) {

                        console.log(
                            "⚠️ Test case not found."
                        );

                        return resolve();
                    }


                    const testCase =
                        rows[0];


                    // =================================================
                    // SAVE TEST RESULT
                    //
                    // test_run_id is stored here too (not just on
                    // test_reports) so /api/history and future
                    // dashboard filters can also scope by run.
                    // =================================================

                    const resultSQL = `

                        INSERT INTO test_results

                        (
                            test_case_id,

                            actual_status,

                            result,

                            response_time,

                            test_run_id

                        )

                        VALUES (?, ?, ?, ?, ?)

                    `;


                    db.query(

                        resultSQL,

                        [

                            testCaseId,

                            normaliseStatusForDB(
                                actualStatus
                            ),

                            result,

                            responseTime,

                            testRunId ||
                            null

                        ],

                        (resultError) => {


                            if (
                                resultError
                            ) {

                                console.error(

                                    "❌ RESULT SAVE ERROR:",

                                    resultError.message

                                );

                            } else {

                                console.log(
                                    "✅ Test result saved to MySQL"
                                );
                            }


                            // =================================================
                            // SAVE TEST REPORT
                            // =================================================

                            const reportSQL = `

                                INSERT INTO test_reports

                                (

                                    test_case_id,

                                    test_name,

                                    method,

                                    endpoint,

                                    expected_status,

                                    actual_status,

                                    result,

                                    response_time,

                                    test_run_id,

                                    created_at

                                )

                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)

                            `;


                            db.query(

                                reportSQL,

                                [

                                    testCaseId,

                                    testCase.test_name,

                                    testCase.method,

                                    testCase.endpoint,

                                    testCase.expected_status,

                                    normaliseStatusForDB(
                                        actualStatus
                                    ),

                                    result,

                                    responseTime,

                                    testRunId

                                ],

                                (reportError) => {


                                    if (
                                        reportError
                                    ) {

                                        console.error(

                                            "❌ REPORT SAVE ERROR:",

                                            reportError.message

                                        );

                                    } else {

                                        console.log(

                                            "✅ Test report saved",

                                            "| Run ID:",

                                            testRunId

                                        );
                                    }


                                    resolve();
                                }
                            );
                        }
                    );
                }
            );
        }
    );
}
// =====================================================
// TEST HISTORY
// =====================================================
//
// Supports optional ?testRunId=... filter, mirroring
// /api/apis and /api/report, now that test_results also
// carries test_run_id.
// =====================================================

app.get(
    "/api/history",
    (req, res) => {

        const { testRunId } = req.query;

        let sql = `
            SELECT
                tr.id,
                tr.test_case_id,
                tr.test_run_id,
                tc.TEST_NAME AS test_name,
                a.NAME AS api_name,
                a.METHOD AS method,
                a.ENDPOINTS AS endpoint,
                tc.EXPECTED_STATUS AS expected_status,
                tr.actual_status,
                tr.result,
                tr.response_time,
                tr.created_at
            FROM test_results tr
            LEFT JOIN test_cases tc
                ON tr.test_case_id = tc.id
            LEFT JOIN apis a
                ON tc.AIP_ID = a.ID
        `;

        const params = [];

        if (testRunId) {
            sql += ` WHERE tr.test_run_id = ? `;
            params.push(testRunId);
        }

        sql += ` ORDER BY tr.id DESC `;

        db.query(
            sql,
            params,
            (err, results) => {

                if (err) {

                    console.error(
                        "HISTORY FETCH ERROR:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to fetch test history",
                        details:
                            err.message
                    });
                }

                res.json({
                    success: true,
                    history:
                        results
                });
            }
        );
    }
);

// =====================================================
// DELETE ONE HISTORY RECORD
// =====================================================

app.delete(
    "/api/history/:id",
    (req, res) => {

        const historyId =
            req.params.id;

        if (!historyId) {
            return res.status(400).json({
                success: false,
                error:
                    "History ID is required"
            });
        }

        const sql = `
            DELETE FROM test_results
            WHERE id = ?
        `;

        db.query(
            sql,
            [historyId],
            (err, result) => {

                if (err) {

                    console.error(
                        "DELETE HISTORY ERROR:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to delete history",
                        details:
                            err.message
                    });
                }

                if (
                    result.affectedRows === 0
                ) {

                    return res.status(404).json({
                        success: false,
                        error:
                            "History record not found"
                    });
                }

                res.json({
                    success: true,
                    message:
                        "History record deleted successfully",
                    deleted:
                        result.affectedRows
                });
            }
        );
    }
);

// =====================================================
// DELETE ALL HISTORY
// =====================================================

app.delete(
    "/api/history",
    (req, res) => {

        const sql = `
            DELETE FROM test_results
        `;

        db.query(
            sql,
            (err, result) => {

                if (err) {

                    console.error(
                        "DELETE ALL HISTORY ERROR:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to delete history",
                        details:
                            err.message
                    });
                }

                res.json({
                    success: true,
                    message:
                        "All history deleted successfully",
                    deleted:
                        result.affectedRows
                });
            }
        );
    }
);

// =====================================================
// GET CURRENT TEST REPORT
// =====================================================

app.get(
    "/api/report",
    (req, res) => {

        const testRunId =
            Number(req.query.testRunId);

        console.log(
            "📊 REPORT REQUEST - Test Run ID:",
            testRunId
        );

        if (!testRunId) {

            return res.status(400).json({

                success: false,

                error:
                    "testRunId is required"
            });
        }

        const sql = `
            SELECT
                id,
                test_case_id,
                test_name,
                method,
                endpoint,
                expected_status,
                actual_status,
                result,
                response_time,
                created_at,
                test_run_id
            FROM test_reports
            WHERE test_case_id IS NOT NULL
              AND test_run_id = ?
            ORDER BY id ASC
        `;

        db.query(
            sql,
            [testRunId],
            (err, results) => {

                if (err) {

                    console.error(
                        "❌ REPORT ERROR:",
                        err.message
                    );

                    return res.status(500).json({

                        success: false,

                        error:
                            "Failed to generate test report",

                        details:
                            err.message
                    });
                }

                // =================================================
                // SUMMARY
                // =================================================

                const total =
                    results.length;

                const passed =
                    results.filter(
                        item =>
                            item.result === "PASS"
                    ).length;

                const failed =
                    results.filter(
                        item =>
                            item.result === "FAIL"
                    ).length;

                const totalResponseTime =
                    results.reduce(
                        (sum, item) =>
                            sum +
                            Number(
                                item.response_time || 0
                            ),
                        0
                    );

                const averageResponseTime =
                    total === 0
                        ? 0
                        : Math.round(
                            totalResponseTime /
                            total
                        );

                const passRate =
                    total === 0
                        ? 0
                        : Math.round(
                            (
                                passed /
                                total
                            ) * 100
                        );

                // =================================================
                // RESPONSE
                // =================================================

                res.json({

                    success: true,

                    testRunId:
                        testRunId,

                    summary: {

                        total:
                            total,

                        passed:
                            passed,

                        failed:
                            failed,

                        passRate:
                            passRate,

                        averageResponseTime:
                            averageResponseTime
                    },

                    results:
                        results
                });
            }
        );
    }
);
// =====================================================
// DELETE REPORT
// =====================================================
// This is optional and useful if the UI has
// a "Clear Report" button.
// =====================================================

app.delete(
    "/api/report",
    (req, res) => {

        const sql = `
            DELETE FROM test_reports
        `;

        db.query(
            sql,
            (err, result) => {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        error:
                            "Failed to clear report",
                        details:
                            err.message
                    });
                }

                res.json({
                    success: true,
                    message:
                        "Report cleared successfully",
                    deleted:
                        result.affectedRows
                });
            }
        );
    }
);

// =====================================================
// HELPER FUNCTIONS
// =====================================================

// Generate unique Test Run ID
function generateTestRunId() {
    return Date.now();
}


// // Convert status to database-compatible value
// function normaliseStatusForDB(status) {

//     if (status === undefined || status === null) {
//         return null;
//     }

//     const numericStatus = Number(status);

//     if (!Number.isNaN(numericStatus)) {
//         return numericStatus;
//     }

//     return status;
// }

// =====================================================
// PARSE OPENAPI / SWAGGER
// =====================================================

function parseSpecification(
    fileData,
    filename
) {

    const lower =
        String(filename)
            .toLowerCase();

    if (
        lower.endsWith(".yaml") ||
        lower.endsWith(".yml")
    ) {

        return yaml.load(
            fileData
        );
    }

    if (
        lower.endsWith(".json")
    ) {

        return JSON.parse(
            fileData
        );
    }

    throw new Error(
        "Only JSON, YAML and YML files are supported"
    );
}

// =====================================================
// GET SERVER URL
// =====================================================

function getServerUrl(
    apiSpec
) {

    if (
        apiSpec?.servers &&
        Array.isArray(
            apiSpec.servers
        ) &&
        apiSpec.servers.length > 0
    ) {

        let server =
            apiSpec.servers[0];

        if (
            server &&
            server.url
        ) {

            let url =
                server.url;

            // Resolve simple server variables.
            if (
                server.variables
            ) {

                for (
                    const key
                    of Object.keys(
                        server.variables
                    )
                ) {

                    const variable =
                        server.variables[key];

                    const value =
                        variable.default ??
                        (
                            Array.isArray(
                                variable.enum
                            )
                                ? variable.enum[0]
                                : ""
                        );

                    url =
                        url.replace(
                            `{${key}}`,
                            String(value)
                        );
                }
            }

            return url;
        }
    }

    // Swagger 2.0

    if (
        apiSpec?.host
    ) {

        const scheme =
            apiSpec.schemes &&
            apiSpec.schemes.length > 0
                ? apiSpec.schemes[0]
                : "http";

        const basePath =
            apiSpec.basePath ||
            "";

        return (
            `${scheme}://${apiSpec.host}` +
            basePath
        );
    }

    return "";
}

// =====================================================
// EXTRACT ENDPOINTS
// =====================================================

function extractEndpoints(
    apiSpec
) {

    const endpoints = [];

    const allowedMethods = [
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace"
    ];

    const serverUrl =
        getServerUrl(
            apiSpec
        );

    for (
        const endpoint
        in apiSpec.paths
    ) {

        const pathItem =
            apiSpec.paths[endpoint];

        if (
            !pathItem ||
            typeof pathItem !== "object"
        ) {
            continue;
        }

        for (
            const method
            in pathItem
        ) {

            const lowerMethod =
                method.toLowerCase();

            if (
                !allowedMethods.includes(
                    lowerMethod
                )
            ) {
                continue;
            }

            let operation =
                pathItem[method];

            if (
                !operation ||
                typeof operation !== "object"
            ) {
                continue;
            }

            const responses =
                operation.responses ||
                {};

            const responseCodes =
                Object.keys(
                    responses
                );

            const expectedStatus =
                getPreferredExpectedStatus(
                    responses
                );

            let fullUrl =
                "";

            if (
                serverUrl
            ) {

                fullUrl =
                    serverUrl.replace(
                        /\/$/,
                        ""
                    ) +
                    (
                        endpoint.startsWith("/")
                            ? endpoint
                            : "/" + endpoint
                    );
            }

            console.log(
    "🔍 PARAMETERS FOR",
    endpoint,
    method,
    getParameters(
        apiSpec,
        endpoint,
        operation
    )
);

            endpoints.push({

                method:
                    lowerMethod.toUpperCase(),

                path:
                    endpoint,

                expectedStatus:
                    expectedStatus,

                url:
                    fullUrl,

                parameters:
                    getParameters(
                        apiSpec,
                        endpoint,
                        operation
                    ),

                requestBody:
                    getRequestBody(
                        operation,
                        apiSpec
                    ),

                responses:
                    responseCodes,

                security:
                    getSecurityInfo(
                        apiSpec,
                        operation
                    )
            });
        }
    }

    return endpoints;
}

// =====================================================
// GET PARAMETERS
// =====================================================

function getParameters(
    apiSpec,
    endpoint,
    operation
) {

    if (
        !operation
    ) {
        return [];
    }

    const pathItem =
        apiSpec?.paths?.[
            endpoint
        ] || {};

    const pathParameters =
        Array.isArray(
            pathItem.parameters
        )
            ? pathItem.parameters
            : [];

    const operationParameters =
        Array.isArray(
            operation.parameters
        )
            ? operation.parameters
            : [];

    const allParameters = [
        ...pathParameters,
        ...operationParameters
    ];

    const unique =
        new Map();

    for (
        const parameter
        of allParameters
    ) {

        if (
            !parameter ||
            !parameter.name
        ) {
            continue;
        }

        const key =
            `${parameter.in}:${parameter.name}`;

        unique.set(
            key,
            parameter
        );
    }

    return Array.from(
        unique.values()
    ).map(
        parameter => {

            const schema =
                parameter.schema ||
                parameter;

            let example;

            if (
                parameter.example !==
                undefined
            ) {

                example =
                    parameter.example;

            } else if (
                parameter.examples
            ) {

                example =
                    getFirstExample(
                        parameter.examples
                    );

            } else if (
                schema.example !==
                undefined
            ) {

                example =
                    schema.example;

            } else if (
                schema.default !==
                undefined
            ) {

                example =
                    schema.default;
            }

            const generatedValue =
                example !== undefined
                    ? example
                    : generateExampleValue(
                        schema
                    );

            return {

                name:
                    parameter.name,

                in:
                    parameter.in,

                required:
                    Boolean(
                        parameter.required
                    ),

                description:
                    parameter.description ||
                    "",

                schema:
                    schema,

                example:
                    example,

                generatedValue:
                    generatedValue
            };
        }
    );
}

// =====================================================
// GET REQUEST BODY
// =====================================================

function getRequestBody(
    operation,
    apiSpec
) {

    if (
        !operation ||
        !operation.requestBody
    ) {

        return null;
    }

    const requestBody =
        operation.requestBody;

    const content =
        requestBody.content ||
        {};

    const contentTypes =
        Object.keys(
            content
        );

    if (
        contentTypes.length === 0
    ) {
        return null;
    }

    const contentType =
        contentTypes[0];

    const media =
        content[
            contentType
        ];

    const schema =
        media?.schema ||
        {};

    let example =
        media?.example;

    if (
        example === undefined &&
        media?.examples
    ) {

        example =
            getFirstExample(
                media.examples
            );
    }

    if (
        example === undefined
    ) {

        example =
            generateSchemaExample(
                schema,
                apiSpec
            );
    }

    return {

        required:
            Boolean(
                requestBody.required
            ),

        contentType:
            contentType,

        schema:
            schema,

        example:
            example
    };
}

// =====================================================
// GET RESPONSE DEFINITIONS
// =====================================================

function getResponseDefinitions(
    operation
) {

    if (
        !operation ||
        !operation.responses
    ) {
        return [];
    }

    return Object.keys(
        operation.responses
    ).map(
        status => {

            const response =
                operation.responses[
                    status
                ];

            return {

                status:
                    status,

                description:
                    response?.description ||
                    "",

                contentTypes:
                    response?.content
                        ? Object.keys(
                            response.content
                        )
                        : [],

                schema:
                    response?.content
                        ? getFirstResponseSchema(
                            response.content
                        )
                        : null
            };
        }
    );
}

// =====================================================
// GET FIRST RESPONSE SCHEMA
// =====================================================

function getFirstResponseSchema(
    content
) {

    const contentTypes =
        Object.keys(
            content ||
            {}
        );

    if (
        contentTypes.length === 0
    ) {
        return null;
    }

    const media =
        content[
            contentTypes[0]
        ];

    return media?.schema ||
        null;
}

// =====================================================
// GET FIRST EXAMPLE
// =====================================================

function getFirstExample(
    examples
) {

    if (
        !examples ||
        typeof examples !== "object"
    ) {
        return undefined;
    }

    const keys =
        Object.keys(
            examples
        );

    if (
        keys.length === 0
    ) {
        return undefined;
    }

    const first =
        examples[
            keys[0]
        ];

    if (
        first &&
        typeof first === "object" &&
        "value" in first
    ) {

        return first.value;
    }

    return first;
}

// =====================================================
// GENERATE EXAMPLE VALUE
// =====================================================

function generateExampleValue(
    schema
) {

    if (!schema) {
        return "test";
    }

    if (
        schema.example !==
        undefined
    ) {

        return schema.example;
    }

    if (
        schema.default !==
        undefined
    ) {

        return schema.default;
    }

    if (
        Array.isArray(
            schema.enum
        ) &&
        schema.enum.length > 0
    ) {

        return schema.enum[0];
    }

    switch (
        schema.type
    ) {

        case "integer":
            return 1;

        case "number":
            return 1;

        case "boolean":
            return true;

        case "array":
            return [
                generateExampleValue(
                    schema.items || {
                        type: "string"
                    }
                )
            ];

        case "string":

        default:

            if (
                schema.format ===
                "email"
            ) {

                return "test@example.com";
            }

            if (
                schema.format ===
                "uuid"
            ) {

                return "00000000-0000-0000-0000-000000000001";
            }

            if (
                schema.format ===
                "date"
            ) {

                return "2026-01-01";
            }

            if (
                schema.format ===
                "date-time"
            ) {

                return new Date()
                    .toISOString();
            }

            return "test";
    }
}

// =====================================================
// GENERATE BODY FROM SCHEMA
// =====================================================

function generateSchemaExample(
    schema,
    apiSpec
) {

    if (!schema) {
        return {};
    }

    if (
        schema.example !==
        undefined
    ) {

        return schema.example;
    }

    if (
        schema.default !==
        undefined
    ) {

        return schema.default;
    }

    if (
        Array.isArray(
            schema.enum
        ) &&
        schema.enum.length > 0
    ) {

        return schema.enum[0];
    }

    if (
        schema.$ref
    ) {

        const resolved =
            resolveSchemaReference(
                schema.$ref,
                apiSpec
            );

        if (
            resolved
        ) {

            return generateSchemaExample(
                resolved,
                apiSpec
            );
        }

        return {};
    }

    if (
        schema.allOf
    ) {

        const merged = {};

        for (
            const item
            of schema.allOf
        ) {

            const generated =
                generateSchemaExample(
                    item,
                    apiSpec
                );

            if (
                generated &&
                typeof generated === "object" &&
                !Array.isArray(generated)
            ) {

                Object.assign(
                    merged,
                    generated
                );
            }
        }

        return merged;
    }

    if (
        schema.type === "object" ||
        schema.properties
    ) {

        const result = {};

        const properties =
            schema.properties ||
            {};

        for (
            const key
            in properties
        ) {

            result[key] =
                generateSchemaExample(
                    properties[key],
                    apiSpec
                );
        }

        return result;
    }

    if (
        schema.type === "array"
    ) {

        return [
            generateSchemaExample(
                schema.items || {
                    type: "string"
                },
                apiSpec
            )
        ];
    }

    return generateExampleValue(
        schema
    );
}

// =====================================================
// RESOLVE $REF
// =====================================================

function resolveSchemaReference(
    reference,
    apiSpec
) {

    if (
        !reference ||
        !apiSpec
    ) {
        return null;
    }

    if (
        !reference.startsWith("#/")
    ) {
        return null;
    }

    const parts =
        reference
            .substring(2)
            .split("/");

    let current =
        apiSpec;

    for (
        const part
        of parts
    ) {

        const decoded =
            part.replace(
                /~1/g,
                "/"
            ).replace(
                /~0/g,
                "~"
            );

        if (
            current ===
            undefined ||
            current === null
        ) {
            return null;
        }

        current =
            current[
                decoded
            ];
    }

    return current ||
        null;
}

// =====================================================
// NORMALISE OBJECT
// =====================================================

function normaliseObject(
    value
) {

    if (
        !value
    ) {
        return {};
    }

    if (
        typeof value ===
        "string"
    ) {

        try {

            const parsed =
                JSON.parse(
                    value
                );

            if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
            ) {

                return parsed;
            }

        } catch {

            return {};
        }
    }

    if (
        typeof value === "object" &&
        !Array.isArray(value)
    ) {

        return value;
    }

    return {};
}

// =====================================================
// PARSE STORED JSON
// =====================================================

function parseStoredJSON(
    value
) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {

        return {};
    }

    if (
        typeof value === "object"
    ) {

        return value;
    }

    try {

        return JSON.parse(
            value
        );

    } catch {

        return {};
    }
}

// =====================================================
// ESCAPE REGEX
// =====================================================

function escapeRegExp(
    value
) {

    return String(
        value
    ).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}

// =====================================================
// GET TEST CASE
// =====================================================

function getTestCase(
    testCaseId
) {

    return new Promise(
        (resolve, reject) => {

            const sql = `
                SELECT
                    id,
                    AIP_ID,
                    TEST_NAME,
                    EXPECTED_STATUS,
                    PATH_PARAMS AS path_params,
                    QUERY_PARAMS AS query_params,
                    REQUEST_BODY AS request_body,
                    CREATEED_AT AS created_at
                FROM test_cases
                WHERE id = ?
            `;

            db.query(
                sql,
                [testCaseId],
                (err, results) => {

                    if (err) {

                        console.error(
                            "GET TEST CASE ERROR:",
                            err.message
                        );

                        return reject(
                            err
                        );
                    }

                    resolve(
                        results.length > 0
                            ? results[0]
                            : null
                    );
                }
            );
        }
    );
}

// =====================================================
// GET API BY ID
// =====================================================

function getApiById(
    apiId
) {

    return new Promise(
        (resolve, reject) => {

            const sql = `
                SELECT
                    ID AS id,
                    NAME AS name,
                    METHOD AS method,
                    ENDPOINTS AS endpoint
                FROM apis
                WHERE ID = ?
            `;

            db.query(
                sql,
                [apiId],
                (err, results) => {

                    if (err) {
                        return reject(
                            err
                        );
                    }

                    resolve(
                        results.length > 0
                            ? results[0]
                            : null
                    );
                }
            );
        }
    );
}

// =====================================================
// IMPORT ENDPOINTS
// =====================================================
//
// Tags each newly inserted `apis` row with TEST_RUN_ID.
// Existing rows that match an already-imported
// METHOD + ENDPOINTS pair are re-tagged with the current
// testRunId too, so they still show up when the frontend
// filters /api/apis?testRunId=... by the latest run,
// instead of only ever carrying the run id from the very
// first time they were imported.
// =====================================================

async function importEndpoints(
    endpoints,
    testRunId
) {

    let imported = 0;
    let duplicates = 0;

    for (
        const api
        of endpoints
    ) {

        const existing =
            await queryAsync(
                `
                    SELECT ID
                    FROM apis
                    WHERE METHOD = ?
                    AND ENDPOINTS = ?
                `,
                [
                    api.method,
                    api.path
                ]
            );

        if (
            existing.length > 0
        ) {

            duplicates++;

            await queryAsync(
                `
                    UPDATE apis
                    SET TEST_RUN_ID = ?
                    WHERE ID = ?
                `,
                [
                    testRunId,
                    existing[0].ID
                ]
            );

            continue;
        }

        await queryAsync(
            `
                INSERT INTO apis
                (NAME, METHOD, ENDPOINTS, TEST_RUN_ID)
                VALUES (?, ?, ?, ?)
            `,
            [
                `${api.method} ${api.path}`,
                api.method,
                api.path,
                testRunId
            ]
        );

        imported++;
    }

    return {
        imported,
        duplicates
    };
}

// =====================================================
// QUERY ASYNC
// =====================================================

function queryAsync(
    sql,
    values = []
) {

    return new Promise(
        (resolve, reject) => {

            db.query(
                sql,
                values,
                (err, results) => {

                    if (err) {
                        reject(
                            err
                        );
                    } else {
                        resolve(
                            results
                        );
                    }
                }
            );
        }
    );
}

// =====================================================
// CREATE TEST CASE IF NEEDED
// =====================================================

async function createTestCaseIfNeeded({
    apiId,
    testName,
    expectedStatus,
    pathParams,
    queryParams,
    requestBody
}) {

    const existing =
        await queryAsync(
            `
                SELECT id
                FROM test_cases
                WHERE AIP_ID = ?
                AND TEST_NAME = ?
                AND EXPECTED_STATUS = ?
            `,
            [
                apiId,
                testName,
                expectedStatus
            ]
        );

    if (
        existing.length > 0
    ) {

        return existing[0].id;
    }

    const result =
        await queryAsync(
            `
                INSERT INTO test_cases
                (
                    AIP_ID,
                    TEST_NAME,
                    EXPECTED_STATUS,
                    PATH_PARAMS,
                    QUERY_PARAMS,
                    REQUEST_BODY
                )
                VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
                apiId,
                testName,
                expectedStatus,
                JSON.stringify(
                    pathParams || {}
                ),
                JSON.stringify(
                    queryParams || {}
                ),
                requestBody === null ||
                requestBody === undefined
                    ? null
                    : typeof requestBody ===
                        "string"
                        ? requestBody
                        : JSON.stringify(
                            requestBody
                        )
            ]
        );

    return result.insertId;
}

// =====================================================
// PREFERRED EXPECTED STATUS
// =====================================================

function getPreferredExpectedStatus(
    responses
) {

    if (
        !responses ||
        typeof responses !== "object"
    ) {
        return 200;
    }

    if (
        responses["200"]
    ) {
        return 200;
    }

    const numeric =
        Object.keys(
            responses
        ).find(
            code =>
                /^\d{3}$/.test(
                    code
                ) &&
                Number(code) >= 200 &&
                Number(code) < 300
        );

    if (
        numeric
    ) {
        return Number(
            numeric
        );
    }

    return 200;
}

// =====================================================
// NEGATIVE EXPECTED STATUS
// =====================================================

function getNegativeExpectedStatus(
    responses,
    method
) {

    if (
        !responses ||
        typeof responses !== "object"
    ) {
        return 400;
    }

    const preferred = [
        "400",
        "401",
        "403",
        "404",
        "422"
    ];

    for (
        const status
        of preferred
    ) {

        if (
            responses[status]
        ) {
            return Number(
                status
            );
        }
    }

    // DELETE/GET APIs commonly expose 404.
    if (
        method === "GET" ||
        method === "DELETE"
    ) {

        return 404;
    }

    return 400;
}

// =====================================================
// CREATE NEGATIVE PATH PARAMS
// =====================================================

function createNegativePathParams(
    parameters
) {

    const result = {};

    for (
        const parameter
        of parameters
    ) {

        if (
            parameter.in === "path"
        ) {

            switch (
                parameter.schema?.type
            ) {

                case "integer":
                case "number":

                    result[
                        parameter.name
                    ] =
                        -999999;

                    break;

                case "boolean":

                    result[
                        parameter.name
                    ] =
                        "invalid";

                    break;

                default:

                    result[
                        parameter.name
                    ] =
                        "invalid-value";
            }
        }
    }

    return result;
}

// =====================================================
// CREATE NEGATIVE QUERY PARAMS
// =====================================================

function createNegativeQueryParams(
    parameters
) {

    const result = {};

    for (
        const parameter
        of parameters
    ) {

        if (
            parameter.in === "query"
        ) {

            if (
                parameter.required
            ) {

                result[
                    parameter.name
                ] =
                    "invalid-value";
            }
        }
    }

    return result;
}

// =====================================================
// SECURITY INFORMATION
// =====================================================

function getSecurityInfo(
    apiSpec,
    operation
) {

    const security =
        operation?.security ??
        apiSpec?.security ??
        [];

    const schemes =
        apiSpec?.components?.securitySchemes ||
        apiSpec?.securityDefinitions ||
        {};

    const result = [];

    for (
        const requirement
        of security
    ) {

        if (
            !requirement ||
            typeof requirement !==
            "object"
        ) {
            continue;
        }

        for (
            const name
            of Object.keys(
                requirement
            )
        ) {

            const scheme =
                schemes[name];

            if (!scheme) {
                continue;
            }

            result.push({
                name:
                    name,

                type:
                    scheme.type ||
                    null,

                scheme:
                    scheme.scheme ||
                    null,

                bearerFormat:
                    scheme.bearerFormat ||
                    null,

                in:
                    scheme.in ||
                    null,

                parameterName:
                    scheme.name ||
                    null,

                scopes:
                    requirement[name] ||
                    []
            });
        }
    }

    return result;
}

// =====================================================
// APPLY AUTHENTICATION
// =====================================================

function applyAuthentication(
    headers,
    auth
) {

    if (
        !auth ||
        typeof auth !== "object"
    ) {
        return;
    }

    const type =
        String(
            auth.type || ""
        ).toLowerCase();

    if (
        type === "bearer"
    ) {

        if (
            auth.token
        ) {

            headers.Authorization =
                `Bearer ${auth.token}`;
        }

        return;
    }

    if (
        type === "apikey" ||
        type === "api-key"
    ) {

        if (
            auth.key &&
            auth.value
        ) {

            if (
                String(
                    auth.in || "header"
                ).toLowerCase() ===
                "query"
            ) {

                // Query API-key authentication
                // is handled separately below
                // when auth.queryParams is supplied.

            } else {

                headers[
                    auth.key
                ] =
                    String(
                        auth.value
                    );
            }
        }

        return;
    }

    if (
        type === "basic"
    ) {

        if (
            auth.username !==
            undefined &&
            auth.password !==
            undefined
        ) {

            const encoded =
                Buffer
                    .from(
                        `${auth.username}:${auth.password}`
                    )
                    .toString(
                        "base64"
                    );

            headers.Authorization =
                `Basic ${encoded}`;
        }
    }
}

// =====================================================
// HEADER CHECK
// =====================================================

function hasHeader(
    headers,
    headerName
) {

    const wanted =
        String(
            headerName
        ).toLowerCase();

    return Object.keys(
        headers || {}
    ).some(
        key =>
            key.toLowerCase() ===
            wanted
    );
}

// =====================================================
// RESPONSE VALIDATION
// =====================================================

function validateApiResponse({
    response,
    expectedStatus,
    expectedContentType,
    expectedBody,
    validateResponse
}) {

    const checks = [];

    // -------------------------------------------------
    // STATUS
    // -------------------------------------------------

    const statusPass =
        Number(
            response.status
        ) ===
        Number(
            expectedStatus
        );

    checks.push({
        type:
            "status",
        expected:
            expectedStatus,
        actual:
            response.status,
        passed:
            statusPass
    });

    // -------------------------------------------------
    // CONTENT TYPE
    // -------------------------------------------------

    if (
        expectedContentType
    ) {

        const actualContentType =
            getContentType(
                response.headers
            );

        const contentTypePass =
            actualContentType
                .toLowerCase()
                .includes(
                    String(
                        expectedContentType
                    ).toLowerCase()
                );

        checks.push({
            type:
                "content-type",
            expected:
                expectedContentType,
            actual:
                actualContentType,
            passed:
                contentTypePass
        });
    }

    // -------------------------------------------------
    // EXPECTED BODY
    // -------------------------------------------------

    if (
        expectedBody !==
        undefined &&
        expectedBody !==
        null
    ) {

        const bodyPass =
            compareExpectedBody(
                response.data,
                expectedBody
            );

        checks.push({
            type:
                "response-body",
            expected:
                expectedBody,
            actual:
                response.data,
            passed:
                bodyPass
        });
    }

    // -------------------------------------------------
    // VALIDATE RESPONSE FLAG
    // -------------------------------------------------

    if (
        validateResponse ===
        false
    ) {

        // Explicitly disable
        // additional response checks.
        // Status is still checked.

        return {
            valid:
                statusPass,
            checks:
                checks
        };
    }

    const valid =
        checks.every(
            check =>
                check.passed
        );

    return {
        valid:
            valid,
        checks:
            checks
    };
}

// =====================================================
// CONTENT TYPE
// =====================================================

function getContentType(
    headers
) {

    if (!headers) {
        return "";
    }

    const key =
        Object.keys(
            headers
        ).find(
            item =>
                item.toLowerCase() ===
                "content-type"
        );

    return key
        ? String(
            headers[key]
        )
        : "";
}

// =====================================================
// COMPARE EXPECTED BODY
// =====================================================

function compareExpectedBody(
    actual,
    expected
) {

    if (
        typeof expected ===
        "string"
    ) {

        if (
            typeof actual ===
            "string"
        ) {

            return actual.includes(
                expected
            );
        }

        return JSON.stringify(
            actual
        ).includes(
            expected
        );
    }

    return deepContains(
        actual,
        expected
    );
}

// =====================================================
// DEEP CONTAINS
// =====================================================

function deepContains(
    actual,
    expected
) {

    if (
        expected === null ||
        expected === undefined
    ) {

        return actual ===
            expected;
    }

    if (
        typeof expected !==
        "object"
    ) {

        return actual ===
            expected;
    }

    if (
        Array.isArray(
            expected
        )
    ) {

        if (
            !Array.isArray(
                actual
            )
        ) {
            return false;
        }

        return expected.every(
            expectedItem =>
                actual.some(
                    actualItem =>
                        deepContains(
                            actualItem,
                            expectedItem
                        )
                )
        );
    }

    if (
        !actual ||
        typeof actual !==
        "object"
    ) {

        return false;
    }

    return Object.keys(
        expected
    ).every(
        key =>
            Object.prototype.hasOwnProperty.call(
                actual,
                key
            ) &&
            deepContains(
                actual[key],
                expected[key]
            )
    );
}

// =====================================================
// AXIOS ERROR MESSAGE
// =====================================================

function getAxiosErrorMessage(
    error
) {

    if (
        error.code ===
        "ECONNABORTED"
    ) {

        return "API request timed out";
    }

    if (
        error.code ===
        "ECONNREFUSED"
    ) {

        return "API server refused the connection";
    }

    if (
        error.code ===
        "ENOTFOUND"
    ) {

        return "API host could not be found";
    }

    if (
        error.code ===
        "ETIMEDOUT"
    ) {

        return "Connection timed out";
    }

    return (
        error.message ||
        "Unable to reach API server"
    );
}

// =====================================================
// NORMALISE STATUS FOR DATABASE
// =====================================================

function normaliseStatusForDB(
    status
) {

    const number =
        Number(
            status
        );

    if (
        Number.isInteger(
            number
        ) &&
        number >= 100 &&
        number <= 599
    ) {

        return number;
    }

    // Database actual_status is INT.
    // Use 0 when no HTTP status exists.
    return 0;
}

// =====================================================
// START SERVER
// =====================================================

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Server running on http://localhost:${PORT}`
        );

        console.log(
            "🧪 Automatic API Testing Platform backend ready"
        );
    }
);