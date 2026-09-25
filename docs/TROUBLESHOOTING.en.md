# Troubleshooting and backups

[한국어](TROUBLESHOOTING.md) | English

Before asking again from the start, first check **where the work stopped**. Progress and candidates are
saved, so in most cases you can continue the same work.

## I can't see the tools

1. Quit the AI tool completely and start it again. Opening a new session also works.
2. Check that the Node.js version is 22.13 or later (22.x), 24.x or 26.x.
3. Ask the AI:

> Check that the path the vibelore MCP server is registered with matches the actual install folder, and tell me the connection status.

If it still doesn't work, see [Connection diagnostics](OPERATIONS.en.md#connection-problems) and ask for help with the error message.
Don't post API keys, full manuscripts or personal paths in public issues.

## Work stopped midway

> Check why the novel work in progress stopped, and continue from where it was saved.

> Check the **webtoon** work in progress. Show me the finished images and the remaining steps, and continue in the same work.

What to do depends on the state the AI reports.

| State | Meaning | What to do |
|---|---|---|
| Waiting for a model answer (`needs_model`) | It's the AI's turn to plan, write or review | "Continue" |
| Waiting for an interview or approval | Your decision is needed | Answer the questions, or look at the result and approve or ask for changes |
| Waiting for image execution | The image model, key or permission needs checking | Check the model to use and its cost, then choose |
| Review failed | The review didn't finish or found a problem | "Show me why it failed and what results remain" |
| Lettering layout failed (`layout_blocked`) | A balloon covers a face or the reading order is tangled | Ask to re-place only the problem part |
| Another run is using it (`PROJECT_BUSY`, `WEBTOON_BUSY`) | Another run is changing the same work | Continue after that run ends. Don't delete the lock file |

If you close the AI tool, the work stops too. It does not keep running in the background.

Before asking for images again, check whether files were already made. The image service may have
finished drawing but stopped before the file was imported. If you don't check, you pay for the same picture twice.

## The checks passed, but the content or picture feels off

Passing the checks does not mean "no problems". If you say where it feels off and what you wanted, the
scope of the fix can be narrowed.

> This line doesn't answer the question before it. Check the source context around it and fix only this exchange.

> In the middle of the fight the enemy suddenly moved to the other side. Check the movement across the following panels and tell me first how much has to be redrawn.

A webtoon's script, composition, drawing and lettering layout are fixed separately. If only a balloon's position is wrong, the picture
doesn't need to be redrawn. See [Fixing a webtoon](WEBTOON.en.md#fix-or-continue).

## I edited the manuscript or settings files by hand

> I edited the manuscript and settings by hand. Check what changed first, and tell me the checks and the steps needed to apply it. Don't write the next chapter yet.

What to do depends on where you edited.

- **The last chapter:** once checked and approved, it is applied right away.
- **An earlier chapter:** the state of the later chapters may need to be recomputed. Later manuscripts are not rewritten automatically.
- **World or character settings:** their effect on future plans is reviewed.

Editing the source while a webtoon is in production does not change the webtoon in progress automatically. If you edited the webtoon script
by hand, say what you changed and ask for a new review. Don't edit the `.vibelore/` folder
by hand.

## I want to roll the novel back to an earlier chapter

> Check whether the novel can be rolled back to chapter 5. First show me the current files that will be archived and what changes after the rollback.

Check the restorable points and their effect before proceeding. Current files are moved to an archive folder, but
don't use this feature instead of backups. Rolling back the novel leaves the webtoon as it is.

## What should I back up?

Stop the AI tool, then copy **the whole work folder, hidden folders included**, somewhere else.

| Folder | Contents |
|---|---|
| `world/`, `characters/`, `chapters/`, `summaries/` | Settings and manuscript |
| `webtoon/` | Approved webtoon scripts, reference art, finished results |
| `.vibelore/` | Candidates in progress, review and approval records, rollback records |

If you copy only the manuscript, work in progress and review records can't be restored. If you back up with Git, check that
hidden folders and images were not left out. Don't put API keys in a public repository.

If you need status codes or manual recovery, see [Operations and recovery details](OPERATIONS.en.md).
