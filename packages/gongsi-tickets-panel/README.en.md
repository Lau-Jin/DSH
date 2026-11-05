# GDCJ · Private Gongsi Tickets Panel

#### Description

A DeepSeek Harness (DSH) plugin: browse and act on the tickets of the gongsi (company work-order) MCP service straight from the DSH left sidebar.

- Two tabs, **all tickets** and **my tickets**; filter by keyword, status, issue type (server-side) and priority, school, creator (client-side), with paging
- Per row: **comment** (paste a screenshot straight in — the image is uploaded as an attachment), **book time**, **assign** (one box: type a name to search, pick to choose the owner — the title, the box and the buttons share one line); on tickets you own, **start** and **complete** — completing asks for the **conclusion** and, optionally, a **root-cause analysis**, which is written as its own entry, apart from the conclusion
- Click a row for the **detail**: description, conclusion, worklog summary, attachments, activity log (screenshots in the description and the log open in the panel)
- One **quote** per row: opens a fresh conversation with the ticket carried over
- **Create ticket** (with image paste) and a **settings** tab (endpoint, API key, page size)
- A **share** button at the end of every row: copies the console deep link of the ticket (`?tab=ticket-detail&ticketId=…`) to the clipboard
- A ticket nobody owns yet carries a **red** "unassigned" badge next to its status badge

The plugin also gives the Agent four tools (`gongsi_tickets`, `gongsi_ticket_action`, `gongsi_create_ticket`, `gongsi_tickets_meta`) and two bundled skills: `/gongsi-ticket` (three-stage triage) and `/gongsi-ticket-kb` (ticket + knowledge base).

#### Software Architecture

| Path | Role |
|---|---|
| `index.js` | Host half: MCP client, commands, Agent tools, settings, skill registration |
| `client.js` | Client half: sidebar glyph, panel body, tabs, filters, paging, inline forms, image viewer |
| `cordis.patch.yml` | bundle patch that adds the plugin row to the profile |
| `package.json` | package metadata plus the `dsh.bundle` / `dsh.client` declarations |
| `locale/` | plugin metadata (title, description) |
| `skills/gongsi-ticket-kb/` | the bundled knowledge-base skill (SKILL.md + references/ + scripts/) |

How a call travels:

```
Client half (client.js)  ──commands Remote (agent scoped)──▶  Host half (index.js)  ──gongsi MCP──▶  tickets
```

The ticket query borrows the Agent of some session (the command Remote is agent scoped), so the API key never leaves the Host half.

#### Installation

**Option 1: install the tarball (recommended)**

1. Download `local-gongsi-tickets-panel-1.0.7.tgz` from the `packages/` directory of this repository
2. Ask the Agent in DSH to run:

   ```
   plugin_manager install_bundle target="<absolute path of the tgz>"
   ```

3. Restart DSH (or let the Agent reload); a ticket glyph appears in the left sidebar
4. Open the panel → **Settings** tab, fill in the API key (the endpoint already points at the company server)

> **How the dependencies arrive (changed in 1.0.6):** the tarball ships **no `node_modules`** any more.
> pnpm resolves them from `package.json`: `@deepseek-ai/schemastery@3.18.5`, `@deepseek-ai/cosmokit@1.8.6`,
> `@standard-schema/spec@1.1.0` — the very versions DSH's own plugins use, so the machine usually has them
> already and the install downloads nothing.
>
> Why the change: bundling the dependencies put a **real directory** at `node_modules/@deepseek-ai/schemastery`
> inside the tarball, while pnpm puts a **symlink** at that same path — and pnpm refuses to overwrite one
> with the other: `ERR_PNPM_LINKING_FAILED Cannot overwrite directory '...' with non-directory '...'`.
> It happened on every install over an existing one. With no `node_modules` in the package, the clash is gone.

**Option 2: install from the source directory**

1. Clone this repository (or copy the whole directory to the other machine — **including `node_modules`**, that is the fully offline way)
2. Ask the Agent in DSH to run:

   ```
   plugin_manager install_bundle target="link:<absolute path of the directory>"
   ```

#### Instructions

1. Click the ticket glyph in the left sidebar; the panel opens on **all tickets**
2. Narrow the list with the filter bar — the title, tabs and filters stay put, only the list scrolls
3. Click a row for the detail; use **comment** at the end of the row to write a note (Ctrl+V pastes a screenshot)
4. **Share** at the end of the row copies the link of that ticket in the console — send it to a colleague (they still need their own account and permissions)
5. **Quote** opens a fresh conversation with the ticket in it

> When the current session is archived, the panel falls back to the newest usable session; with every session archived it asks for a new one.

#### Versions

| Version | Change |
|---|---|
| 1.0.7 | **Complete** takes a **root-cause analysis** besides the conclusion: it is written as its own `root_cause` entry (before the ticket is closed — if it cannot be written, the ticket stays open), so the analysis is kept apart from the conclusion. The Agent tool `gongsi_ticket_action` gains a matching `rootCause` argument |
| 1.0.6 | The package no longer bundles `node_modules`; pnpm resolves the dependencies. Fixes `ERR_PNPM_LINKING_FAILED` when installing over an existing copy. Adds the install-matrix self-check `test/install-matrix.test.mjs` |
| 1.0.5 | A ticket nobody owns carries a **red** "unassigned" badge next to its status badge (list row and detail header) |
| 1.0.4 | **Assign**: the title, the box and the buttons now share one line |
| 1.0.3 | **Assign** is one box: type a name to search, pick to choose the owner; the list opens upward when the box sits near the bottom edge; the directory is asked once the typing pauses |
| 1.0.2 | Added **share**: copies the console deep link of the ticket |
| 1.0.1 | Panel layout: title, tabs and filters stay at the top, only the list scrolls |
| 1.0.0 | First release |

#### Contribution

1.  Fork the repository
2.  Create Feat_xxx branch
3.  Commit your code
4.  Create Pull Request


#### Gitee Feature

1.  You can use Readme\_XXX.md to support different languages, such as Readme\_en.md, Readme\_zh.md
2.  Gitee blog [blog.gitee.com](https://blog.gitee.com)
3.  Explore open source project [https://gitee.com/explore](https://gitee.com/explore)
4.  The most valuable open source project [GVP](https://gitee.com/gvp)
5.  The manual of Gitee [https://gitee.com/help](https://gitee.com/help)
6.  The most popular members  [https://gitee.com/gitee-stars/](https://gitee.com/gitee-stars/)
