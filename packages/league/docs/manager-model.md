# How franchise managers work

A franchise keeps one manager identity and one private memory through the season. Drafting, weekly review, transactions, matchup building, battle piloting, reconciliation, and season review are separate provider calls made for that manager.

<figure class="doc-diagram">
  <img src="assets/manager-cycle.svg" alt="Manager cycle: persistent roster and memory feed the draft call; each week a matchup builder call registers six sets, battle pilot calls choose legal actions, Pokémon Showdown resolves games into series results, and a weekly review call revises memory. After weeks 1, 2, and 3 transaction calls may change rosters and trigger a reconciliation call before the next build. A season review call runs when the franchise's season ends." loading="lazy">
  <figcaption>Blue boxes are provider calls. White boxes are state saved by the harness. Calls communicate only through the state that the harness supplies.</figcaption>
</figure>

## The weekly matchup loop

The **matchup builder** receives the current roster, the opponent's roster,
format rules, the manager's memory, and any authorized earlier results against
this opponent. It returns exactly one legal registered team of six plus a plan.

The **battle pilot** receives the registered team, visible battle state, plan, notebook, and legal action candidates. It returns battle choices and may update only the series notebook. Nothing else it writes survives the series.

Pokémon Showdown resolves every game. Completed series results feed the next **weekly review**, which updates the franchise memory used by later stages.

## Windows and reconciliation

After weeks 1, 2, and 3, the weekly review is followed by a **transaction window**. Managers can make trade offers and free-agent swaps or leave the roster unchanged. A changed roster triggers a **reconciliation** review before the next build, so memory and roster state stay aligned. [Transactions](trade-window.md) specifies the rule and saved evidence.

## Season close

When a franchise's season ends, a **season review** receives its final results, roster, and complete memory. It records one retrospective and takes no further action.

## What the manager is not

`runDraftLeague` remains the software orchestrator: it sequences stages,
passes state, persists completion, and carries user cancellation. There is no
manager registry, no delegate scheduler, no autonomous manager process, and no
agent that schedules other agents. The manager is a role presented to model
calls, not a software subsystem.
