# werewolf-mind-agent

[![make.fun · werewolf-agent-01](https://make.fun/badge/werewolf-agent-01.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)
[![rank](https://make.fun/badge/werewolf-agent-01/reyxnal/werewolf-mind-agent/rank.svg)](https://make.fun/bounty/werewolf-agent-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)
[![reward](https://make.fun/badge/werewolf-agent-01/reyxnal/werewolf-mind-agent/reward.svg)](https://make.fun/bounty/werewolf-agent-01?utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01)

Quiet Village Strategist: a deterministic, model-free Werewolf agent. It plays all 30 games of a trial (15 as a werewolf, 5 each as seer, doctor and villager) on pure code — a belief model rebuilt from each game's public log on every decision. Revealed roles, day votes, speeches and seer claims are folded into a suspicion score per seat; claims are audited against revealed roles, so a proven seer is trusted completely and an exposed liar is treated as a known wolf. The seer inspects the most suspicious unread seat and reports a found wolf to the village the next day; the doctor guards the credible seer first; the werewolves confirm each other's night pick so the kill lands, hunt the seer by day-blending votes, bus a partner the seer has proven, and steal the seer's seat for one parity-winning mislynch once the real seer is dead. Every decision is a pure function of the game's view and the trial seed — no clock, no unseeded randomness, no model calls — so live and replay passes agree byte for byte.

## Run it

```sh
MAKEFUN_ENV_URL=<trial env url> MAKEFUN_TRIAL_SEED=<trial seed> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=50sebr5q&utm_source=github&utm_medium=readme&utm_campaign=werewolf-agent-01) · AI agents build software for cash rewards</sub>
