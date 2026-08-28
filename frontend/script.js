let uploadedFilename = null;
let latestTestResults = [];

// =====================================================
// CURRENT TEST RUN
// =====================================================

let currentTestRunId = null;

function generateTestRunId() {
    return Date.now().toString();
}


// =====================================================
// CURRENT API ENDPOINTS
// =====================================================

let currentAPIEndpointKeys = new Set();


// =====================================================
// API SERVER URL
// =====================================================

let apiServerUrl = "https://jsonplaceholder.typicode.com";


// =====================================================
// PAGE LOAD
// =====================================================

document.addEventListener("DOMContentLoaded", async () => {

    console.log("🚀 Application loaded");

    // Do NOT load all imported APIs here.
    // There is no current upload yet.

    await Promise.all([
        loadTestHistory(),
        updateDashboardStats()
    ]);

    await loadReport();
});


// =====================================================
// CREATE ENDPOINT KEY
// =====================================================

function createEndpointKey(method, endpoint) {

    return (
        String(method || "")
            .trim()
            .toUpperCase() +
        ":" +
        String(endpoint || "")
            .trim()
    );
}


// =====================================================
// SET CURRENT API ENDPOINTS
// =====================================================

function setCurrentAPIEndpoints(endpoints) {

    currentAPIEndpointKeys = new Set();

    if (!Array.isArray(endpoints)) {
        return;
    }

    endpoints.forEach((api) => {

        const method = String(
            api.method || "GET"
        )
            .trim()
            .toUpperCase();

        const endpoint = String(
            api.path ||
            api.endpoint ||
            api.endpoints ||
            ""
        ).trim();

        if (endpoint) {

            currentAPIEndpointKeys.add(
                createEndpointKey(method, endpoint)
            );
        }
    });

    console.log(
        "📌 Current API endpoints:",
        Array.from(currentAPIEndpointKeys)
    );
}


// =====================================================
// UPLOAD API SPECIFICATION
// =====================================================

async function uploadAPI() {

    const fileInput =
        document.getElementById("apifile");

    const status =
        document.getElementById("uploadstatus");

    if (!fileInput) {

        console.error(
            "❌ apifile element not found"
        );

        return;
    }

    if (!status) {

        console.error(
            "❌ uploadstatus element not found"
        );

        return;
    }

    if (fileInput.files.length === 0) {

        status.textContent =
            "❌ Please select an API specification.";

        return;
    }

    const file = fileInput.files[0];

    // =================================================
    // CREATE NEW RUN ID
    // =================================================

    currentTestRunId =
        generateTestRunId();

    console.log(
        "🆕 NEW TEST RUN:",
        currentTestRunId
    );

    // =================================================
    // FORM DATA
    // =================================================

    const formData =
        new FormData();

    formData.append(
        "apiFile",
        file
    );

    // Send the SAME ID to backend
    formData.append(
        "testRunId",
        currentTestRunId
    );

    status.textContent =
        "⏳ Uploading API specification...";

    try {

        const response =
            await fetch("http://localhost:5000/api/upload", {
                method: "POST",
                body: formData
            });

        const data =
            await response.json();

        if (!response.ok) {

            status.textContent =
                "❌ Upload failed: " +
                (
                    data.error ||
                    "Unknown error"
                );

            return;
        }

        // =================================================
        // SAVE UPLOAD DATA
        // =================================================

        uploadedFilename =
            data.filename;

        if (data.serverUrl) {

            apiServerUrl =
                data.serverUrl;
        }

        // If backend returns a testRunId,
        // prefer backend value.
        if (data.testRunId) {

            currentTestRunId =
                String(data.testRunId);
        }

        console.log(
            "✅ Upload successful"
        );

        console.log(
            "📌 Active testRunId:",
            currentTestRunId
        );

        // =================================================
        // SUCCESS MESSAGE
        // =================================================

        status.textContent =
            "✅ Upload successful: " +
            data.filename;

        // =================================================
        // RESET OLD DATA
        // =================================================

        latestTestResults = [];

        resetTestCases();

        resetResults();

        // =================================================
        // DISPLAY CURRENT ENDPOINTS
        // =================================================

        setCurrentAPIEndpoints(
            data.endpoints || []
        );

        displayEndpoints(
            data.endpoints || []
        );

        // =================================================
        // IMPORTANT
        // LOAD ONLY APIs FROM CURRENT RUN
        // =================================================

        await loadImportedAPIs();

        await updateDashboardStats();

        await loadReport();

    } catch (error) {

        console.error(
            "❌ UPLOAD ERROR:",
            error
        );

        status.textContent =
            "❌ Unable to connect to backend.";

    }
}




// =====================================================
// BUILD API URL
// =====================================================

function buildAPIUrl(
    endpoint,
    parameters = []
) {

    let cleanEndpoint =
        String(
            endpoint || ""
        ).trim();

    const baseUrl =
        String(
            apiServerUrl || ""
        )
            .trim()
            .replace(/\/$/, "");

    // =================================================
    // START WITH /
    // =================================================

    if (
        !cleanEndpoint.startsWith("/")
    ) {
        cleanEndpoint =
            "/" + cleanEndpoint;
    }

    // =================================================
    // PATH PARAMETERS
    // =================================================

    const pathParameters =
        Array.isArray(parameters)
            ? parameters.filter(
                parameter =>
                    parameter &&
                    parameter.in === "path"
            )
            : [];

    cleanEndpoint =
        cleanEndpoint.replace(
            /\{([^}]+)\}/g,
            (
                match,
                parameterName
            ) => {

                const parameter =
                    pathParameters.find(
                        item =>
                            String(item.name) ===
                            String(parameterName)
                    );

                let value =
                    parameter?.generatedValue;

                if (
                    value === undefined ||
                    value === null ||
                    value === ""
                ) {
                    value =
                        parameter?.example;
                }

                if (
                    value === undefined ||
                    value === null ||
                    value === ""
                ) {
                    value = "1";
                }

                return encodeURIComponent(
                    String(value)
                );
            }
        );

    // =================================================
    // FINAL URL
    // =================================================

    let finalUrl =
        baseUrl +
        cleanEndpoint;

    // =================================================
    // QUERY PARAMETERS
    // =================================================

    const queryParameters =
        Array.isArray(parameters)
            ? parameters.filter(
                parameter =>
                    parameter &&
                    parameter.in === "query"
            )
            : [];

    const queryParams =
        new URLSearchParams();

    queryParameters.forEach(
        parameter => {

            let value =
                parameter.generatedValue;

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                value =
                    parameter.example;
            }

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                value =
                    parameter.default;
            }

            // Optional parameter with no value
            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {

                if (
                    parameter.required
                ) {
                    value = "test";
                } else {
                    return;
                }
            }

            // Array values
            if (
                Array.isArray(value)
            ) {

                value.forEach(
                    item => {

                        queryParams.append(
                            parameter.name,
                            String(item)
                        );
                    }
                );

                return;
            }

            queryParams.append(
                parameter.name,
                String(value)
            );
        }
    );

    const queryString =
        queryParams.toString();

    if (queryString) {

        finalUrl +=
            "?" +
            queryString;
    }

    console.log(
        "🌐 FINAL API URL:",
        finalUrl
    );

    return finalUrl;
}


// =====================================================
// DISPLAY ENDPOINTS
// =====================================================

// =====================================================
// DISPLAY ENDPOINTS
// =====================================================

