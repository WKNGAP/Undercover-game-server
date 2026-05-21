# Vote And Endgame Test Procedure

Use this procedure after starting the server with `npm start`. Open the host page at `http://localhost:3000` and use `http://localhost:3000/test-console.html` for simulated players.

## Automated Baseline

Run these before manual testing:

```powershell
npm run build:web
npm run test:console
npm run test:connectivity
```

Expected result: build succeeds, console smoke passes, connectivity suite passes with all vote/endgame scenarios.

## Manual Setup

1. Create a room.
2. Set lobby roles to 1 Spy and 1 Blank.
3. Join 5 players from the test console.
4. Click Start Game from the host page.

## Vote Completion

1. Start voting from the host page.
2. Vote the same target with 3 of 5 players.
3. Confirm voting ends immediately before the remaining 2 players vote.
4. Start another game/vote where 2 votes go to one target and remaining votes could still change the result.
5. Confirm voting stays open until the result becomes locked or all alive players vote.
6. In a 4-player game, split votes 2-2.
7. Confirm the vote resolves as tie and the game returns to `GAMING`.

## Kick Behavior

1. In lobby, kick a joined player from the host roster.
2. Confirm the player receives a kicked message and disappears from the host roster.
3. Rejoin that player from the test console.
4. Confirm the player receives a new player ID.
5. In game, kick a Civilian.
6. Confirm the player is marked out and endgame checks run.
7. In a separate run, kick the Spy.
8. Confirm Civilian win triggers when no Spy remains and no Blank remains.
9. In a separate run, kick the Blank.
10. Confirm Blank guess starts for the kicked Blank.

## Invalid Vote Inputs

1. During voting, send a vote to a missing player ID from the test console or automated harness.
2. Confirm no vote count changes.
3. Send two votes from the same voter.
4. Confirm only the first vote is counted.

## Acceptance Criteria

- Host can kick players from lobby and in-game.
- Kicked lobby players can only return as new players.
- Early vote completion happens only when one leader cannot be caught.
- Ties still require all votes and return to the game.
- Blank, Spy, and Civilian eliminations still produce the correct blank-guess or win outcome.
