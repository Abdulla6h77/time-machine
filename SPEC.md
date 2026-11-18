# Time Machine specification

Source: `D:\tinyfish-details.md`, bounty 6 and its rulebook.

Version-history API or agentic app for querying how a monitored page read and looked on a date.

## TinyFish products

**Required: TinyFish Monitor** for core change detection. Fetch is optional and must be explained if used. Screenshot mechanism is unspecified.

## Official submission requirements

- **S1** Uses TinyFish Monitor to track at least 20 real pages that change
- **S2** Answers "what did this page say on date X" and shows a structured diff between any two dates
- **S3** Takes a screenshot of the page every time a change is detected and stores it, so every version can be seen as it looked
- **S4** Shows a version timeline for each page, with every version's screenshot and source link
- **S5** Runs live for at least 3 days before you submit, with logs of the real changes it caught
- **S6** Short explanation of how TinyFish Monitor (and Fetch, if used) is used

## Official approval criteria

- **A1** Monitor does the core work: remove it and the build stops working
- **A2** Diffs are structured (what was added, removed or changed), not a raw text dump
- **A3** Works for any page you add, not a hardcoded few
- **A4** Real changes were caught live, not simulated, with a stored screenshot for each one
- **A5** Output is reusable by other tools (an API or JSON export)

## Official judging priorities

- **J1** Monitor depth: how many pages it tracks, how often, and how cleanly each change is captured
- **J2** Diff quality: real changes stand out, noise like dates, ads and tracking codes is ignored
- **J3** History you can query and see: the as-of lookup and timeline give the right version, with a stored screenshot for every change
- **J4** Value: pages someone genuinely needs a history of
- **J5** Reusability: a clean API or export another tool can build on

## Demo and acceptance tests

Monitor at least 20 real pages, run live for at least three days before submission, and provide logs of actual captured changes. Show an as-of lookup, a structured diff, and a timeline with screenshots and source links.

- **A1** Connect version capture to Monitor changes and verify that disabling Monitor stops automatic version capture. Register 20+ live pages and store initial captures for timeline queries.
- **A2** Return added, removed, and changed content for any two captured date selections. Test unchanged versions, meaningful edits, and cosmetic noise such as ads or tracking codes.
- **A3** Support registering an eligible page dynamically. Test a newly added URL and its timeline without a code change.
- **A4** Persist a screenshot and source link per detected version. Run live for at least three days and inspect logs for real changes and matching screenshots. Test duplicate events, capture failures, and out-of-order arrivals separately.
- **A5** Expose a reusable API or JSON export. Test as-of lookup before the first capture, between versions, and on a version boundary, plus valid chronological timeline and diff output.

## Edge cases and security

Validate URLs and redirects to block access to private networks, restrict capture to authorized pages, and avoid storing sensitive screenshots. Surface a failed or delayed capture without representing it as the original visual state.

Keep credentials, access tokens, and other people's personal data out of the build and demo. Use sanitized fixtures for failure tests and label fixture evidence separately from live evidence.

## Rulebook and submission deadline

- Deadline: Tuesday, November 17, 2026 at 11:59 PM Pacific (Wednesday, November 18 at 12:59 PM Pakistan time).
- Enter through the TinyFish Students or Ambassadors program. One person per build and one entry per person per bounty. Claims do not reserve a bounty, and submissions are final.
- Provide a working build link (repo, live demo, or cookbook PR) with notes on what it does and how TinyFish is used. Post about the build on LinkedIn and tag TinyFish. Share it in Discord #showcase. X is optional.
- Pass every approval criterion. Use original work built for the bounty and demonstrate meaningful live TinyFish work end to end across varied inputs. Keep the submitted evidence authentic.
- The general endpoint rubric awards 50/100/150/200 points for 1/2/3/4+ meaningful endpoints (Search, Fetch, Agent, Browser, Monitor). Each endpoint must contribute to the workflow.

## Open questions and dependencies

Start live monitoring before Sat Nov 14 at 11:59 PM Pacific (Sun Nov 15 at 12:59 PM Pakistan time) to leave a full three-day window and ideally time for evidence review. The brief does not specify screenshot tooling, date timezone, or cadence. As-of answers can only use observed history.
