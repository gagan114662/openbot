# Tool coverage

OpenBot owns the capability boundary. A Bot may discover that it needs a catalogue capability and
request it, but absence of a grant remains a refusal until an administrator approves the request in
**Admin → Plugins → Capability requests**. Approval grants the reviewed tools already refreshed for
that catalogue entry; it never installs an arbitrary URL or purchases a service.

| Need | Direct coverage | Credentialed catalogue | Priority / remaining gap |
| --- | --- | --- | --- |
| Public search, pages, feeds, JSON | Open Web (SSRF-pinned, redirect re-check, streaming size cap, credential-in-URL refusal) | — | Covered |
| Repository evidence | Repository Evidence (path containment, secret-file and output caps) | — | Covered |
| Arithmetic and structured conversion | Data Utilities (non-evaluating parser, 100k input cap, bounded output) | — | Covered |
| Time and time zones | Data Utilities | — | Covered |
| Scheduled work | Routines | — | Covered; write tools require an explicit grant |
| Documents and files | — | Google Drive, Notion | Covered after per-person OAuth and admin grant |
| Email and calendar | — | None | Next: vendor-first OAuth connectors; do not emulate by scraping |
| CRM and ticketing | — | Custom reviewed MCP server | Next: add first-party catalogue entries only after integration tests |
| Images, audio, office conversion | — | None | Next: sandboxed local converters with byte, time, and format caps |

Usage is recorded from `agent.tool.observed` events and grouped by tool and Bot in **Admin → Agent
Analytics → Tool and business outcomes**. This is the common meter whether the transport is built-in,
REST, or MCP. Token and cost values remain in the existing analytics budget pipeline.