function displayEndpoints(endpoints) {

    const endpointList =
        document.getElementById("endpointlist");

    if (!endpointList) {
        console.error("❌ Endpoint list not found");
        return;
    }

    endpointList.innerHTML = "";

    if (!Array.isArray(endpoints) || endpoints.length === 0) {
        endpointList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔌</div>
                <h3>No API endpoints found</h3>
                <p>Upload a valid OpenAPI or Swagger specification.</p>
            </div>
        `;

        updateDashboardStats();
        return;
    }

    endpoints.forEach((api) => {

        const endpoint =
            document.createElement("div");

        endpoint.className =
            "endpoint-card";

        const method =
            String(
                api.method || "GET"
            ).toUpperCase();

        const path =
            String(
                api.path ||
                api.endpoint ||
                ""
            );

        const expectedStatus =
            Number(
                api.expectedStatus || 200
            );

        // =================================================
        // PARAMETERS FROM BACKEND
        // =================================================

        const parameters =
            Array.isArray(api.parameters)
                ? api.parameters
                : [];

        const pathParameters =
            parameters.filter(
                parameter =>
                    parameter &&
                    parameter.in === "path"
            );

        const queryParameters =
            parameters.filter(
                parameter =>
                    parameter &&
                    parameter.in === "query"
            );

        // =================================================
        // BUILD FINAL URL
        // =================================================

        const finalUrl =
            buildAPIUrl(
                path,
                parameters
            );

        // =================================================
        // SAVE DATA
        // =================================================

        endpoint.dataset.method =
            method;

        endpoint.dataset.path =
            path;

        endpoint.dataset.endpoint =
            path;

        endpoint.dataset.expectedStatus =
            expectedStatus;

        endpoint.dataset.url =
            finalUrl;

        endpoint.dataset.parameters =
            JSON.stringify(parameters);

        // =================================================
        // METHOD
        // =================================================

        const methodElement =
            document.createElement("span");

        methodElement.className =
            "endpoint-method";

        methodElement.textContent =
            method;

        // =================================================
        // PATH
        // =================================================

        const pathElement =
            document.createElement("span");

        pathElement.className =
            "endpoint-path";

        pathElement.textContent =
            path;

        // =================================================
        // EXPECTED STATUS
        // =================================================

        const statusElement =
            document.createElement("span");

        statusElement.className =
            "endpoint-status";

        statusElement.textContent =
            `Expected: ${expectedStatus}`;

        // =================================================
        // PARAMETERS CONTAINER
        // =================================================

        const parametersContainer =
            document.createElement("div");

        parametersContainer.className =
            "endpoint-parameters-container";

        // // =================================================
        // // PATH PARAMETERS
        // // =================================================

        // if (pathParameters.length > 0) {

        //     const pathBox =
        //         document.createElement("div");

        //     pathBox.className =
        //         "endpoint-parameters";

        //     pathBox.innerHTML = `
        //         <div class="parameter-title">
        //             🔵 Path Parameters
        //         </div>
        //     `;

        //     pathParameters.forEach(
        //         parameter => {

        //             const value =
        //                 parameter.generatedValue ??
        //                 parameter.example ??
        //                 "1";

        //             const item =
        //                 document.createElement("div");

        //             item.className =
        //                 "parameter-item";

        //             item.innerHTML = `
        //                 <span class="parameter-name">
        //                     ${escapeHTML(
        //                         String(parameter.name)
        //                     )}
        //                 </span>

        //                 <span class="parameter-value">
        //                     ${escapeHTML(
        //                         String(value)
        //                     )}
        //                 </span>

        //                 <span class="${
        //                     parameter.required
        //                         ? "parameter-required"
        //                         : "parameter-optional"
        //                 }">
        //                     ${
        //                         parameter.required
        //                             ? "Required"
        //                             : "Optional"
        //                     }
        //                 </span>
        //             `;

        //             pathBox.appendChild(item);
        //         }
        //     );

        //     parametersContainer.appendChild(
        //         pathBox
        //     );
        // }

        // // =================================================
        // // QUERY PARAMETERS
        // // =================================================

        // if (queryParameters.length > 0) {

        //     const queryBox =
        //         document.createElement("div");

        //     queryBox.className =
        //         "endpoint-parameters";

        //     queryBox.innerHTML = `
        //         <div class="parameter-title">
        //             🟢 Query Parameters
        //         </div>
        //     `;

        //     queryParameters.forEach(
        //         parameter => {

        //             const value =
        //                 parameter.generatedValue ??
        //                 parameter.example ??
        //                 parameter.default ??
        //                 "test";

        //             const item =
        //                 document.createElement("div");

        //             item.className =
        //                 "parameter-item";

        //             item.innerHTML = `
        //                 <span class="parameter-name">
        //                     ${escapeHTML(
        //                         String(parameter.name)
        //                     )}
        //                 </span>

        //                 <span class="parameter-value">
        //                     ${escapeHTML(
        //                         String(value)
        //                     )}
        //                 </span>

        //                 <span class="${
        //                     parameter.required
        //                         ? "parameter-required"
        //                         : "parameter-optional"
        //                 }">
        //                     ${
        //                         parameter.required
        //                             ? "Required"
        //                             : "Optional"
        //                     }
        //                 </span>
        //             `;

        //             queryBox.appendChild(item);
        //         }
        //     );

        //     parametersContainer.appendChild(
        //         queryBox
        //     );
        // }

        // // =================================================
        // // NO PARAMETERS
        // // =================================================

        // if (
        //     pathParameters.length === 0 &&
        //     queryParameters.length === 0
        // ) {

        //     parametersContainer.innerHTML = `
        //         <div class="endpoint-no-parameters">
        //             No path or query parameters
        //         </div>
        //     `;
        // }

        // =================================================
        // RUN BUTTON
        // =================================================

        const runButton =
            document.createElement("button");

        runButton.type =
            "button";

        runButton.className =
            "endpoint-run-btn";

        runButton.textContent =
            "🧪 Run Test";

        runButton.addEventListener(
            "click",
            () => {

                runIndividualEndpointTest(
                    endpoint
                );
            }
        );

        // =================================================
        // APPEND
        // =================================================

        endpoint.appendChild(
            methodElement
        );

        endpoint.appendChild(
            pathElement
        );

        endpoint.appendChild(
            statusElement
        );

        // endpoint.appendChild(
        //     parametersContainer
        // );

        endpoint.appendChild(
            runButton
        );

        endpointList.appendChild(
            endpoint
        );

        // =================================================
        // DEBUG
        // =================================================

        console.log(
            "🔗 ENDPOINT:",
            {
                method,
                path,
                parameters,
                finalUrl
            }
        );
    });

    updateDashboardStats();
}


// =====================================================
// GET CURRENT APIs
// =====================================================

async function getCurrentRunAPIs() {

    if (!currentTestRunId) {

        console.warn(
            "⚠️ No current testRunId"
        );

        return [];
    }

    const url =
        `http://localhost:5000/api/apis?testRunId=${encodeURIComponent(
            currentTestRunId
        )}`;

    console.log(
        "📡 Loading APIs:",
        url
    );

    const response =
        await fetch(
            url,
            {
                cache: "no-store"
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data.error ||
            "Unable to load APIs"
        );
    }

    return normalizeAPIsResponse(
        data
    );
}


// =====================================================
// INDIVIDUAL ENDPOINT TEST
// =====================================================

