# Deadlock Feud

A Family Feud-style game show for Deadlock. One person hosts on a big screen; everyone else joins on their phone with a 4-letter room code and buzzes in. Static site, no server of your own.

## Put it online with GitHub Pages (free)

1. Create a new **public** repository on GitHub (e.g. `deadlockfeud`).
2. Upload these four files to the root: `index.html`, `style.css`, `game.js`, `questions.js`.
3. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. After a minute your site is live at `https://<your-username>.github.io/deadlockfeud/`.

## Running a game

1. Open the site on the screen everyone can see and click **Host a game**.
2. Click **Copy invite link** and send it around (or read out the 4-letter code). Players type a name and join. Teams are auto-balanced; click a player's chip to swap them.
3. **Start game**, then for each round:
   - **Open buzzers (B)**. First buzz locks and shows on every screen.
   - Pick which team is **in control**.
   - Click an answer (or press **1–8**) to reveal it. Wrong answer: **X**. Three strikes opens a **steal** for the other team.
   - **Award bank** to the winning team (rounds 4–6 score ×2, 7+ ×3).
4. **H** toggles Presentation mode (hides the host controls so you can project the board). Players can also type answers, which show up in the feed for the host.

## Editing questions

Open `questions.js`. Each entry is a question plus `[answer, points]` pairs (max 8). The points shipped here are estimates. For the real Family Feud feel, ask 30–50 people and use their actual answers.

## Good to know

- The host's browser is the game server: if the host closes or refreshes the tab, the game ends.
- Messages go through free public relays (shiftr.io on the normal HTTPS port, plus HiveMQ and EMQX). Everyone connects to every relay they can reach, so a firewall blocking one or two is fine. Anyone who guesses a room code could listen in on the public board, so don't put anything private in questions or team names.
- Unrevealed answers are never sent to players, so nobody can peek.
