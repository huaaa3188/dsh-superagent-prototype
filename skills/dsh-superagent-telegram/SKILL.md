---
name: dsh-superagent-telegram
description: Read Telegram messages and threads, render inline action keyboards, and execute personal assistant workflows (gcal-cli, mail-cli, tavily-cli) under the L1/L2/L3 permission protocol.
---

A worker's messages carry each Telegram Trigger (`source: 'telegram'`); read `trigger/<id>` with `orchestrator_read` when one is cut or you need its context. Its context reference `telegram/<trigger-id>/thread` reads the conversation history in that Telegram thread (`{ messages, next_resource }`). Each message has `{ id, from, at, text, bot?, reply_to? }`.

## Inline Action Buttons (Telegram InlineKeyboardMarkup)

When sending a reply (`orchestrator_reply`) that asks the human for a decision (`purpose: 'attention'`) or delivers a morning briefing / draft with quick actions (`purpose: 'result'`), you may append an HTML comment at the very end of `text` to render Telegram inline buttons:

`<!-- buttons: [{"label":"✓ 确认执行","data":"approve:<action>"},{"label":"✕ 取消","data":"cancel:<action>"}] -->`

`tg-cli` automatically strips the `<!-- buttons: [...] -->` comment from the visible message text and attaches a Telegram `InlineKeyboardMarkup` row. When the human clicks a button in Telegram, `tg-cli` answers the callback query and emits a new Trigger in the **same Thread** with `text` equal to the button's `data` string (for example `approve:send_draft_1`), which wakes the subscribed Ticket's worker directly via Subscription Fan-out.

## Personal Assistant CLI Tools & L1/L2/L3 Permission Tiers

Workers have access to three controlled personal assistant CLIs on `PATH`:

1. **`gcal-cli` (Calendar & GTD)**
   - **L1 (Read-only)**: `gcal-cli list [--date YYYY-MM-DD]`, `gcal-cli conflicts [--date YYYY-MM-DD]`, `gcal-cli gtd-list [--status todo|done|all]`
   - **L2 (Reversible Drafts & GTD)**: `gcal-cli draft-add --title <text> --start <HH:MM> --end <HH:MM> [--date YYYY-MM-DD]`, `gcal-cli gtd-add --title <text> [--priority high|medium|low]`, `gcal-cli gtd-done --id <todoId>`
   - **L3 (Requires Human Approval)**: `gcal-cli commit-draft --draft-id <id> --approved-by <triggerIdOrCallback>`, `gcal-cli reschedule --event-id <id> --start <HH:MM> --end <HH:MM> --approved-by <triggerIdOrCallback>`, `gcal-cli delete --event-id <id> --approved-by <triggerIdOrCallback>`

2. **`mail-cli` (Email & Inbox)**
   - **L1 (Read-only)**: `mail-cli unread`, `mail-cli read --id <msgId>`, `mail-cli search --query <keyword>`
   - **L2 (Reversible Draft)**: `mail-cli draft --to <email> --subject <text> --body <text> [--reply-to <msgId>]`, `mail-cli drafts`
   - **L3 (Requires Human Approval)**: `mail-cli send --draft-id <id> --approved-by <triggerIdOrCallback>`, `mail-cli delete --id <msgId> --approved-by <triggerIdOrCallback>`

3. **`tavily-cli` (Web Research)**
   - **L1 (Read-only)**: `tavily-cli search --query <text> [--max-results <n>]`

4. **`aura-kb` (L3 Cold Archive Knowledge Base)**
   - **L1 (Read-only)**: `aura-kb list [--category reports|notes|decisions]`, `aura-kb search --query <keyword>`, `aura-kb read --path <relative-path>`
   - **L2 (Reversible Archive Write)**: `aura-kb save --category <reports|notes|decisions> --slug <slug> --title <title> [--summary <text>] [--tags <csv>] [--content <md> | --file <path>]`

## Proactive Morning Briefing (`[CRON:morning-briefing]`)

When a ticket is triggered by `cron-bot` with `[CRON:morning-briefing]`, the worker aggregates `gcal-cli list --today`, `gcal-cli conflicts`, `gcal-cli gtd-list`, and `mail-cli unread`, and reports `state: 'ready'` with a concise summary containing:
1. Today's timeline and any conflict warning;
2. Top 3 leverage GTD items;
3. High-priority unread email radar;
4. Quick-action inline buttons: `<!-- buttons: [{"label":"✓ 确认行程","data":"confirm_schedule"},{"label":"📝 补充待办","data":"add_todo"},{"label":"🔕 今日免打扰","data":"dnd_today"}] -->`.

Never fabricate `--approved-by` on an L3 command. When a task requires an L3 action (`mail-cli send`, `gcal-cli reschedule`, `gcal-cli delete`, `gcal-cli commit-draft`), first create the L2 draft (if applicable), then call `orchestrator_report(state: 'progress', summary: '...', human_action: '...')` so the main Session sends an `attention` card with inline buttons to the human on Telegram. Only pass `--approved-by` after the human's confirmation Trigger arrives in the ticket's thread.