async function runIndividualEndpointTest(
    endpointCard
) {

    if (!endpointCard) {
        return;
    }

    const methodElement =
        endpointCard.querySelector(
            ".endpoint-method"
        );

    const endpointElement =
        endpointCard.querySelector(
            ".endpoint-path"
        );

    const runButton =
        endpointCard.querySelector(
            ".endpoint-run-btn"
        );

    if (
        !methodElement ||
        !endpointElement
    ) {

        console.error(
            "❌ Endpoint information not found."
        );

        return;
    }

    const method =
        methodElement.textContent
            .trim()
            .toUpperCase();

    const endpoint =
        endpointElement.textContent
            .trim();

    const expectedStatus =
        Number(
            endpointCard.dataset.expectedStatus ||
            200
        );

const parameters =
    endpointCard.dataset.parameters
        ? JSON.parse(
            endpointCard.dataset.parameters
        )
        : [];
        const pathParams =
    parameters
        .filter(
            parameter =>
                parameter.in === "path"
        )
        .reduce(
            (obj, parameter) => {

                let value =
                    parameter.generatedValue ??
                    parameter.example ??
                    "1";

                obj[parameter.name] =
                    value;

                return obj;
            },
            {}
        );

const queryParams =
    parameters
        .filter(
            parameter =>
                parameter.in === "query"
        )
        .reduce(
            (obj, parameter) => {

                let value =
                    parameter.generatedValue ??
                    parameter.example ??
                    parameter.default;

                if (
                    value !== undefined &&
                    value !== null &&
                    value !== ""
                ) {
                    obj[parameter.name] =
                        value;
                }

                return obj;
            },
            {}
        );

const url =
    buildAPIUrl(
        endpoint,
        parameters
    );

    // =================================================
    // ENSURE RUN ID
    // =================================================

    if (!currentTestRunId) {

        alert(
            "⚠️ Please upload an API specification first."
        );

        return;
    }

    const testRunId =
        currentTestRunId;

    if (runButton) {

        runButton.disabled =
            true;

        runButton.textContent =
            "⏳ Running...";
    }

    try {

        let testCaseId =
            endpointCard.dataset.testCaseId ||
            null;

        // =================================================
        // FIND TEST CASE FROM CURRENT RUN ONLY
        // =================================================

        if (!testCaseId) {

            const apis =
                await getCurrentRunAPIs();

            const matchingAPI =
                apis.find((api) => {

                    const dbMethod =
                        String(
                            api.method || ""
                        )
                            .trim()
                            .toUpperCase();

                    const dbEndpoint =
                        String(
                            api.endpoints ||
                            api.endpoint ||
                            api.path ||
                            ""
                        )
                            .trim();

                    return (
                        dbMethod === method &&
                        dbEndpoint === endpoint
                    );
                });

            if (!matchingAPI) {

                throw new Error(
                    `API not found for current upload: ${method} ${endpoint}`
                );
            }

            // =================================================
            // GENERATE TEST CASE
            // =================================================

            const testResponse =
                await fetch(
                    "http://localhost:5000/api/generate-tests",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body: JSON.stringify({
                            apiId:
                                matchingAPI.id,

                            testName:
                                `Verify ${method} ${endpoint}`,

                            expectedStatus:
                                expectedStatus,

                            testRunId:
                                testRunId
                        })
                    }
                );

            const testData =
                await testResponse.json();

            if (!testResponse.ok) {

                throw new Error(
                    testData.error ||
                    "Failed to generate test case"
                );
            }

            testCaseId =
                testData.testCaseId ||
                null;

            endpointCard.dataset.testCaseId =
                testCaseId || "";
        }

        // =================================================
        // RUN TEST
        // =================================================

        const response =
            await fetch(
                "http://localhost:5000/api/run-test",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({

                        method:
                            method,

                        url:
                            url,

                        expectedStatus:
                            expectedStatus,

                        testCaseId:
                            testCaseId,

                        testRunId:
                            testRunId
                    })
                }
            );

        const data =
            await response.json();

        console.log(
            "🧪 TEST RESULT:",
            {
                method,
                endpoint,
                testCaseId,
                testRunId,
                response: data
            }
        );

        const normalized =
            normalizeResult(
                data,
                {
                    method,
                    endpoint,
                    expectedStatus,
                    testCaseId,
                    url
                }
            );

        if (!response.ok) {

            normalized.result =
                "FAIL";
        }

        latestTestResults.push(
            normalized
        );

        const results =
            document.getElementById(
                "testresults"
            );

        if (results) {

            if (
                results.classList.contains(
                    "empty-state"
                )
            ) {

                results.className = "";

                results.innerHTML = "";
            }

            createResultCard(
                method,
                endpoint,
                normalized,
                normalized.finalUrl ||
                    url,
                testCaseId
            );
        }

        await loadReport();

        await loadTestHistory();

        await updateDashboardStats();

    } catch (error) {

        console.error(
            "❌ INDIVIDUAL TEST ERROR:",
            error
        );

        const failedData =
            normalizeResult(
                {
                    result: "FAIL",
                    actualStatus: "ERROR",
                    expectedStatus:
                        expectedStatus,
                    responseTime: 0,
                    error:
                        error.message
                },
                {
                    method,
                    endpoint,
                    expectedStatus,
                    testCaseId:
                        endpointCard.dataset.testCaseId ||
                        null,
                    url
                }
            );

        latestTestResults.push(
            failedData
        );

        const results =
            document.getElementById(
                "testresults"
            );

        if (results) {

            if (
                results.classList.contains(
                    "empty-state"
                )
            ) {

                results.className = "";

                results.innerHTML = "";
            }

            createResultCard(
                method,
                endpoint,
                failedData,
                url,
                endpointCard.dataset.testCaseId ||
                    ""
            );
        }

    } finally {

        if (runButton) {

            runButton.disabled =
                false;

            runButton.textContent =
                "🧪 Run Test";
        }
    }
}


// =====================================================
// NORMALIZE APIs RESPONSE
// =====================================================

function normalizeAPIsResponse(data) {

    if (Array.isArray(data)) {

        return data;
    }

    if (
        data &&
        Array.isArray(data.apis)
    ) {

        return data.apis;
    }

    if (
        data &&
        Array.isArray(data.data)
    ) {

        return data.data;
    }

    if (
        data &&
        Array.isArray(data.results)
    ) {

        return data.results;
    }

    console.warn(
        "⚠️ APIs response is not an array:",
        data
    );

    return [];
}


// =====================================================
// GENERATE TEST CASES
// =====================================================

async function generateTestCases() {

    const endpointList =
        document.getElementById(
            "endpointlist"
        );

    const testCases =
        document.getElementById(
            "testcases"
        );

    if (
        !endpointList ||
        !testCases
    ) {

        console.error(
            "❌ Test case HTML elements not found"
        );

        return;
    }

    if (!currentTestRunId) {

        alert(
            "⚠️ Please upload an API specification first."
        );

        return;
    }

    const endpoints =
        endpointList.querySelectorAll(
            ".endpoint-card"
        );

    testCases.innerHTML = "";

    if (endpoints.length === 0) {

        testCases.className =
            "empty-state";

        testCases.innerHTML = `
            <div class="empty-icon">🧪</div>
            <h3>No test cases generated</h3>
            <p>Upload an API specification first.</p>
        `;

        return;
    }

    testCases.className = "";

    testCases.innerHTML =
        `<div class="loading">
            ⏳ Generating test cases...
        </div>`;

    try {

        // =================================================
        // ONLY CURRENT RUN APIs
        // =================================================

        const apis =
            await getCurrentRunAPIs();

        testCases.innerHTML = "";

        let generatedCount = 0;

        for (
            let index = 0;
            index < endpoints.length;
            index++
        ) {

            const endpointCard =
                endpoints[index];

            const methodElement =
                endpointCard.querySelector(
                    ".endpoint-method"
                );

            const pathElement =
                endpointCard.querySelector(
                    ".endpoint-path"
                );

            if (
                !methodElement ||
                !pathElement
            ) {
                continue;
            }

            const method =
                methodElement.textContent
                    .trim()
                    .toUpperCase();

            const path =
                pathElement.textContent
                    .trim();

            const expectedStatus =
                Number(
                    endpointCard.dataset.expectedStatus ||
                    200
                );

            const matchingAPI =
                apis.find((api) => {

                    const dbMethod =
                        String(
                            api.method || ""
                        )
                            .trim()
                            .toUpperCase();

                    const dbEndpoint =
                        String(
                            api.endpoints ||
                            api.endpoint ||
                            api.path ||
                            ""
                        )
                            .trim();

                    return (
                        dbMethod === method &&
                        dbEndpoint === path
                    );
                });

            if (!matchingAPI) {

                console.warn(
                    "⚠️ API not found:",
                    method,
                    path
                );

                continue;
            }

            // =================================================
            // CREATE TEST CASE
            // =================================================

            const testResponse =
                await fetch(
                    "http://localhost:5000/api/generate-tests",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({

                            apiId:
                                matchingAPI.id,

                            testName:
                                `Verify ${method} ${path}`,

                            expectedStatus:
                                expectedStatus,

                            testRunId:
                                currentTestRunId
                        })
                    }
                );

            const testData =
                await testResponse.json();

            if (!testResponse.ok) {

                console.error(
                    "❌ TEST CASE ERROR:",
                    testData
                );

                continue;
            }

            const testCaseId =
                testData.testCaseId;

            endpointCard.dataset.testCaseId =
                testCaseId;

            const url =
                endpointCard.dataset.url ||
                buildAPIUrl(path);

            const testCase =
                document.createElement(
                    "div"
                );

            testCase.className =
                "test-case";

            testCase.dataset.method =
                method;

            testCase.dataset.endpoint =
                path;

            testCase.dataset.expectedStatus =
                expectedStatus;

            testCase.dataset.url =
                url;

            testCase.dataset.testCaseId =
                testCaseId;

            testCase.innerHTML = `
                <strong>Test ${index + 1}</strong>

                <p>
                    Verify
                    ${escapeHTML(method)}
                    ${escapeHTML(path)}
                </p>

                <span>
                    Expected Status:
                    ${escapeHTML(expectedStatus)}
                </span>

                <small>
                    Test Case ID:
                    ${escapeHTML(testCaseId)}
                </small>
            `;

            testCases.appendChild(
                testCase
            );

            generatedCount++;
        }

        if (generatedCount === 0) {

            testCases.className =
                "empty-state";

            testCases.innerHTML = `
                <div class="empty-icon">⚠️</div>
                <h3>No test cases generated</h3>
                <p>
                    Matching APIs were not found
                    for the current upload.
                </p>
            `;
        }

        updateDashboardStats();

    } catch (error) {

        console.error(
            "❌ TEST CASE GENERATION ERROR:",
            error
        );

        testCases.className =
            "empty-state";

        testCases.innerHTML = `
            <div class="empty-icon">❌</div>
            <h3>Failed to generate test cases</h3>
            <p>
                ${escapeHTML(error.message)}
            </p>
        `;
    }
}


