# AGENTS.md

## Scope

These instructions apply to the entire backend repository. If a nested `AGENTS.md` is added later, the nearest file takes precedence for files under that directory.

This file follows the common AGENTS.md convention: give coding agents the project context, commands, style rules, tests, security constraints, and PR checklist that are not always obvious from `README.md`.

## Project overview

This repository is the authoritative Colyseus backend for CongCard, a real-time multiplayer UNO-like card game.

- Runtime: Node.js 24+ with ESM TypeScript.
- Realtime transport: Colyseus rooms over WebSocket.
- HTTP endpoints: health check and private room lookup/creation.
- Validation: zod schemas from `@congcard/shared`.
- Game rule source of truth: server only. Clients may display hints, but the backend must validate and apply every action.

## Repository map

- `src/index.ts` — Express/Colyseus server bootstrap and HTTP endpoints.
- `src/config.ts` — environment parsing and defaults.
- `src/rooms/GameRoom.ts` — Colyseus room lifecycle, message handlers, broadcast snapshots.
- `src/rooms/directory.ts` — room code registration/lookup.
- `src/engine/game.ts` — mutable game state, action validation, turn flow, scoring, snapshots.
- `src/engine/modes/standard.ts` — standard-mode deck, shuffle, playability, scoring.
- `shared/src/index.ts` — shared protocol types and zod schemas used by the backend package.
- `test/*.test.ts` — Vitest coverage for rules and room lifecycle.

## Setup and commands

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm test
npm run build
```

Targeted tests:

```bash
npx vitest run test/rules.test.ts
npx vitest run test/room-lifecycle.test.ts
npx vitest run -t "One/Catch"
```

The default local backend URL is `http://localhost:2567`. Use `.env.example` as the reference for environment variables.

## Backend invariants

- The server is authoritative. Never trust client state, client timestamps, card counts, turn ownership, deck order, or action legality.
- Never leak secret state. Other players must only receive public data; `snapshotFor` may include `self.hand` only for that player.
- Parse every client payload with the shared zod schemas before mutating state.
- Use stable `GameError` codes for expected user/action failures so the frontend can translate them.
- Use server `Date.now()` for turn deadlines, challenge deadlines, and One/Catch windows. Do not add client-provided timestamps to game logic.
- Keep room transport thin. Prefer implementing rules in `src/engine/game.ts` or a mode file, then call those functions from `GameRoom`.
- Keep game mutations internally consistent: hand length, `cardCount`, `drawnCardId`, `oneWindow`, `pendingChallenge`, and `turnDeadline` must not drift.
- Preserve empty-deck and discard reshuffle behavior; penalty draws should degrade gracefully instead of crashing mid-mutation.
- When changing protocol types, message payloads, error codes, or snapshots, update the frontend companion repo as well. In this workspace it is usually at `../FE`; its matching shared package is `../FE/shared/src/index.ts`.

## TypeScript and code style

- TypeScript is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; avoid assigning `undefined` to optional properties. Prefer conditional spreads or `delete`.
- Local ESM imports should include `.js` extensions in TypeScript source, matching the existing files.
- Avoid `any`. If a type is uncertain, narrow it with zod, discriminated unions, or explicit guards.
- Keep functions small and rule-focused. Add comments only for non-obvious game-rule or synchronization decisions.
- Do not edit generated or dependency folders such as `node_modules/`.

## Testing expectations

- Add or update tests for every gameplay rule, timer, room lifecycle, sync, or scoring change.
- Prefer deterministic test setup with controlled hands, draw piles, discard piles, seats, and deadlines.
- Before handing off a backend change, run at least:

```bash
npm run typecheck
npm test
```

Run `npm run build` too when the change touches TypeScript configuration, package metadata, or deployment behavior.

## Security and operations

- Do not commit secrets. Update `.env.example` when environment shape changes.
- Keep CORS and room limits configurable through `src/config.ts`.
- Do not log private hands, deck order, reconnect tokens, or other sensitive runtime data.
- Do not move validation or anti-cheat logic to the client.

## PR checklist

- Summarize the behavioral change and affected files.
- List validation commands and their results.
- Mention any required frontend companion change.
- Check that the branch is up to date with `origin/main` and is mergeable before opening or updating a PR.
