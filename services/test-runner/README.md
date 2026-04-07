# HomeOps Test Runner

This is a local service that can start Vitest/Playwright runs, persist run history to SQLite, and execute cron schedules.

## Setup

Install dependencies:

- `npm run test-runner:install`

## Run

Start the server:

- `npm run test-runner:dev`

Environment variables:

- `TEST_RUNNER_PORT` (default: `4010`)
- `TEST_RUNNER_DATA_DIR` (default: `~/.homeops-test-runner`)

The React UI can be pointed at a different runner URL via:

- `VITE_TEST_RUNNER_URL` (default: `http://localhost:4010`)

## API

- `GET /health`
- `GET /runs`
- `POST /runs` body: `{ type: "vitest"|"playwright", mode: "run"|"ui"|"watch" }`
- `GET /runs/:id/log`
- `POST /runs/:id/cancel`
- `GET /schedules`
- `POST /schedules`
- `PUT /schedules/:id`
- `DELETE /schedules/:id`