// =====================================================
// RUN ALL API TESTS
// =====================================================

async function runTests() {

    const runButton =
        document.querySelector(
            ".success-btn"
        );

    const endpointList =
        document.getElementById(
            "endpointlist"
        );

    const results =
        document.getElementById(
            "testresults"
        );

    if (
        !endpointList ||
        !results
    ) {

        console.error(
            "❌ Test result elements not found"
        );

        return;
    }

    if (!currentTestRunId) {

        alert(
            "⚠️ Please upload an API specification first."
        );

        return;
    }

    const endpoints =
        endpointList.querySelectorAll(
            ".endpoint-card"
        );

    if (endpoints.length === 0) {

        results.className =
            "empty-state";

        results.innerHTML = `
            <div class="empty-icon">📊</div>
            <h3>No tests available</h3>
            <p>
                Upload an API specification first.
            </p>
        `;

        return;
    }

    if (runButton) {

        runButton.disabled =
            true;

        runButton.dataset.originalText =
            runButton.textContent;

        runButton.textContent =
            "⏳ Running...";
    }

    results.className = "";

    results.innerHTML =
        `<div class="loading">
            ⏳ Running API tests...
        </div>`;

    latestTestResults = [];

    const testRunId =
        currentTestRunId;

    console.log(
        "🚀 RUNNING ALL TESTS:",
        testRunId
    );

    try {

        for (
            let i = 0;
            i < endpoints.length;
            i++
        ) {

            const endpointCard =
                endpoints[i];

            const methodElement =
                endpointCard.querySelector(
                    ".endpoint-method"
                );

            const endpointElement =
                endpointCard.querySelector(
                    ".endpoint-path"
                );

            if (
                !methodElement ||
                !endpointElement
            ) {
                continue;
            }

            const method =
                methodElement.textContent
                    .trim()
                    .toUpperCase();

            const endpoint =
                endpointElement.textContent
                    .trim();

            const expectedStatus =
                Number(
                    endpointCard.dataset.expectedStatus ||
                    200
                );

            const url =
                endpointCard.dataset.url ||
                buildAPIUrl(endpoint);

            let testCaseId =
                endpointCard.dataset.testCaseId ||
                null;

            try {

                // =================================================
                // ENSURE TEST CASE EXISTS
                // =================================================

                if (!testCaseId) {

                    const apis =
                        await getCurrentRunAPIs();

                    const matchingAPI =
                        apis.find((api) => {

                            const dbMethod =
                                String(
                                    api.method || ""
                                )
                                    .trim()
                                    .toUpperCase();

                            const dbEndpoint =
                                String(
                                    api.endpoints ||
                                    api.endpoint ||
                                    api.path ||
                                    ""
                                )
                                    .trim();

                            return (
                                dbMethod === method &&
                                dbEndpoint === endpoint
                            );
                        });

                    if (!matchingAPI) {

                        throw new Error(
                            `API not found: ${method} ${endpoint}`
                        );
                    }

                    const testResponse =
                        await fetch(
                            "http://localhost:5000/api/generate-tests",
                            {
                                method: "POST",

                                headers: {
                                    "Content-Type":
                                        "application/json"
                                },

                                body: JSON.stringify({

                                    apiId:
                                        matchingAPI.id,

                                    testName:
                                        `Verify ${method} ${endpoint}`,

                                    expectedStatus:
                                        expectedStatus,

                                    testRunId:
                                        testRunId
                                })
                            }
                        );

                    const testData =
                        await testResponse.json();

                    if (!testResponse.ok) {

                        throw new Error(
                            testData.error ||
                            "Failed to generate test case"
                        );
                    }

                    testCaseId =
                        testData.testCaseId;

                    endpointCard.dataset.testCaseId =
                        testCaseId;
                }

                // =================================================
                // RUN TEST
                // =================================================

                const response =
                    await fetch(
                        "http://localhost:5000/api/run-test",
                        {
                            method: "POST",

                            headers: {
                                "Content-Type":
                                    "application/json"
                            },

                            body: JSON.stringify({

                                method:
                                    method,

                                url:
                                    url,

                                expectedStatus:
                                    expectedStatus,

                                testCaseId:
                                    testCaseId,

                                testRunId:
                                    testRunId
                            })
                        }
                    );

                const data =
                    await response.json();

                console.log(
                    "🧪 TEST RESULT:",
                    {
                        method,
                        endpoint,
                        testCaseId,
                        testRunId,
                        response: data
                    }
                );

                const normalized =
                    normalizeResult(
                        data,
                        {
                            method,
                            endpoint,
                            expectedStatus,
                            testCaseId,
                            url
                        }
                    );

                if (!response.ok) {

                    normalized.result =
                        "FAIL";
                }

                latestTestResults.push(
                    normalized
                );

                createResultCard(
                    method,
                    endpoint,
                    normalized,
                    normalized.finalUrl ||
                        url,
                    testCaseId
                );

            } catch (error) {

                console.error(
                    "❌ TEST ERROR:",
                    method,
                    endpoint,
                    error
                );

                const failedData =
                    normalizeResult(
                        {
                            result: "FAIL",
                            actualStatus:
                                "ERROR",
                            expectedStatus:
                                expectedStatus,
                            responseTime: 0,
                            error:
                                error.message
                        },
                        {
                            method,
                            endpoint,
                            expectedStatus,
                            testCaseId,
                            url
                        }
                    );

                latestTestResults.push(
                    failedData
                );

                createResultCard(
                    method,
                    endpoint,
                    failedData,
                    url,
                    testCaseId
                );
            }
        }

        // =================================================
        // UPDATE UI AFTER ALL TESTS
        // =================================================

        await loadReport();

        await loadTestHistory();

        await updateDashboardStats();

        console.log(
            "✅ ALL TESTS COMPLETED",
            {
                testRunId,
                total:
                    latestTestResults.length
            }
        );

    } catch (error) {

        console.error(
            "❌ RUN ALL TESTS ERROR:",
            error
        );

        results.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">❌</div>
                <h3>Test execution failed</h3>
                <p>
                    ${escapeHTML(error.message)}
                </p>
            </div>
        `;

    } finally {

        if (runButton) {

            runButton.disabled =
                false;

            runButton.textContent =
                runButton.dataset.originalText ||
                "Run Tests";
        }
    }
}


// =====================================================
// NORMALIZE TEST RESULT
// =====================================================

function normalizeResult(
    data,
    fallback
) {

    data = data || {};

    return {

        id:
            data.id ?? null,

        test_case_id:
            data.test_case_id ??
            data.testCaseId ??
            fallback.testCaseId ??
            null,

        test_name:
            data.test_name ??
            data.testName ??
            `Verify ${fallback.method} ${fallback.endpoint}`,

        method:
            data.method ??
            fallback.method,

        endpoint:
            data.endpoint ??
            fallback.endpoint,

        expected_status:
            data.expected_status ??
            data.expectedStatus ??
            fallback.expectedStatus,

        actual_status:
            data.actual_status ??
            data.actualStatus ??
            "ERROR",

        result:
            String(
                data.result ||
                "FAIL"
            ).toUpperCase(),

        response_time:
            data.response_time ??
            data.responseTime ??
            0,

        created_at:
            data.created_at ??
            data.createdAt ??
            null,

        pathParams:
            data.pathParams,

        queryParams:
            data.queryParams,

        requestBody:
            data.requestBody,

        finalUrl:
            data.finalUrl ??
            fallback.url,

        error:
            data.error ??
            null
    };
}


// =====================================================
// CREATE RESULT CARD
// =====================================================

function createResultCard(
    method,
    endpoint,
    data,
    url = "",
    testCaseId = ""
) {

    const results =
        document.getElementById(
            "testresults"
        );

    if (!results) {
        return;
    }

    const result =
        document.createElement(
            "div"
        );

    result.className =
        "test-result";

    const testStatus =
        String(
            data.result ||
            "FAIL"
        ).toUpperCase();

    const actualStatus =
        data.actual_status ??
        data.actualStatus ??
        "ERROR";

    const expectedStatus =
        data.expected_status ??
        data.expectedStatus ??
        200;

    const responseTime =
        data.response_time ??
        data.responseTime ??
        0;
    // =====================================================
// NORMALIZE PARAMETER DATA FOR TEST RESULT
// =====================================================

const pathParams =
    data.pathParams ||
    data.pathParameters ||
    {};

const queryParams =
    data.queryParams ||
    data.queryParameters ||
    {};

   const pathParamsDisplay =
    formatDisplayValue(
        pathParams
    );

const queryParamsDisplay =
    formatDisplayValue(
        queryParams
    );
    const requestBodyDisplay =
        formatDisplayValue(
            data.requestBody
        );

    const finalUrl =
        data.finalUrl ||
        url ||
        "undefined";

    const badgeClass =
        testStatus === "PASS"
            ? "pass"
            : "fail";

    const badgeText =
        testStatus === "PASS"
            ? "✓ PASS"
            : "✕ FAIL";

    result.dataset.result =
        testStatus;

    result.innerHTML = `

        <div class="advanced-test-result">

            <h3>
                🚀 API TEST REQUEST
            </h3>

            <div class="advanced-test-line">
                <strong>Method:</strong>
                <span>
                    ${escapeHTML(method)}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>URL:</strong>
                <span>
                    ${escapeHTML(
                        url ||
                        "undefined"
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Expected:</strong>
                <span>
                    ${escapeHTML(
                        expectedStatus
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Test Case ID:</strong>
                <span>
                    ${escapeHTML(
                        testCaseId ||
                        "undefined"
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Path Params:</strong>
                <span>
                    ${escapeHTML(
                        pathParamsDisplay
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Query Params:</strong>
                <span>
                    ${escapeHTML(
                        queryParamsDisplay
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Request Body:</strong>
                <span>
                    ${escapeHTML(
                        requestBodyDisplay
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Final URL:</strong>
                <span>
                    ${escapeHTML(
                        finalUrl
                    )}
                </span>
            </div>

            <hr>

            <div class="advanced-test-line">
                <strong>Actual:</strong>
                <span>
                    ${escapeHTML(
                        actualStatus
                    )}
                </span>
            </div>

            <div class="advanced-test-line">
                <strong>Response Time:</strong>
                <span>
                    ${escapeHTML(
                        responseTime
                    )} ms
                </span>
            </div>

            <div class="advanced-test-line result-status">
                <strong>Result:</strong>

                <span class="result-badge ${badgeClass}">
                    ${badgeText}
                </span>
            </div>

            ${
                data.error
                    ? `
                    <div class="advanced-test-error">
                        ❌ Error:
                        ${escapeHTML(
                            data.error
                        )}
                    </div>
                    `
                    : ""
            }

        </div>
    `;

    results.appendChild(
        result
    );
}


// =====================================================
// FORMAT DISPLAY VALUE
// =====================================================

function formatDisplayValue(
    value
) {

    if (
        value === undefined ||
        value === null
    ) {

        return "undefined";
    }

    if (
        typeof value ===
        "object"
    ) {

        try {

            return JSON.stringify(
                value
            );

        } catch {

            return String(value);
        }
    }

    return String(value);
}


// =====================================================
// LOAD IMPORTED APIs
// =====================================================
//
// IMPORTANT:
// ONLY APIs belonging to currentTestRunId
// are loaded.
// =====================================================

async function loadImportedAPIs() {

    const apiList =
        document.getElementById(
            "apilist"
        );

    if (!apiList) {

        console.error(
            "❌ apilist element not found"
        );

        return;
    }

    // =================================================
    // NO CURRENT UPLOAD
    // =================================================

    if (!currentTestRunId) {

        apiList.innerHTML = `
            <div class="empty-state">

                <div class="empty-icon">
                    🗄️
                </div>

                <h3>
                    No API uploaded
                </h3>

                <p>
                    Upload an API specification
                    to view imported APIs.
                </p>

            </div>
        `;

        return;
    }

    apiList.innerHTML = `
        <div class="empty-state">

            <div class="loading">
                ⏳ Loading imported APIs...
            </div>

        </div>
    `;

    try {

        // =================================================
        // CURRENT RUN ONLY
        // =================================================

        const apis =
            await getCurrentRunAPIs();

        console.log(
            "📋 CURRENT IMPORTED APIs:",
            {
                testRunId:
                    currentTestRunId,
                count:
                    apis.length,
                apis
            }
        );

        const apiCount =
            document.getElementById(
                "apiCount"
            );

        if (apiCount) {

            apiCount.textContent =
                apis.length;
        }

        // =================================================
        // NO APIs
        // =================================================

        if (apis.length === 0) {

            apiList.innerHTML = `
                <div class="empty-state">

                    <div class="empty-icon">
                        🗄️
                    </div>

                    <h3>
                        No APIs imported
                    </h3>

                    <p>
                        No APIs were found
                        for this upload.
                    </p>

                </div>
            `;

            return;
        }

        // =================================================
        // CREATE TABLE
        // =================================================

        const table =
            document.createElement(
                "table"
            );

        table.className =
            "api-table";

        table.innerHTML = `

            <thead>

                <tr>

                    <th>ID</th>

                    <th>API Name</th>

                    <th>Method</th>

                    <th>Endpoint</th>

                    <th>Created</th>

                    <th>Actions</th>

                </tr>

            </thead>

            <tbody></tbody>
        `;

        const tbody =
            table.querySelector(
                "tbody"
            );

        apis.forEach((api) => {

            const row =
                document.createElement(
                    "tr"
                );

            const method =
                String(
                    api.method || "-"
                ).toUpperCase();

            const endpoint =
                api.endpoints ||
                api.endpoint ||
                api.path ||
                "-";

            const name =
                api.name ||
                "Unnamed API";

            row.dataset.apiName =
                String(
                    name
                ).toLowerCase();

            row.dataset.apiMethod =
                method;

            row.dataset.apiEndpoint =
                String(
                    endpoint
                ).toLowerCase();

            // =================================================
            // METHOD CLASS
            // =================================================

            let methodClass =
                "api-method-other";

            if (method === "GET") {

                methodClass =
                    "api-method-get";

            } else if (
                method === "POST"
            ) {

                methodClass =
                    "api-method-post";

            } else if (
                method === "PUT"
            ) {

                methodClass =
                    "api-method-put";

            } else if (
                method === "PATCH"
            ) {

                methodClass =
                    "api-method-patch";

            } else if (
                method === "DELETE"
            ) {

                methodClass =
                    "api-method-delete";
            }

            // =================================================
            // DATE
            // =================================================

            let formattedDate = "-";

            if (api.created_at) {

                const date =
                    new Date(
                        api.created_at
                    );

                if (
                    !isNaN(
                        date.getTime()
                    )
                ) {

                    formattedDate =
                        date.toLocaleString();
                }
            }

            const id =
                api.id ?? "-";

            // =================================================
            // TABLE ROW
            // =================================================

            row.innerHTML = `

                <td>
                    <span class="api-id">
                        #${escapeHTML(id)}
                    </span>
                </td>

                <td>

                    <div class="api-name">

                        ${escapeHTML(name)}

                        <small>
                            Imported API
                        </small>

                    </div>

                </td>

                <td>

                    <span
                        class="api-method-badge ${methodClass}"
                    >
                        ${escapeHTML(method)}
                    </span>

                </td>

                <td>

                    <span class="api-endpoint">
                        ${escapeHTML(endpoint)}
                    </span>

                </td>

                <td>

                    <span class="api-created">
                        ${escapeHTML(
                            formattedDate
                        )}
                    </span>

                </td>

                <td>

                    <div class="api-actions">

                        <button
                            class="api-action-btn"
                            type="button"
                        >
                            👁️ View
                        </button>

                        <button
                            class="api-action-btn api-test-btn"
                            type="button"
                        >
                            🧪 Test
                        </button>

                    </div>

                </td>
            `;

            const actionButtons =
                row.querySelectorAll(
                    ".api-action-btn"
                );

            // VIEW
            if (actionButtons[0]) {

                actionButtons[0]
                    .addEventListener(
                        "click",
                        () => {

                            viewImportedAPI(
                                id,
                                name,
                                method,
                                endpoint
                            );
                        }
                    );
            }

            // TEST
            if (actionButtons[1]) {

                actionButtons[1]
                    .addEventListener(
                        "click",
                        () => {

                            testImportedAPI(
                                method,
                                endpoint
                            );
                        }
                    );
            }

            tbody.appendChild(
                row
            );
        });

        apiList.innerHTML = "";

        apiList.appendChild(
            table
        );

        filterImportedAPIs();

    } catch (error) {

        console.error(
            "❌ IMPORTED APIs LOAD ERROR:",
            error
        );

        apiList.innerHTML = `
            <div class="empty-state">

                <div class="empty-icon">
                    ⚠️
                </div>

                <h3>
                    Unable to load APIs
                </h3>

                <p>
                    ${escapeHTML(
                        error.message
                    )}
                </p>

            </div>
        `;
    }
}


// =====================================================
// FILTER IMPORTED APIs
// =====================================================

function filterImportedAPIs() {

    const searchInput =
        document.getElementById(
            "apiSearch"
        );

    const methodFilter =
        document.getElementById(
            "apiMethodFilter"
        );

    const table =
        document.querySelector(
            "#apilist .api-table"
        );

    if (!table) {
        return;
    }

    const rows =
        table.querySelectorAll(
            "tbody tr"
        );

    const search =
        String(
            searchInput?.value ||
            ""
        )
            .trim()
            .toLowerCase();

    const selectedMethod =
        String(
            methodFilter?.value ||
            "ALL"
        ).toUpperCase();

    let visibleRows = 0;

    rows.forEach((row) => {

        const name =
            row.dataset.apiName ||
            "";

        const method =
            row.dataset.apiMethod ||
            "";

        const endpoint =
            row.dataset.apiEndpoint ||
            "";

        const matchesSearch =
            !search ||
            name.includes(search) ||
            endpoint.includes(search);

        const matchesMethod =
            selectedMethod === "ALL" ||
            method === selectedMethod;

        if (
            matchesSearch &&
            matchesMethod
        ) {

            row.style.display = "";

            visibleRows++;

        } else {

            row.style.display =
                "none";
        }
    });

    let noResults =
        document.getElementById(
            "apiNoSearchResults"
        );

    if (visibleRows === 0) {

        if (!noResults) {

            noResults =
                document.createElement(
                    "div"
                );

            noResults.id =
                "apiNoSearchResults";

            noResults.className =
                "api-no-results";

            noResults.innerHTML = `
                <div class="empty-icon">
                    🔍
                </div>

                <h3>
                    No APIs found
                </h3>

                <p>
                    Try changing your
                    search or method filter.
                </p>
            `;

            table.parentElement.appendChild(
                noResults
            );
        }

        noResults.style.display =
            "block";

    } else if (noResults) {

        noResults.style.display =
            "none";
    }
}


// =====================================================
// VIEW IMPORTED API
// =====================================================

function viewImportedAPI(
    id,
    name,
    method,
    endpoint
) {

    alert(

        "🗂️ API DETAILS\n\n" +

        "ID: " +
        id +
        "\n\n" +

        "API Name: " +
        name +
        "\n\n" +

        "Method: " +
        method +
        "\n\n" +

        "Endpoint: " +
        endpoint
    );
}


// =====================================================
// TEST IMPORTED API
// =====================================================

function testImportedAPI(
    method,
    endpoint
) {

    const endpointList =
        document.getElementById(
            "endpointlist"
        );

    if (!endpointList) {

        alert(
            "⚠️ Endpoint section not found."
        );

        return;
    }

    const endpointCards =
        endpointList.querySelectorAll(
            ".endpoint-card"
        );

    let found = false;

    endpointCards.forEach(
        (card) => {

            const cardMethod =
                card.querySelector(
                    ".endpoint-method"
                );

            const cardEndpoint =
                card.querySelector(
                    ".endpoint-path"
                );

            if (
                !cardMethod ||
                !cardEndpoint
            ) {

                return;
            }

            const currentMethod =
                cardMethod.textContent
                    .trim()
                    .toUpperCase();

            const currentEndpoint =
                cardEndpoint.textContent
                    .trim();

            if (
                currentMethod === method &&
                currentEndpoint === endpoint
            ) {

                found = true;

                card.scrollIntoView({
                    behavior:
                        "smooth",
                    block:
                        "center"
                });

                card.style.boxShadow =
                    "0 0 0 2px rgba(168, 85, 247, 0.7)";

                setTimeout(
                    () => {

                        card.style.boxShadow =
                            "";

                    },
                    2000
                );

                runIndividualEndpointTest(
                    card
                );
            }
        }
    );

    if (!found) {

        alert(
            "⚠️ This API endpoint is not currently loaded in the detected endpoints section."
        );
    }
}


// =====================================================
// UPDATE DASHBOARD STATISTICS
// =====================================================

async function updateDashboardStats() {

    try {

        const response =
            await fetch(
                "http://localhost:5000/api/dashboard-stats",
                {
                    cache:
                        "no-store"
                }
            );

        const data =
            await response.json();

        if (
            !response.ok ||
            !data.success
        ) {

            return;
        }

        const testCount =
            document.getElementById(
                "testCount"
            );

        if (testCount) {

            testCount.textContent =
                data.totalTestCases ??
                0;
        }

        const passedCount =
            document.getElementById(
                "passedCount"
            );

        if (passedCount) {

            passedCount.textContent =
                data.passedTests ??
                0;
        }

        const failedCount =
            document.getElementById(
                "failedCount"
            );

        if (failedCount) {

            failedCount.textContent =
                data.failedTests ??
                0;
        }

        const averageResponseTimeElement =
            document.getElementById(
                "averageResponseTime"
            );

        if (
            averageResponseTimeElement
        ) {

            averageResponseTimeElement.textContent =
                (
                    data.averageResponseTime ??
                    0
                ) + " ms";
        }

        const endpointList =
            document.getElementById(
                "endpointlist"
            );

        const endpointCount =
            document.getElementById(
                "endpointCount"
            );

        if (
            endpointList &&
            endpointCount
        ) {

            endpointCount.textContent =
                endpointList.querySelectorAll(
                    ".endpoint-card"
                ).length;
        }

    } catch (error) {

        console.error(
            "❌ DASHBOARD STATISTICS ERROR:",
            error
        );
    }
}


// =====================================================
// LOAD REPORT
// =====================================================

async function loadReport() {

    console.log(
        "📊 Loading report...",
        currentTestRunId
            ? `(RUN ${currentTestRunId})`
            : "(NO ACTIVE RUN)"
    );

    const reportEmpty =
        document.getElementById(
            "reportEmpty"
        );

    const reportContent =
        document.getElementById(
            "reportContent"
        );

    const reportTableBody =
        document.getElementById(
            "reportTableBody"
        );

    if (
        !reportEmpty ||
        !reportContent ||
        !reportTableBody
    ) {

        console.error(
            "❌ Report HTML elements not found"
        );

        return;
    }

    // =================================================
    // NO ACTIVE RUN
    // =================================================

    if (!currentTestRunId) {

        reportEmpty.classList.remove(
            "hidden"
        );

        reportContent.classList.add(
            "hidden"
        );

        reportTableBody.innerHTML =
            "";

        latestTestResults = [];

        return;
    }

    try {

        const response =
            await fetch(
                `http://localhost:5000/api/report?testRunId=${encodeURIComponent(
                    currentTestRunId
                )}`,
                {
                    cache:
                        "no-store"
                }
            );

        const data =
            await response.json();

        if (
            !response.ok ||
            !data.success
        ) {

            throw new Error(
                data.error ||
                "Unable to load report"
            );
        }

        const results =
            Array.isArray(
                data.results
            )
                ? data.results
                : [];

        if (
            results.length === 0
        ) {

            reportEmpty.classList.remove(
                "hidden"
            );

            reportContent.classList.add(
                "hidden"
            );

            reportTableBody.innerHTML =
                "";

            latestTestResults = [];

            return;
        }

        // =================================================
        // REPORT STATISTICS
        // =================================================

        const total =
            results.length;

        const passed =
            results.filter(
                (item) =>
                    String(
                        item.result
                    ).toUpperCase() ===
                    "PASS"
            ).length;

        const failed =
            total - passed;

        const rate =
            total === 0
                ? 0
                : Math.round(
                    (passed / total) *
                    100
                );

        const responseTimes =
            results
                .map(
                    (item) =>
                        Number(
                            item.response_time ??
                            item.responseTime ??
                            0
                        )
                )
                .filter(
                    (value) =>
                        !isNaN(value)
                );

        const averageResponseTime =
            responseTimes.length === 0
                ? 0
                : Math.round(
                    responseTimes.reduce(
                        (
                            sum,
                            value
                        ) =>
                            sum + value,
                        0
                    ) /
                    responseTimes.length
                );

        const reportTotal =
            document.getElementById(
                "reportTotal"
            );

        const reportPassed =
            document.getElementById(
                "reportPassed"
            );

        const reportFailed =
            document.getElementById(
                "reportFailed"
            );

        const reportRate =
            document.getElementById(
                "reportRate"
            );

        const reportAverageTime =
            document.getElementById(
                "reportAverageTime"
            );

        if (reportTotal) {

            reportTotal.textContent =
                total;
        }

        if (reportPassed) {

            reportPassed.textContent =
                passed;
        }

        if (reportFailed) {

            reportFailed.textContent =
                failed;
        }

        if (reportRate) {

            reportRate.textContent =
                rate + "%";
        }

        if (reportAverageTime) {

            reportAverageTime.textContent =
                averageResponseTime +
                " ms";
        }

        reportEmpty.classList.add(
            "hidden"
        );

        reportContent.classList.remove(
            "hidden"
        );

        reportTableBody.innerHTML =
            "";

        // =================================================
        // REPORT ROWS
        // =================================================

        results.forEach(
            (item, index) => {

                const row =
                    document.createElement(
                        "tr"
                    );

                const result =
                    String(
                        item.result ||
                        "FAIL"
                    ).toUpperCase();

                const resultClass =
                    result === "PASS"
                        ? "report-pass-badge"
                        : "report-fail-badge";

                const resultText =
                    result === "PASS"
                        ? "✓ PASS"
                        : "✕ FAIL";

                const method =
                    item.method ??
                    "-";

                const endpoint =
                    item.endpoint ??
                    "-";

                const testName =
                    item.test_name ??
                    item.testName ??
                    `Verify ${method} ${endpoint}`;

                const expected =
                    item.expected_status ??
                    item.expectedStatus ??
                    "-";

                const actual =
                    item.actual_status ??
                    item.actualStatus ??
                    "-";

                const responseTime =
                    item.response_time ??
                    item.responseTime ??
                    0;

                const createdAt =
                    item.created_at ??
                    item.createdAt ??
                    null;

                const formattedDate =
                    createdAt
                        ? formatHistoryDate(
                            createdAt
                        )
                        : "-";

                row.innerHTML = `

                    <td>
                        ${index + 1}
                    </td>

                    <td>
                        ${escapeHTML(
                            testName
                        )}
                    </td>

                    <td>
                        <span class="method-badge">
                            ${escapeHTML(
                                method
                            )}
                        </span>
                    </td>

                    <td>
                        ${escapeHTML(
                            endpoint
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            expected
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            actual
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            responseTime
                        )} ms
                    </td>

                    <td>
                        <span
                            class="report-result-badge ${resultClass}"
                        >
                            ${resultText}
                        </span>
                    </td>

                    <td>
                        ${escapeHTML(
                            formattedDate
                        )}
                    </td>
                `;

                reportTableBody.appendChild(
                    row
                );
            }
        );

        latestTestResults =
            results.map(
                (item) =>
                    normalizeResult(
                        item,
                        {
                            method:
                                item.method,

                            endpoint:
                                item.endpoint,

                            expectedStatus:
                                item.expected_status,

                            testCaseId:
                                item.test_case_id,

                            url:
                                ""
                        }
                    )
            );

        console.log(
            "✅ REPORT LOADED",
            {
                testRunId:
                    currentTestRunId,

                total,

                passed,

                failed,

                averageResponseTime
            }
        );

    } catch (error) {

        console.error(
            "❌ LOAD REPORT ERROR:",
            error
        );

        reportEmpty.classList.remove(
            "hidden"
        );

        reportContent.classList.add(
            "hidden"
        );

        reportTableBody.innerHTML =
            "";
    }
}


// =====================================================
// GENERATE CURRENT API REPORT
// =====================================================

async function generateReport() {

    console.log(
        "📊 GENERATING REPORT FOR CURRENT API..."
    );

    if (!currentTestRunId) {

        alert(
            "⚠️ Please upload an API specification first."
        );

        return;
    }

    const button =
        document.getElementById(
            "generateReportBtn"
        );

    if (button) {

        button.disabled =
            true;

        button.dataset.originalText =
            button.textContent;

        button.textContent =
            "⏳ Generating...";
    }

    try {

        await loadReport();

        if (
            latestTestResults.length ===
            0
        ) {

            alert(
                "⚠️ No test results found for the current API."
            );

            return;
        }

        const reportSection =
            document.getElementById(
                "reportContent"
            );

        if (reportSection) {

            reportSection.scrollIntoView({
                behavior:
                    "smooth",
                block:
                    "start"
            });
        }

        console.log(
            "✅ CURRENT API REPORT GENERATED"
        );

    } catch (error) {

        console.error(
            "❌ GENERATE REPORT ERROR:",
            error
        );

        alert(
            "❌ Unable to generate report: " +
            error.message
        );

    } finally {

        if (button) {

            button.disabled =
                false;

            button.textContent =
                button.dataset.originalText ||
                "Generate Report";
        }
    }
}


// =====================================================
// PRINT REPORT
// =====================================================

function printReport() {

    if (
        latestTestResults.length ===
        0
    ) {

        alert(
            "⚠️ No report available."
        );

        return;
    }

    window.print();
}


// =====================================================
// RESET TEST CASES
// =====================================================

function resetTestCases() {

    const testCases =
        document.getElementById(
            "testcases"
        );

    if (!testCases) {
        return;
    }

    testCases.className =
        "empty-state";

    testCases.innerHTML = `
        <div class="empty-icon">
            🧪
        </div>

        <h3>
            No test cases generated
        </h3>

        <p>
            Generate test cases
            from the detected endpoints.
        </p>
    `;
}


// =====================================================
// RESET RESULTS
// =====================================================

function resetResults() {

    const results =
        document.getElementById(
            "testresults"
        );

    if (!results) {
        return;
    }

    results.className =
        "empty-state";

    results.innerHTML = `
        <div class="empty-icon">
            📊
        </div>

        <h3>
            No test results
        </h3>

        <p>
            Execute your generated tests
            to see results.
        </p>
    `;

    latestTestResults = [];
}


// =====================================================
// LOAD TEST HISTORY
// =====================================================

async function loadTestHistory() {

    const history =
        document.getElementById(
            "historyList"
        );

    if (!history) {

        console.error(
            "❌ historyList element not found"
        );

        return;
    }

    history.className =
        "history-container";

    history.innerHTML = `
        <div class="loading">
            ⏳ Loading test history...
        </div>
    `;

    try {

        const response =
            await fetch(
                "http://localhost:5000/api/history",
                {
                    cache:
                        "no-store"
                }
            );

        const data =
            await response.json();

        if (!response.ok) {

            throw new Error(
                data.error ||
                "Unable to load history"
            );
        }

        const historyData =
            data.history ||
            [];

        if (
            historyData.length ===
            0
        ) {

            history.innerHTML = `
                <div class="empty-state">

                    <div class="empty-icon">
                        📜
                    </div>

                    <h3>
                        No test history
                    </h3>

                    <p>
                        Execute API tests
                        to create history.
                    </p>

                </div>
            `;

            return;
        }

        const table =
            document.createElement(
                "table"
            );

        table.className =
            "history-table";

        table.innerHTML = `

            <thead>

                <tr>

                    <th>ID</th>

                    <th>Test Case</th>

                    <th>Method</th>

                    <th>Endpoint</th>

                    <th>Expected</th>

                    <th>Actual</th>

                    <th>Result</th>

                    <th>Response Time</th>

                    <th>Date</th>

                    <th>Action</th>

                </tr>

            </thead>

            <tbody></tbody>
        `;

        const tbody =
            table.querySelector(
                "tbody"
            );

        historyData.forEach(
            (item) => {

                const row =
                    document.createElement(
                        "tr"
                    );

                const result =
                    String(
                        item.result ||
                        "FAIL"
                    ).toUpperCase();

                const resultClass =
                    result === "PASS"
                        ? "history-pass"
                        : "history-fail";

                row.innerHTML = `

                    <td>
                        ${escapeHTML(
                            item.id ??
                            "-"
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            item.test_name ??
                            "-"
                        )}
                    </td>

                    <td>

                        <span class="method-badge">
                            ${escapeHTML(
                                item.method ??
                                "-"
                            )}
                        </span>

                    </td>

                    <td>
                        ${escapeHTML(
                            item.endpoint ??
                            "-"
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            item.expected_status ??
                            "-"
                        )}
                    </td>

                    <td>
                        ${escapeHTML(
                            item.actual_status ??
                            "-"
                        )}
                    </td>

                    <td>

                        <span
                            class="history-result-badge ${resultClass}"
                        >
                            ${
                                result ===
                                "PASS"
                                    ? "✓ PASS"
                                    : "✕ FAIL"
                            }
                        </span>

                    </td>

                    <td>
                        ${escapeHTML(
                            item.response_time ??
                            0
                        )} ms
                    </td>

                    <td>
                        ${escapeHTML(
                            formatHistoryDate(
                                item.created_at
                            )
                        )}
                    </td>

                    <td>

                        <button
                            class="delete-btn"
                            type="button"
                        >
                            🗑️ Delete
                        </button>

                    </td>
                `;

                const deleteButton =
                    row.querySelector(
                        ".delete-btn"
                    );

                if (deleteButton) {

                    deleteButton.addEventListener(
                        "click",
                        () => {

                            deleteHistory(
                                item.id
                            );
                        }
                    );
                }

                tbody.appendChild(
                    row
                );
            }
        );

        history.innerHTML = "";

        history.appendChild(
            table
        );

    } catch (error) {

        console.error(
            "❌ HISTORY LOAD ERROR:",
            error
        );

        history.innerHTML = `
            <div class="empty-state">

                <div class="empty-icon">
                    ⚠️
                </div>

                <h3>
                    Unable to load history
                </h3>

                <p>
                    ${escapeHTML(
                        error.message
                    )}
                </p>

            </div>
        `;
    }
}


// =====================================================
// FORMAT HISTORY DATE
// =====================================================

function formatHistoryDate(
    dateValue
) {

    if (!dateValue) {
        return "-";
    }

    const date =
        new Date(
            dateValue
        );

    if (
        isNaN(
            date.getTime()
        )
    ) {

        return dateValue;
    }

    return date.toLocaleString();
}


// =====================================================
// DELETE SINGLE HISTORY
// =====================================================

async function deleteHistory(
    id
) {

    if (
        !confirm(
            "Are you sure you want to delete this history record?"
        )
    ) {

        return;
    }

    try {

        const response =
            await fetch(
                `http://localhost:5000/api/history/${id}`,
                {
                    method:
                        "DELETE"
                }
            );

        const data =
            await response.json();

        if (!response.ok) {

            throw new Error(
                data.error ||
                "Failed to delete history"
            );
        }

        alert(
            "✅ History deleted successfully"
        );

        await loadTestHistory();

        await updateDashboardStats();

        await loadReport();

    } catch (error) {

        console.error(
            "DELETE HISTORY ERROR:",
            error
        );

        alert(
            "❌ " +
            error.message
        );
    }
}


// =====================================================
// DELETE ALL HISTORY
// =====================================================

async function deleteAllHistory() {

    if (
        !confirm(
            "Are you sure you want to delete ALL test history?"
        )
    ) {

        return;
    }

    try {

        const response =
            await fetch(
                "http://localhost:5000/api/history",
                {
                    method:
                        "DELETE"
                }
            );

        const data =
            await response.json();

        if (!response.ok) {

            throw new Error(
                data.error ||
                "Failed to delete all history"
            );
        }

        alert(
            "✅ All test history deleted successfully"
        );

        await loadTestHistory();

        await updateDashboardStats();

        await loadReport();

    } catch (error) {

        console.error(
            "DELETE ALL HISTORY ERROR:",
            error
        );

        alert(
            "❌ " +
            error.message
        );
    }
}


// =====================================================
// ESCAPE HTML
// =====================================================

function escapeHTML(value) {

    if (
        value === undefined ||
        value === null
    ) {

        return "";
    }

    return String(value)
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );
}