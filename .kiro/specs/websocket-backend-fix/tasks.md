# Implementation Plan: WebSocket Backend Fix

## Overview

The WebSocket server implementation is complete. The issue is that the backend services need to be started properly. This task list focuses on verification and ensuring the startup scripts work correctly.

## Tasks

- [x] 1. Verify WebSocket Server Startup
  - [x] 1.1 Start the backend using `node server.js`
    - Run `node server.js` to start unified backend with WebSocket
    - Verify console shows "WebSocket server started successfully"
    - Verify console shows "WebSocket log streaming available at ws://localhost:3002/ws/logs"
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Verify WebSocket connectivity
    - Test WebSocket connection to `ws://localhost:3002/ws/logs`
    - Verify welcome message is received
    - _Requirements: 1.1_

- [x] 2. Verify Health Endpoint Reporting
  - [x] 2.1 Test health endpoint WebSocket status
    - Call `/api/recovery/status` endpoint
    - Verify response includes `services.websocket` with `status` and `port`
    - _Requirements: 3.1, 3.2_

- [x] 2.2 Write property test for health endpoint WebSocket status
  - **Property 1: Health Endpoint WebSocket Status Inclusion**
  - **Validates: Requirements 3.1**

- [x] 3. Verify Ops UI Connection
  - [x] 3.1 Test Ops UI WebSocket connection
    - Open http://localhost:3000/ops in browser
    - Verify "Connected" status appears (green indicator)
    - Verify logs start flowing in real-time
    - _Requirements: 4.2_

- [x] 4. Checkpoint - Ensure WebSocket connectivity works end-to-end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster verification
- The WebSocket server code is already complete in `websocket-server.js`
- The integration is already complete in `monitoring-api-extension.js`
- The startup script `server.js` already starts the WebSocket server
- The main action needed is to **run `node server.js`** to start the backend
